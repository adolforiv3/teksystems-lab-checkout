// Dedicated coverage for the item-level serialNumber field: creation,
// editing, defaulting - a plain optional free-text field with no
// confidentiality logic of its own.
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

r = await call(adminsMod, "POST", "/admins", { headers: { "x-admin-token": rootToken }, body: { username: "labtech", password: "labtechpw1", role: "labadmin", labs: ["groomlake"] } });
assert(r.status === 201, "labtech created (scoped to groomlake)");
r = await call(adminAuthMod, "POST", "/admin-auth", { body: { action: "login", username: "labtech", password: "labtechpw1" } });
const labtechToken = r.data.token;

// --- an item can omit serialNumber entirely - defaults to empty string, not undefined/missing ---
r = await call(inventoryMod, "POST", "/inventory?lab=groomlake", { headers: { "x-admin-token": rootToken }, body: { name: "Box of Gloves", qty: 50 } });
assert(r.status === 200, "item created with no serialNumber in the request at all");
const gloves = r.data.find((i) => i.name === "Box of Gloves");
assert(gloves.serialNumber === "", "serialNumber defaults to an empty string, not undefined, when omitted");

// --- an item can be created WITH a serial number, and it's trimmed server-side ---
r = await call(inventoryMod, "POST", "/inventory?lab=groomlake", {
  headers: { "x-admin-token": rootToken },
  body: { name: "Spectrum Analyzer", qty: 1, serialNumber: "  SA-4471-XQ  " },
});
assert(r.status === 200, "item created with a serial number");
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

// --- any lab admin scoped to the lab sees the full serial number - no extra gate on top of ordinary lab access ---
r = await call(inventoryMod, "GET", "/inventory?lab=groomlake", { headers: { "x-admin-token": labtechToken } });
assert(r.status === 200, "labtech can read the lab's inventory");
assert(r.data.find((i) => i.id === analyzer.id)?.serialNumber === "SA-4471-XQ-REV2", "labtech sees the serial number in full, same as root");
assert(r.data.find((i) => i.id === gloves.id)?.serialNumber === "", "the gloves' empty serial number still reads as an empty string, not missing");

// --- the generic `attribute` field (color/brand/SKU/etc.) behaves the same way: optional, trimmed, freely editable ---
r = await call(inventoryMod, "POST", "/inventory?lab=groomlake", {
  headers: { "x-admin-token": rootToken },
  body: { name: "Cable Tester", qty: 3, attribute: "  Red  " },
});
const tester = r.data.find((i) => i.name === "Cable Tester");
assert(tester.attribute === "Red", "attribute is trimmed of surrounding whitespace on create");
assert(gloves.attribute === "", "attribute defaults to an empty string, not undefined, when omitted");

r = await call(inventoryMod, "PUT", "/inventory?lab=groomlake", {
  headers: { "x-admin-token": rootToken },
  body: { id: tester.id, attribute: "Blue" },
});
assert(r.data.find((i) => i.id === tester.id).attribute === "Blue", "attribute is editable in place via PUT");

console.log("\n" + (failures === 0 ? "ALL SERIAL-NUMBER TESTS PASSED" : `${failures} TEST(S) FAILED`));
process.exit(failures === 0 ? 0 : 1);
