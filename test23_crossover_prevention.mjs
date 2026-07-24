// Coverage for actual crossover prevention: a pending client source request
// or a pending outgoing "send" transfer proposal now reduces the `available`
// number everyone sees (shopper, DRI catalog, staff) AND is enforced
// server-side, so two different parties can't both successfully claim the
// same units. See lib/holds.mjs (the shared computation) and its call sites
// in inventory.mjs, checkouts.mjs, source-requests.mjs, and transfers.mjs.
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
const transfersMod = await import("./functions/transfers.mjs");
const sourceRequestsMod = await import("./functions/source-requests.mjs");

let r = await call(adminAuthMod, "POST", "/admin-auth", { body: { action: "bootstrap", masterPasscode: "masterpass123", username: "root", password: "supersecret" } });
const rootToken = r.data.token;

r = await call(labsMod, "POST", "/labs", { headers: { "x-admin-token": rootToken }, body: { name: "Lab Two" } });
const labTwoId = r.data.created.id;

r = await call(adminsMod, "POST", "/admins", { headers: { "x-admin-token": rootToken }, body: { username: "lab1admin", password: "lab1adminpw", role: "labadmin", labs: ["groomlake"] } });
r = await call(adminAuthMod, "POST", "/admin-auth", { body: { action: "login", username: "lab1admin", password: "lab1adminpw" } });
const lab1Token = r.data.token;

r = await call(adminsMod, "POST", "/admins", { headers: { "x-admin-token": rootToken }, body: { username: "lab2admin", password: "lab2adminpw", role: "labadmin", labs: [labTwoId] } });
r = await call(adminAuthMod, "POST", "/admin-auth", { body: { action: "login", username: "lab2admin", password: "lab2adminpw" } });
const lab2Token = r.data.token;

r = await call(adminsMod, "POST", "/admins", { headers: { "x-admin-token": rootToken }, body: { username: "driB", password: "driBpassword", role: "client", clientOrg: "B" } });
r = await call(adminAuthMod, "POST", "/admin-auth", { body: { action: "login", username: "driB", password: "driBpassword" } });
const driBToken = r.data.token;

r = await call(adminsMod, "POST", "/admins", { headers: { "x-admin-token": rootToken }, body: { username: "driC", password: "driCpassword", role: "client", clientOrg: "C" } });
r = await call(adminAuthMod, "POST", "/admin-auth", { body: { action: "login", username: "driC", password: "driCpassword" } });
const driCToken = r.data.token;

r = await call(inventoryMod, "POST", "/inventory?lab=groomlake", { headers: { "x-admin-token": lab1Token }, body: { name: "Multimeter", qty: 5, category: "Tools" } });
const multimeter = r.data.find((i) => i.name === "Multimeter");

r = await call(labsMod, "GET", "/labs", { headers: { "x-admin-token": rootToken } });
const groomlakeToken = r.data.find((l) => l.id === "groomlake").accessToken;

// --- a pending DRI request reduces what the SHOPPER sees as available, everywhere ---
r = await call(sourceRequestsMod, "POST", "/source-requests", { headers: { "x-admin-token": driBToken }, body: { itemId: multimeter.id, qty: 3 } });
assert(r.status === 201, "driB requests 3 of 5 multimeters");

r = await call(inventoryMod, "GET", "/inventory?lab=" + encodeURIComponent(groomlakeToken));
let shopperItem = r.data.find((i) => i.id === multimeter.id);
assert(shopperItem.available === 2, "the anonymous shopper's own view of available now excludes driB's pending hold (5 - 3 = 2)");
assert(!("onHold" in shopperItem), "the hold breakdown itself is still staff-only");

// --- actual crossover prevention: a shopper can't check out more than what's really left ---
r = await call(checkoutsMod, "POST", "/checkouts?lab=" + encodeURIComponent(groomlakeToken), {
  body: { name: "Shopper One", email: "shopper1@example.com", items: [{ itemId: multimeter.id, name: "Multimeter", qty: 3 }] },
});
assert(r.status === 409, "a shopper trying to check out 3 (more than the 2 actually left after driB's hold) is rejected");

r = await call(checkoutsMod, "POST", "/checkouts?lab=" + encodeURIComponent(groomlakeToken), {
  body: { name: "Shopper One", email: "shopper1@example.com", items: [{ itemId: multimeter.id, name: "Multimeter", qty: 2 }] },
});
assert(r.status === 201, "checking out exactly the 2 that are actually still free succeeds");

// --- with 2 checked out and 3 held, nothing is left for a second DRI ---
r = await call(sourceRequestsMod, "POST", "/source-requests", { headers: { "x-admin-token": driCToken }, body: { itemId: multimeter.id, qty: 1 } });
assert(r.status === 409, "driC can't request even 1 more - the shopper's 2 plus driB's held 3 already account for all 5");
assert(/available/.test((r.data && r.data.error) || ""), "the rejection explains why: not enough available");

// --- declining driB's request frees the units back up for driC ---
r = await call(sourceRequestsMod, "GET", "/source-requests", { headers: { "x-admin-token": lab1Token } });
const driBRequest = r.data.find((req) => req.itemId === multimeter.id && req.clientOrg === "B" && req.status === "pending");
r = await call(sourceRequestsMod, "PATCH", "/source-requests", { headers: { "x-admin-token": lab1Token }, body: { id: driBRequest.id, action: "decline" } });
assert(r.status === 200, "lab1admin declines driB's request");

r = await call(sourceRequestsMod, "POST", "/source-requests", { headers: { "x-admin-token": driCToken }, body: { itemId: multimeter.id, qty: 3 } });
assert(r.status === 201, "driC can now request up to the 3 that freed up (2 already checked out, 3 available)");

// --- a pending outgoing transfer proposal also blocks a DRI from claiming the same units ---
r = await call(inventoryMod, "POST", "/inventory?lab=groomlake", { headers: { "x-admin-token": lab1Token }, body: { name: "Cable Tester", qty: 4, category: "Tools" } });
const cableTester = r.data.find((i) => i.name === "Cable Tester");

r = await call(transfersMod, "POST", "/transfers", {
  headers: { "x-admin-token": lab1Token },
  body: { sourceLabId: "groomlake", destinationLabId: labTwoId, direction: "send", items: [{ itemId: cableTester.id, qty: 4 }], note: "all of them" },
});
assert(r.status === 201, "lab1admin proposes sending all 4 cable testers to Lab Two");
const pendingTransfer = r.data.find((t) => t.note === "all of them");

r = await call(sourceRequestsMod, "POST", "/source-requests", { headers: { "x-admin-token": driBToken }, body: { itemId: cableTester.id, qty: 1 } });
assert(r.status === 409, "driB can't request a cable tester either - all 4 are already committed to the pending transfer");

// --- and a second lab-to-lab transfer proposal for the same item is blocked too ---
r = await call(transfersMod, "POST", "/transfers", {
  headers: { "x-admin-token": lab1Token },
  body: { sourceLabId: "groomlake", destinationLabId: labTwoId, direction: "send", items: [{ itemId: cableTester.id, qty: 1 }], note: "second proposal" },
});
assert(r.status === 409, "a second pending send transfer for the same fully-held item is rejected");

// --- denying the first transfer frees the cable testers back up ---
r = await call(transfersMod, "PATCH", "/transfers", { headers: { "x-admin-token": lab2Token }, body: { id: pendingTransfer.id, action: "deny" } });
assert(r.status === 200, "lab2admin denies the transfer");

r = await call(sourceRequestsMod, "POST", "/source-requests", { headers: { "x-admin-token": driBToken }, body: { itemId: cableTester.id, qty: 4 } });
assert(r.status === 201, "driB can now request all 4 cable testers now that the transfer's hold is gone");

// --- admins keep the ability to deliberately override a hold when assigning supplies ---
r = await call(checkoutsMod, "POST", "/checkouts?lab=groomlake", {
  headers: { "x-admin-token": lab1Token },
  body: { name: "Walk-in", email: "walkin@example.com", items: [{ itemId: cableTester.id, name: "Cable Tester", qty: 4 }] },
});
assert(r.status === 201, "an admin-assigned checkout still bypasses the hold check on purpose, same as it already bypassed plain availability");

console.log("\n" + (failures === 0 ? "ALL CROSSOVER-PREVENTION TESTS PASSED" : `${failures} TEST(S) FAILED`));
process.exit(failures === 0 ? 0 : 1);
