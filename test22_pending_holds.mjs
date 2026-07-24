// Coverage for the per-item "pending hold" indicator: how much of an item
// is currently claimed by a pending client source request or a pending
// outgoing "send" transfer proposal, without either one actually touching
// real stock (see computePendingHolds in inventory.mjs). Staff-only field -
// never present in an anonymous/shopper response.
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

r = await call(inventoryMod, "POST", "/inventory?lab=groomlake", { headers: { "x-admin-token": lab1Token }, body: { name: "Multimeter", qty: 10, category: "Tools" } });
const multimeter = r.data.find((i) => i.name === "Multimeter");
r = await call(inventoryMod, "POST", "/inventory?lab=groomlake", { headers: { "x-admin-token": lab1Token }, body: { name: "Cable Tester", qty: 5, category: "Tools" } });
const cableTester = r.data.find((i) => i.name === "Cable Tester");

// --- baseline: nothing pending yet, onHold is 0 for a staff caller, real qty untouched ---
r = await call(inventoryMod, "GET", "/inventory?lab=groomlake", { headers: { "x-admin-token": lab1Token } });
assert(r.data.find((i) => i.id === multimeter.id).onHold === 0, "no pending requests/transfers yet - onHold starts at 0");

// --- a pending source request puts the requested qty on hold, without touching real qty ---
r = await call(sourceRequestsMod, "POST", "/source-requests", { headers: { "x-admin-token": driBToken }, body: { itemId: multimeter.id, qty: 3, note: "for the field team" } });
assert(r.status === 201, "driB requests 3 multimeters");
const driBRequest = r.data.find((req) => req.itemName === "Multimeter");

r = await call(inventoryMod, "GET", "/inventory?lab=groomlake", { headers: { "x-admin-token": lab1Token } });
let mm = r.data.find((i) => i.id === multimeter.id);
assert(mm.onHold === 3, "the pending source request's qty shows as onHold");
assert(mm.qty === 10, "real on-hand qty is completely untouched by a pending request");

// --- fulfilling the request clears the hold (still never touches qty - "request record only") ---
r = await call(sourceRequestsMod, "PATCH", "/source-requests", { headers: { "x-admin-token": lab1Token }, body: { id: driBRequest.id, action: "fulfill" } });
assert(r.status === 200, "lab1admin fulfills the request");
r = await call(inventoryMod, "GET", "/inventory?lab=groomlake", { headers: { "x-admin-token": lab1Token } });
mm = r.data.find((i) => i.id === multimeter.id);
assert(mm.onHold === 0, "hold clears once the request is resolved");
assert(mm.qty === 10, "fulfilling still never touches real qty - staff move it manually via Assign Supplies");

// --- a declined request also clears the hold ---
r = await call(sourceRequestsMod, "POST", "/source-requests", { headers: { "x-admin-token": driBToken }, body: { itemId: multimeter.id, qty: 4 } });
const secondRequest = r.data.find((req) => req.itemId === multimeter.id && req.status === "pending");
r = await call(inventoryMod, "GET", "/inventory?lab=groomlake", { headers: { "x-admin-token": lab1Token } });
assert(r.data.find((i) => i.id === multimeter.id).onHold === 4, "a second pending request puts its own qty on hold");
r = await call(sourceRequestsMod, "PATCH", "/source-requests", { headers: { "x-admin-token": lab1Token }, body: { id: secondRequest.id, action: "decline" } });
r = await call(inventoryMod, "GET", "/inventory?lab=groomlake", { headers: { "x-admin-token": lab1Token } });
assert(r.data.find((i) => i.id === multimeter.id).onHold === 0, "declining also clears the hold");

// --- a pending outgoing "send" transfer proposal also shows as a hold at the source lab ---
r = await call(transfersMod, "POST", "/transfers", {
  headers: { "x-admin-token": lab1Token },
  body: { sourceLabId: "groomlake", destinationLabId: labTwoId, direction: "send", items: [{ itemId: cableTester.id, qty: 2 }], note: "for lab two" },
});
assert(r.status === 201, "lab1admin proposes sending 2 cable testers to Lab Two");
const pendingTransfer = r.data.find((t) => t.note === "for lab two");

r = await call(inventoryMod, "GET", "/inventory?lab=groomlake", { headers: { "x-admin-token": lab1Token } });
let ct = r.data.find((i) => i.id === cableTester.id);
assert(ct.onHold === 2, "the pending send transfer's qty shows as onHold at the source lab");
assert(ct.qty === 5, "real qty is untouched until the destination actually accepts");

// --- once accepted, the hold clears at the source (stock actually moved, so nothing's pending anymore) ---
r = await call(transfersMod, "PATCH", "/transfers", { headers: { "x-admin-token": lab2Token }, body: { id: pendingTransfer.id, action: "accept" } });
assert(r.status === 200, "lab2admin accepts the transfer");
r = await call(inventoryMod, "GET", "/inventory?lab=groomlake", { headers: { "x-admin-token": lab1Token } });
ct = r.data.find((i) => i.id === cableTester.id);
assert(ct.onHold === 0, "hold clears once the transfer is accepted and stock actually moved");
assert(ct.qty === 3, "real qty dropped by the amount that actually transferred (5 -> 3)");

// --- a denied transfer also clears the hold without ever moving stock ---
r = await call(transfersMod, "POST", "/transfers", {
  headers: { "x-admin-token": lab1Token },
  body: { sourceLabId: "groomlake", destinationLabId: labTwoId, direction: "send", items: [{ itemId: cableTester.id, qty: 1 }], note: "second proposal" },
});
const secondTransfer = r.data.find((t) => t.note === "second proposal");
r = await call(inventoryMod, "GET", "/inventory?lab=groomlake", { headers: { "x-admin-token": lab1Token } });
assert(r.data.find((i) => i.id === cableTester.id).onHold === 1, "a second pending send shows its own hold");
r = await call(transfersMod, "PATCH", "/transfers", { headers: { "x-admin-token": lab2Token }, body: { id: secondTransfer.id, action: "deny" } });
r = await call(inventoryMod, "GET", "/inventory?lab=groomlake", { headers: { "x-admin-token": lab1Token } });
ct = r.data.find((i) => i.id === cableTester.id);
assert(ct.onHold === 0, "a denied transfer clears the hold too");
assert(ct.qty === 3, "and never moved any stock in the first place");

// --- holds from a request AND a pending send transfer on the SAME item add together ---
r = await call(sourceRequestsMod, "POST", "/source-requests", { headers: { "x-admin-token": driBToken }, body: { itemId: cableTester.id, qty: 1 } });
r = await call(transfersMod, "POST", "/transfers", {
  headers: { "x-admin-token": lab1Token },
  body: { sourceLabId: "groomlake", destinationLabId: labTwoId, direction: "send", items: [{ itemId: cableTester.id, qty: 1 }], note: "combined hold check" },
});
r = await call(inventoryMod, "GET", "/inventory?lab=groomlake", { headers: { "x-admin-token": lab1Token } });
assert(r.data.find((i) => i.id === cableTester.id).onHold === 2, "a pending request and a pending send transfer on the same item stack (1 + 1 = 2)");

// --- a pending "request"-direction transfer never attributes a hold to any real item - it's just a named wishlist until fulfilled ---
r = await call(transfersMod, "POST", "/transfers", {
  headers: { "x-admin-token": lab2Token },
  body: { sourceLabId: "groomlake", destinationLabId: labTwoId, direction: "request", items: [{ name: "Multimeter", qty: 2 }], note: "wishlist" },
});
assert(r.status === 201, "lab2admin requests multimeters by name from groomlake");
r = await call(inventoryMod, "GET", "/inventory?lab=groomlake", { headers: { "x-admin-token": lab1Token } });
assert(r.data.find((i) => i.id === multimeter.id).onHold === 0, "a pending request-direction transfer carries no real itemId yet, so it never shows as a hold on any specific item");

// --- staff-only: onHold never appears in an anonymous/shopper response ---
r = await call(labsMod, "GET", "/labs", { headers: { "x-admin-token": rootToken } });
const groomlakeToken = r.data.find((l) => l.id === "groomlake").accessToken;
r = await call(inventoryMod, "GET", "/inventory?lab=" + encodeURIComponent(groomlakeToken));
assert(r.status === 200, "anonymous shopper can still load the lab's inventory");
assert(!("onHold" in r.data.find((i) => i.id === cableTester.id)), "onHold is never present in the anonymous/shopper response - it's a staff-only field");

console.log("\n" + (failures === 0 ? "ALL PENDING-HOLD TESTS PASSED" : `${failures} TEST(S) FAILED`));
process.exit(failures === 0 ? 0 : 1);
