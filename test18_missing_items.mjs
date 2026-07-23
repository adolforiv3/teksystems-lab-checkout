// Coverage for missing-item tracking: an admin can flag specific line items
// on a checkout as missing (reportMissing), then resolve that flag either
// as "found" (clears the flag, item stays outstanding) or "written-off"
// (clears the flag, marks the item returned, and permanently reduces the
// lab's on-hand quantity for it). Also verifies the kitId/kitName snapshot
// captured at checkout time - the whole point of tracking this is knowing
// which kit a missing item came from.
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
const kitsMod = await import("./functions/kits.mjs");

let r = await call(adminAuthMod, "POST", "/admin-auth", { body: { action: "bootstrap", masterPasscode: "masterpass123", username: "root", password: "supersecret" } });
const rootToken = r.data.token;

r = await call(labsMod, "GET", "/labs", { headers: { "x-admin-token": rootToken } });
const groomlakeToken = r.data.find((l) => l.id === "groomlake").accessToken;
const anonLabQuery = "lab=" + encodeURIComponent(groomlakeToken);

r = await call(inventoryMod, "POST", "/inventory?lab=groomlake", { headers: { "x-admin-token": rootToken }, body: { name: "Multimeter", qty: 10 } });
const multimeter = r.data.find((i) => i.name === "Multimeter");
r = await call(inventoryMod, "POST", "/inventory?lab=groomlake", { headers: { "x-admin-token": rootToken }, body: { name: "Cable Tester", qty: 5 } });
const cableTester = r.data.find((i) => i.name === "Cable Tester");

r = await call(kitsMod, "POST", "/kits?lab=groomlake", {
  headers: { "x-admin-token": rootToken },
  body: { name: "Field Repair Kit", items: [{ itemId: multimeter.id, qty: 1 }, { itemId: cableTester.id, qty: 1 }] },
});
const kit = r.data.find((k) => k.name === "Field Repair Kit");

// --- self-checkout carries kit context, exactly like the shopper UI tags cart lines ---
r = await call(checkoutsMod, "POST", `/checkouts?${anonLabQuery}`, {
  body: {
    name: "Erin", email: "erin@example.com", indefinite: true,
    items: [
      { itemId: multimeter.id, name: "Multimeter", qty: 1, kitId: kit.id, kitName: kit.name },
      { itemId: cableTester.id, name: "Cable Tester", qty: 1, kitId: kit.id, kitName: kit.name },
    ],
  },
});
assert(r.status === 201, "Erin checks out both kit items");
const erinId = r.data.id;
assert(r.data.items.every((it) => it.kitId === kit.id && it.kitName === "Field Repair Kit"), "each item line carries the kit it was quick-added from");

// --- reportMissing: validation ---
r = await call(checkoutsMod, "PATCH", "/checkouts?lab=groomlake", { headers: { "x-admin-token": rootToken }, body: { id: erinId, action: "reportMissing", itemIds: ["nonexistent-item"] } });
assert(r.status === 400, "reporting an itemId not on this checkout as missing is a no-op error, not a silent success");

r = await call(checkoutsMod, "PATCH", "/checkouts?lab=groomlake", { headers: {}, body: { id: erinId, action: "reportMissing", itemIds: [multimeter.id] } });
assert(r.status === 401, "an anonymous caller can't report anything missing");

r = await call(adminsMod, "POST", "/admins", { headers: { "x-admin-token": rootToken }, body: { username: "labtech", password: "labtechpw1", role: "labadmin", labs: [] } });
r = await call(adminAuthMod, "POST", "/admin-auth", { body: { action: "login", username: "labtech", password: "labtechpw1" } });
const labtechToken = r.data.token;
r = await call(checkoutsMod, "PATCH", `/checkouts?${anonLabQuery}`, { headers: { "x-admin-token": labtechToken }, body: { id: erinId, action: "reportMissing", itemIds: [multimeter.id] } });
assert(r.status === 403, "an admin with no access to this lab can't report anything missing either");

// --- reportMissing: happy path ---
r = await call(checkoutsMod, "PATCH", "/checkouts?lab=groomlake", {
  headers: { "x-admin-token": rootToken },
  body: { id: erinId, action: "reportMissing", itemIds: [multimeter.id], note: "left in the rental car" },
});
assert(r.status === 200, "root reports the multimeter missing");
let erinRecord = r.data.find((c) => c.id === erinId);
let mmLine = erinRecord.items.find((it) => it.itemId === multimeter.id);
assert(mmLine.missing === true && typeof mmLine.missingAt === "string" && mmLine.missingNote === "left in the rental car", "the multimeter's line now carries missing/missingAt/missingNote");
assert(erinRecord.items.find((it) => it.itemId === cableTester.id).missing !== true, "the cable tester (not reported) is untouched");
const lastEntry1 = erinRecord.history[erinRecord.history.length - 1];
assert(lastEntry1.action === "reported-missing" && lastEntry1.note === "left in the rental car", "a reported-missing history entry was appended with the note");

r = await call(checkoutsMod, "PATCH", "/checkouts?lab=groomlake", { headers: { "x-admin-token": rootToken }, body: { id: erinId, action: "reportMissing", itemIds: [multimeter.id] } });
assert(r.status === 400, "reporting an already-missing item missing again is a no-op error");

r = await call(inventoryMod, "GET", "/inventory?lab=groomlake", { headers: { "x-admin-token": rootToken } });
assert(r.data.find((i) => i.id === multimeter.id).qty === 10, "the multimeter's total on-hand qty is untouched just by being reported missing");

// --- resolveMissing: validation ---
r = await call(checkoutsMod, "PATCH", "/checkouts?lab=groomlake", { headers: { "x-admin-token": rootToken }, body: { id: erinId, action: "resolveMissing", itemIds: [multimeter.id], resolution: "lost-forever" } });
assert(r.status === 400, "an unrecognized resolution value is rejected");

r = await call(checkoutsMod, "PATCH", "/checkouts?lab=groomlake", { headers: { "x-admin-token": rootToken }, body: { id: erinId, action: "resolveMissing", itemIds: [cableTester.id], resolution: "found" } });
assert(r.status === 400, "resolving an item that was never marked missing is a no-op error");

// --- resolveMissing: "found" ---
r = await call(checkoutsMod, "PATCH", "/checkouts?lab=groomlake", {
  headers: { "x-admin-token": rootToken },
  body: { id: erinId, action: "resolveMissing", itemIds: [multimeter.id], resolution: "found", note: "was under the seat" },
});
assert(r.status === 200, "root resolves the multimeter as found");
erinRecord = r.data.find((c) => c.id === erinId);
mmLine = erinRecord.items.find((it) => it.itemId === multimeter.id);
assert(mmLine.missing === false && mmLine.returned === false, "found clears the missing flag but leaves the item outstanding - it still needs a normal return");
assert(mmLine.missingAt === undefined && mmLine.missingNote === undefined, "the missing report details are cleared off the live item once resolved");
const lastEntry2 = erinRecord.history[erinRecord.history.length - 1];
assert(lastEntry2.action === "missing-resolved" && lastEntry2.resolution === "found", "a missing-resolved history entry records the resolution");

r = await call(inventoryMod, "GET", "/inventory?lab=groomlake", { headers: { "x-admin-token": rootToken } });
assert(r.data.find((i) => i.id === multimeter.id).qty === 10, "found never touches inventory quantity");

// --- resolveMissing: "written-off" ---
r = await call(checkoutsMod, "PATCH", "/checkouts?lab=groomlake", { headers: { "x-admin-token": rootToken }, body: { id: erinId, action: "reportMissing", itemIds: [multimeter.id] } });
assert(r.status === 200, "multimeter reported missing again for the write-off test");

r = await call(checkoutsMod, "PATCH", "/checkouts?lab=groomlake", {
  headers: { "x-admin-token": rootToken },
  body: { id: erinId, action: "resolveMissing", itemIds: [multimeter.id], resolution: "written-off" },
});
assert(r.status === 200, "root writes off the multimeter");
erinRecord = r.data.find((c) => c.id === erinId);
mmLine = erinRecord.items.find((it) => it.itemId === multimeter.id);
assert(mmLine.missing === false && mmLine.returned === true && typeof mmLine.returnedAt === "string", "written-off clears missing AND marks the item returned");

r = await call(inventoryMod, "GET", "/inventory?lab=groomlake", { headers: { "x-admin-token": rootToken } });
assert(r.data.find((i) => i.id === multimeter.id).qty === 9, "written-off permanently decrements the lab's on-hand quantity by what was lost");

// --- consistency: marking an item returned through any path clears a stale missing flag ---
// (the cable tester was never touched above - still outstanding, never missing)
r = await call(checkoutsMod, "PATCH", "/checkouts?lab=groomlake", { headers: { "x-admin-token": rootToken }, body: { id: erinId, action: "reportMissing", itemIds: [cableTester.id] } });
assert(r.status === 200, "cable tester reported missing to set up the returned+missing consistency check");
r = await call(checkoutsMod, "PATCH", "/checkouts?lab=groomlake", { headers: { "x-admin-token": rootToken }, body: { id: erinId } });
assert(r.status === 200, "root marks the rest of Erin's checkout returned (the blunt default action, not resolveMissing)");
const ctLine = r.data.find((c) => c.id === erinId).items.find((it) => it.itemId === cableTester.id);
assert(ctLine.returned === true && ctLine.missing !== true, "returned and missing can never both be true - marking returned clears a stale missing flag even via the default mark-returned action");

// --- classification: missing status on a classified item stays gated the same as everything else about that item ---
const rootAdmins = await call(adminsMod, "GET", "/admins", { headers: { "x-admin-token": rootToken } });
const rootId = rootAdmins.data.find((a) => a.username === "root").id;
const labtechId = rootAdmins.data.find((a) => a.username === "labtech").id;
await call(adminsMod, "PATCH", "/admins", { headers: { "x-admin-token": rootToken }, body: { id: rootId, grantClearance: { labId: "groomlake", tier: "black" } } });

r = await call(inventoryMod, "POST", "/inventory?lab=groomlake", { headers: { "x-admin-token": rootToken }, body: { name: "Secret Multimeter", qty: 3, classification: "black" } });
const secretItem = r.data.find((i) => i.name === "Secret Multimeter");

r = await call(checkoutsMod, "POST", "/checkouts?lab=groomlake", {
  headers: { "x-admin-token": rootToken },
  body: { name: "Dana", email: "dana@example.com", indefinite: true, items: [{ itemId: secretItem.id, name: "Secret Multimeter", qty: 1 }] },
});
const danaId = r.data.id;
r = await call(checkoutsMod, "PATCH", "/checkouts?lab=groomlake", { headers: { "x-admin-token": rootToken }, body: { id: danaId, action: "reportMissing", itemIds: [secretItem.id] } });
assert(r.status === 200, "cleared root reports the classified item missing");

await call(adminsMod, "PATCH", "/admins", { headers: { "x-admin-token": rootToken }, body: { id: labtechId, labs: ["groomlake"] } });
r = await call(checkoutsMod, "GET", "/checkouts?lab=groomlake", { headers: { "x-admin-token": labtechToken } });
assert(!r.data.some((c) => c.id === danaId), "an uncleared admin can't see Dana's checkout at all (it's entirely one classified item) - missing status included, same as any other detail about it");

console.log("\n" + (failures === 0 ? "ALL MISSING-ITEM TESTS PASSED" : `${failures} TEST(S) FAILED`));
process.exit(failures === 0 ? 0 : 1);
