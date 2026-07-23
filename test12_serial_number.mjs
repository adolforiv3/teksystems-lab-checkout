// Dedicated coverage for the item-level serialNumber field: creation,
// editing, defaulting, and (most importantly) that it rides along with the
// existing classification confidentiality filter for free - no separate
// clearance logic was added for it, so this proves that assumption holds.
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

const adminAuthMod = await import("./functions/admin-auth.mjs");
const adminsMod = await import("./functions/admins.mjs");
const inventoryMod = await import("./functions/inventory.mjs");

let r = await call(adminAuthMod, "POST", "/admin-auth", { body: { action: "bootstrap", masterPasscode: "masterpass123", username: "root", password: "supersecret" } });
assert(r.status === 201, "root bootstrapped");
const rootToken = r.data.token;
const rootId = r.data.admin.id;
r = await call(adminsMod, "PATCH", "/admins", { headers: { "x-admin-token": rootToken }, body: { id: rootId, grantClearance: { labId: "groomlake", tier: "ultraBlack" } } });
assert(r.status === 200, "root grants itself ultraBlack clearance for groomlake");

r = await call(adminsMod, "POST", "/admins", { headers: { "x-admin-token": rootToken }, body: { username: "labtech", password: "labtechpw1", role: "labadmin", labs: ["groomlake"] } });
assert(r.status === 201, "labtech created (scoped to groomlake, no clearance)");
r = await call(adminAuthMod, "POST", "/admin-auth", { body: { action: "login", username: "labtech", password: "labtechpw1" } });
const labtechToken = r.data.token;

// --- a standard item can omit serialNumber entirely - defaults to empty string, not undefined/missing ---
r = await call(inventoryMod, "POST", "/inventory?lab=groomlake", { headers: { "x-admin-token": rootToken }, body: { name: "Box of Gloves", qty: 50 } });
assert(r.status === 200, "standard item created with no serialNumber in the request at all");
const gloves = r.data.find((i) => i.name === "Box of Gloves");
assert(gloves.serialNumber === "", "serialNumber defaults to an empty string, not undefined, when omitted");

// --- a black item can be created WITH a serial number, and it's trimmed server-side ---
r = await call(inventoryMod, "POST", "/inventory?lab=groomlake", {
  headers: { "x-admin-token": rootToken },
  body: { name: "Spectrum Analyzer", qty: 1, classification: "black", serialNumber: "  SA-4471-XQ  " },
});
assert(r.status === 200, "black item created with a serial number");
const analyzer = r.data.find((i) => i.name === "Spectrum Analyzer");
assert(analyzer.serialNumber === "SA-4471-XQ", "serial number is trimmed of surrounding whitespace - got: " + JSON.stringify(analyzer.serialNumber));

// --- serial number is editable after creation via PUT, independent of every other field ---
r = await call(inventoryMod, "PUT", "/inventory?lab=groomlake", {
  headers: { "x-admin-token": rootToken },
  body: { id: analyzer.id, serialNumber: "SA-4471-XQ-REV2" },
});
assert(r.status === 200, "serialNumber-only PUT succeeds");
assert(r.data.find((i) => i.id === analyzer.id).serialNumber === "SA-4471-XQ-REV2", "serial number updated in place");
assert(r.data.find((i) => i.id === analyzer.id).qty === 1, "editing serialNumber alone leaves qty (and every other field) untouched");

// --- a standard item can also be given a serial number later - not hard-restricted server-side, just hidden by default in the UI ---
r = await call(inventoryMod, "PUT", "/inventory?lab=groomlake", {
  headers: { "x-admin-token": rootToken },
  body: { id: gloves.id, serialNumber: "LOT-2231" },
});
assert(r.status === 200 && r.data.find((i) => i.id === gloves.id).serialNumber === "LOT-2231", "a standard item can also carry a serialNumber if explicitly set - no server-side tier restriction");

// --- confidentiality: an uncleared admin's response doesn't contain the classified item AT ALL, so its serial number is never exposed either ---
r = await call(inventoryMod, "GET", "/inventory?lab=groomlake", { headers: { "x-admin-token": labtechToken } });
assert(r.status === 200, "uncleared labadmin can read the lab's inventory");
assert(!r.data.some((i) => i.id === analyzer.id), "the classified item itself is entirely absent from the uncleared admin's response");
assert(JSON.stringify(r.data).indexOf("SA-4471-XQ-REV2") === -1, "the classified item's serial number string does not appear anywhere in the uncleared admin's response body");
assert(r.data.some((i) => i.id === gloves.id && i.serialNumber === "LOT-2231"), "the standard item's serial number IS visible to a normal lab admin, as expected");

// --- a cleared admin (root) sees the full serial number on the classified item ---
r = await call(inventoryMod, "GET", "/inventory?lab=groomlake", { headers: { "x-admin-token": rootToken } });
assert(r.data.find((i) => i.id === analyzer.id).serialNumber === "SA-4471-XQ-REV2", "the cleared admin sees the classified item's serial number in full");

console.log("\n" + (failures === 0 ? "ALL SERIAL-NUMBER TESTS PASSED" : `${failures} TEST(S) FAILED`));
process.exit(failures === 0 ? 0 : 1);
