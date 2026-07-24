// Coverage for the Client DRI role: a client account gets read-only access
// to every lab's catalog company-wide, with lab/team identity stripped
// server-side (never just hidden client-side), can't mutate inventory or
// resolve its own source requests, and only ever sees its own org's request
// history - never another client org's. Also covers the superadmin-only
// admin-account plumbing that creates/edits a client account's org tag.
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

r = await call(inventoryMod, "POST", "/inventory?lab=groomlake", { headers: { "x-admin-token": lab1Token }, body: { name: "Multimeter", qty: 10, category: "Tools", notes: "handle with care" } });
const multimeter = r.data.find((i) => i.name === "Multimeter");

r = await call(inventoryMod, "POST", "/inventory?lab=" + labTwoId, { headers: { "x-admin-token": lab2Token }, body: { name: "Cable Tester", qty: 4, category: "Tools" } });
const cableTester = r.data.find((i) => i.name === "Cable Tester");

// an item carrying both an attribute and a serial number, to check the allowlist keeps one and drops the other
await call(inventoryMod, "POST", "/inventory?lab=groomlake", { headers: { "x-admin-token": lab1Token }, body: { name: "Secret Widget", qty: 5, attribute: "Red", serialNumber: "SN-42" } });

// === Admin Accounts: creating/editing a client DRI account ===

r = await call(adminsMod, "POST", "/admins", { headers: { "x-admin-token": rootToken }, body: { username: "driB", password: "driBpassword", role: "client" } });
assert(r.status === 400 && /org tag/.test(r.data.error), "creating a client account without an org tag is rejected");

r = await call(adminsMod, "POST", "/admins", { headers: { "x-admin-token": rootToken }, body: { username: "driB", password: "driBpassword", role: "client", clientOrg: "B" } });
assert(r.status === 201, "superadmin creates a client DRI account for org B");
let driBAccount = r.data.find((a) => a.username === "driB");
assert(driBAccount.role === "client" && driBAccount.clientOrg === "B" && driBAccount.labs.length === 0, "the new account carries role=client, clientOrg=B, and no lab scope at all");

r = await call(adminsMod, "POST", "/admins", { headers: { "x-admin-token": rootToken }, body: { username: "driC", password: "driCpassword", role: "client", clientOrg: "C" } });
assert(r.status === 201, "superadmin creates a second client DRI account for org C");

// switching an existing labadmin to client without a clientOrg is rejected; labs are cleared once it succeeds
r = await call(adminsMod, "POST", "/admins", { headers: { "x-admin-token": rootToken }, body: { username: "temp-labadmin", password: "tmppassword", role: "labadmin", labs: ["groomlake"] } });
const tempId = r.data.find((a) => a.username === "temp-labadmin").id;
r = await call(adminsMod, "PATCH", "/admins", { headers: { "x-admin-token": rootToken }, body: { id: tempId, role: "client" } });
assert(r.status === 400 && /org tag/.test(r.data.error), "switching a labadmin to client without supplying clientOrg is rejected");
r = await call(adminsMod, "PATCH", "/admins", { headers: { "x-admin-token": rootToken }, body: { id: tempId, role: "client", clientOrg: "D" } });
assert(r.status === 200, "switching to client with a clientOrg succeeds");
let temp = r.data.find((a) => a.id === tempId);
assert(temp.role === "client" && temp.clientOrg === "D" && temp.labs.length === 0, "the old lab scope was cleared when switching into the client role");
r = await call(adminsMod, "PATCH", "/admins", { headers: { "x-admin-token": rootToken }, body: { id: tempId, role: "labadmin", labs: [labTwoId] } });
temp = r.data.find((a) => a.id === tempId);
assert(temp.role === "labadmin" && temp.clientOrg === undefined, "switching back out of client clears the stale clientOrg tag");

// === Client login + cross-lab catalog ===

r = await call(adminAuthMod, "POST", "/admin-auth", { body: { action: "login", username: "driB", password: "driBpassword" } });
assert(r.status === 200 && r.data.admin.role === "client" && r.data.admin.clientOrg === "B", "driB logs in with a normal username+password admin session, same as any labadmin");
const driBToken = r.data.token;

r = await call(adminAuthMod, "POST", "/admin-auth", { body: { action: "login", username: "driC", password: "driCpassword" } });
const driCToken = r.data.token;

r = await call(inventoryMod, "GET", "/inventory?all=1", { headers: { "x-admin-token": driBToken } });
assert(r.status === 200, "driB can fetch the cross-lab client catalog");
const catalog = r.data;
assert(catalog.some((i) => i.name === "Multimeter") && catalog.some((i) => i.name === "Cable Tester"), "the catalog spans every lab company-wide - groomlake's Multimeter and Lab Two's Cable Tester both show up for a client scoped to neither");

const catalogMultimeter = catalog.find((i) => i.name === "Multimeter");
assert(
  !("labId" in catalogMultimeter) && !("labName" in catalogMultimeter) && !("notes" in catalogMultimeter) && !("lowStockThreshold" in catalogMultimeter) && !("serialNumber" in catalogMultimeter),
  "a client's catalog row never carries lab identity or any of the other allowlist-excluded fields, even though the underlying item has notes"
);
assert(catalogMultimeter.qty === 10 && catalogMultimeter.available === 10 && catalogMultimeter.category === "Tools", "the fields a client IS allowed - name/category/qty/available - are still present and correct");

const catalogSecret = catalog.find((i) => i.name === "Secret Widget");
assert(!!catalogSecret, "the item shows up in a client's catalog");
assert(catalogSecret.attribute === "Red", "the utilitarian attribute field IS in the client allowlist - useful for telling similar items apart");
assert(!("serialNumber" in catalogSecret), "a client never learns an item's serial number - stays admin-only");

r = await call(labsMod, "GET", "/labs?directory=1", { headers: { "x-admin-token": driBToken } });
assert(r.status === 200 && r.data.length === 0, "a client has no admin authority over any lab, so the cross-company lab-name directory (normally visible to any labadmin, e.g. to pick a transfer counterparty) hands back nothing for a client");

// === Client cannot mutate inventory ===

r = await call(inventoryMod, "POST", "/inventory?lab=groomlake", { headers: { "x-admin-token": driBToken }, body: { name: "Sneaky Item", qty: 1 } });
assert(r.status !== 200 && r.status !== 201, "a client can't create inventory directly - no lab scope means it can't even resolve groomlake to attempt the write");

r = await call(inventoryMod, "PUT", "/inventory?lab=groomlake", { headers: { "x-admin-token": driBToken }, body: { id: multimeter.id, qty: 999 } });
assert(r.status !== 200, "a client can't edit an existing item's qty directly either");

// === Source requests: client creates a claim, staff resolves it, nothing mutates inventory directly ===

r = await call(sourceRequestsMod, "POST", "/source-requests", { headers: { "x-admin-token": lab1Token }, body: { itemId: multimeter.id, qty: 2 } });
assert(r.status === 403 && /client account required/.test(r.data.error), "only a client account can submit a source request - a labadmin posting here is rejected");

r = await call(sourceRequestsMod, "POST", "/source-requests", { headers: { "x-admin-token": driBToken }, body: { itemId: multimeter.id } });
assert(r.status === 400, "a source request without a positive qty is rejected");

r = await call(sourceRequestsMod, "POST", "/source-requests", { headers: { "x-admin-token": driBToken }, body: { itemId: "not-a-real-item", qty: 1 } });
assert(r.status === 404, "requesting an item that doesn't exist in any lab is rejected");

r = await call(sourceRequestsMod, "POST", "/source-requests", { headers: { "x-admin-token": driBToken }, body: { itemId: multimeter.id, qty: 2, note: "for the field team" } });
assert(r.status === 201, "driB submits a source request against the Multimeter it saw in its cross-lab catalog");
let driBRequest = r.data.find((req) => req.itemName === "Multimeter" && req.note === "for the field team");
assert(!!driBRequest && driBRequest.status === "pending", "the request record exists and is pending");
assert(
  !("labId" in driBRequest) && !("labName" in driBRequest) && !("clientOrg" in driBRequest) && !("clientUsername" in driBRequest),
  "the response back to the client itself never reveals which lab actually owns the item, or its own org/username fields - viewForRole strips them even from its own author"
);

r = await call(inventoryMod, "GET", "/inventory?lab=groomlake", { headers: { "x-admin-token": lab1Token } });
assert(r.data.find((i) => i.id === multimeter.id).qty === 10, "submitting a source request never touches real stock - it's a claim, not a mutation");

// org isolation: driC must never see driB's request
r = await call(sourceRequestsMod, "GET", "/source-requests", { headers: { "x-admin-token": driCToken } });
assert(r.status === 200 && !r.data.some((req) => req.note === "for the field team"), "a different client org (driC) never sees driB's request history");

// driB does see its own
r = await call(sourceRequestsMod, "GET", "/source-requests", { headers: { "x-admin-token": driBToken } });
assert(r.data.some((req) => req.note === "for the field team"), "driB sees its own request in its own history");

// staff visibility: the request is against a groomlake item, so lab1admin (who manages groomlake) sees it with full fields; lab2admin (Lab Two only) does not
r = await call(sourceRequestsMod, "GET", "/source-requests", { headers: { "x-admin-token": lab1Token } });
let staffView = r.data.find((req) => req.note === "for the field team");
assert(!!staffView && staffView.labId === "groomlake" && staffView.clientOrg === "B", "lab1admin, who manages groomlake, sees the full record including which lab and which client org it came from");

r = await call(sourceRequestsMod, "GET", "/source-requests", { headers: { "x-admin-token": lab2Token } });
assert(!r.data.some((req) => req.note === "for the field team"), "lab2admin, who doesn't manage groomlake, never sees a request against a groomlake item");

// a client can never resolve its own request - only staff scoped to the item's lab (or a superadmin) can
r = await call(sourceRequestsMod, "PATCH", "/source-requests", { headers: { "x-admin-token": driBToken }, body: { id: driBRequest.id, action: "fulfill" } });
assert(r.status === 403, "driB can't fulfill its own request - it has no lab scope at all, so canAccessLab is always false for a client");

r = await call(sourceRequestsMod, "PATCH", "/source-requests", { headers: { "x-admin-token": lab2Token }, body: { id: driBRequest.id, action: "fulfill" } });
assert(r.status === 403, "lab2admin can't fulfill a request against an item in a lab it doesn't manage");

r = await call(sourceRequestsMod, "PATCH", "/source-requests", { headers: { "x-admin-token": lab1Token }, body: { id: driBRequest.id, action: "fulfill", note: "handed off in person" } });
assert(r.status === 200, "lab1admin, who manages groomlake, fulfills the request");
let resolved = r.data.find((req) => req.id === driBRequest.id);
assert(resolved.status === "fulfilled" && resolved.resolvedBy === "lab1admin", "status flips to fulfilled and records who resolved it");

r = await call(inventoryMod, "GET", "/inventory?lab=groomlake", { headers: { "x-admin-token": lab1Token } });
assert(r.data.find((i) => i.id === multimeter.id).qty === 10, "fulfilling a source request STILL never mutates stock directly - it's a record for staff to act on manually through the normal checkout flow, per the 'request record only' design");

r = await call(sourceRequestsMod, "PATCH", "/source-requests", { headers: { "x-admin-token": lab1Token }, body: { id: driBRequest.id, action: "decline" } });
assert(r.status === 400, "an already-resolved request can't be acted on again");

// superadmin can act on a request against any lab
r = await call(sourceRequestsMod, "POST", "/source-requests", { headers: { "x-admin-token": driCToken }, body: { itemId: cableTester.id, qty: 1, note: "org C wants a cable tester" } });
let driCRequest = r.data.find((req) => req.note === "org C wants a cable tester");
r = await call(sourceRequestsMod, "PATCH", "/source-requests", { headers: { "x-admin-token": rootToken }, body: { id: driCRequest.id, action: "decline", note: "out of stock company-wide" } });
assert(r.status === 200, "superadmin can resolve a request against any lab, regardless of which labadmin owns it");
resolved = r.data.find((req) => req.id === driCRequest.id);
assert(resolved.status === "declined", "decline is recorded correctly");

console.log("\n" + (failures === 0 ? "ALL CLIENT ROLE TESTS PASSED" : `${failures} TEST(S) FAILED`));
process.exit(failures === 0 ? 0 : 1);
