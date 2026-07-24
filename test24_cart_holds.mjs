// Coverage for ephemeral cart holds (cart-holds.mjs + lib/holds.mjs): an
// unsubmitted shopper/DRI cart now reserves stock, snapshot-replace syncs
// remove/update a cart's hold in one call, and a session's own reservation
// never blocks that same session's checkout/request of the very units it
// already has.
process.env.ADMIN_PASSCODE = "masterpass123";

const base = "http://local";
let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error("FAIL:", msg); }
  else console.log("ok  :", msg);
}

async function call(mod, method, path, { headers = {}, body } = {}) {
  const req = new Request(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const res = await mod.default(req);
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

const labsMod = await import("./functions/labs.mjs");
const adminAuthMod = await import("./functions/admin-auth.mjs");
const adminsMod = await import("./functions/admins.mjs");
const inventoryMod = await import("./functions/inventory.mjs");
const checkoutsMod = await import("./functions/checkouts.mjs");
const sourceRequestsMod = await import("./functions/source-requests.mjs");
const cartHoldsMod = await import("./functions/cart-holds.mjs");

let r = await call(adminAuthMod, "POST", "/admin-auth", { body: { action: "bootstrap", masterPasscode: "masterpass123", username: "root", password: "supersecret" } });
const rootToken = r.data.token;

r = await call(adminsMod, "POST", "/admins", { headers: { "x-admin-token": rootToken }, body: { username: "lab1admin", password: "lab1adminpw", role: "labadmin", labs: ["groomlake"] } });
r = await call(adminAuthMod, "POST", "/admin-auth", { body: { action: "login", username: "lab1admin", password: "lab1adminpw" } });
const lab1Token = r.data.token;

r = await call(adminsMod, "POST", "/admins", { headers: { "x-admin-token": rootToken }, body: { username: "driB", password: "driBpassword", role: "client", clientOrg: "B" } });
r = await call(adminAuthMod, "POST", "/admin-auth", { body: { action: "login", username: "driB", password: "driBpassword" } });
const driBToken = r.data.token;

r = await call(inventoryMod, "POST", "/inventory?lab=groomlake", { headers: { "x-admin-token": lab1Token }, body: { name: "Multimeter", qty: 5, category: "Tools" } });
const multimeter = r.data.find((i) => i.name === "Multimeter");

r = await call(labsMod, "GET", "/labs", { headers: { "x-admin-token": rootToken } });
const groomlakeToken = r.data.find((l) => l.id === "groomlake").accessToken;

// --- shopper A puts 3 in their cart (not checked out) ---
r = await call(cartHoldsMod, "POST", "/cart-holds?lab=" + encodeURIComponent(groomlakeToken), {
  body: { sessionId: "shopperA", items: [{ itemId: multimeter.id, qty: 3 }] },
});
assert(r.status === 200, "shopperA's cart-hold sync succeeds");

// --- shopper B (a totally different browser/session) sees reduced availability before ANY checkout happened ---
r = await call(inventoryMod, "GET", "/inventory?lab=" + encodeURIComponent(groomlakeToken));
let item = r.data.find((i) => i.id === multimeter.id);
assert(item.available === 2, "shopperB's view already excludes shopperA's un-submitted cart (5 - 3 = 2)");

// --- shopper B tries to check out more than what's left after shopperA's cart hold ---
r = await call(checkoutsMod, "POST", "/checkouts?lab=" + encodeURIComponent(groomlakeToken), {
  body: { name: "Shopper B", email: "b@example.com", items: [{ itemId: multimeter.id, name: "Multimeter", qty: 3 }], sessionId: "shopperB" },
});
assert(r.status === 409, "shopperB can't check out 3 - only 2 are left once shopperA's cart hold is counted");

// --- shopperA's own checkout of exactly what's in their own cart hold is NOT blocked by their own reservation ---
r = await call(checkoutsMod, "POST", "/checkouts?lab=" + encodeURIComponent(groomlakeToken), {
  body: { name: "Shopper A", email: "a@example.com", items: [{ itemId: multimeter.id, name: "Multimeter", qty: 3 }], sessionId: "shopperA" },
});
assert(r.status === 201, "shopperA can check out the exact 3 units their own cart already held - self-exclusion works");

// --- the checkout clears shopperA's cart hold automatically (it's a real checkout now, not just a reservation) ---
r = await call(inventoryMod, "GET", "/inventory?lab=" + encodeURIComponent(groomlakeToken));
item = r.data.find((i) => i.id === multimeter.id);
assert(item.available === 2, "after the checkout, available reflects 2 left on hand and the stale cart-hold is gone (not double-subtracted)");

// --- a DRI's cart hold on a second item blocks a different DRI too, but not itself ---
r = await call(inventoryMod, "POST", "/inventory?lab=groomlake", { headers: { "x-admin-token": lab1Token }, body: { name: "Cable Tester", qty: 2, category: "Tools" } });
const cableTester = r.data.find((i) => i.name === "Cable Tester");

r = await call(cartHoldsMod, "POST", "/cart-holds", {
  headers: { "x-admin-token": driBToken },
  body: { sessionId: "driB-session", items: [{ itemId: cableTester.id, qty: 2 }] },
});
assert(r.status === 200, "driB's cart-hold sync succeeds (resolved across every lab, no ?lab= needed)");

r = await call(inventoryMod, "GET", "/inventory?all=1", { headers: { "x-admin-token": driBToken } });
const catalogRow = r.data.find((i) => i.id === cableTester.id);
assert(catalogRow.available === 0, "the DRI catalog itself reflects driB's own cart hold as 0 available (all 2 already in a cart)");

// --- driB submits the request for exactly what's in their own cart hold - not blocked by their own reservation ---
r = await call(sourceRequestsMod, "POST", "/source-requests", {
  headers: { "x-admin-token": driBToken },
  body: { itemId: cableTester.id, qty: 2, sessionId: "driB-session" },
});
assert(r.status === 201, "driB can submit a request for exactly what their own cart hold already reserved");

// --- clearing a cart (empty snapshot) frees the reservation back up immediately ---
r = await call(cartHoldsMod, "POST", "/cart-holds?lab=" + encodeURIComponent(groomlakeToken), {
  body: { sessionId: "shopperC", items: [{ itemId: multimeter.id, qty: 2 }] },
});
r = await call(inventoryMod, "GET", "/inventory?lab=" + encodeURIComponent(groomlakeToken));
assert(r.data.find((i) => i.id === multimeter.id).available === 0, "shopperC's cart hold on the last 2 multimeters brings available to 0 for everyone else");

r = await call(cartHoldsMod, "POST", "/cart-holds?lab=" + encodeURIComponent(groomlakeToken), {
  body: { sessionId: "shopperC", items: [] },
});
r = await call(inventoryMod, "GET", "/inventory?lab=" + encodeURIComponent(groomlakeToken));
assert(r.data.find((i) => i.id === multimeter.id).available === 2, "an empty snapshot (cart cleared/abandoned) immediately frees shopperC's hold - no separate delete call needed");

console.log("\n" + (failures === 0 ? "ALL CART-HOLD TESTS PASSED" : `${failures} TEST(S) FAILED`));
process.exit(failures === 0 ? 0 : 1);
