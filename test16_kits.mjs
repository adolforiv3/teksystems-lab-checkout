// Coverage for kits: a lab admin builds a named {itemId,qty} recipe that
// the checkout screen can quick-add in one click. Kits are deliberately
// NOT a new inventory concept - this suite mostly checks that kits.mjs
// resolves/validates references into the real inventory correctly, applies
// the same classification/clearance need-to-know model as inventory.mjs
// and checkouts.mjs, and that access control matches every other lab-scoped
// endpoint (anon can read, only a scoped admin can write).
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
const kitsMod = await import("./functions/kits.mjs");

let r = await call(adminAuthMod, "POST", "/admin-auth", { body: { action: "bootstrap", masterPasscode: "masterpass123", username: "root", password: "supersecret" } });
const rootToken = r.data.token;

r = await call(labsMod, "GET", "/labs", { headers: { "x-admin-token": rootToken } });
const groomlakeToken = r.data.find((l) => l.id === "groomlake").accessToken;
const anonLabQuery = "lab=" + encodeURIComponent(groomlakeToken);

r = await call(inventoryMod, "POST", "/inventory?lab=groomlake", { headers: { "x-admin-token": rootToken }, body: { name: "Multimeter", qty: 10 } });
const multimeter = r.data.find((i) => i.name === "Multimeter");
r = await call(inventoryMod, "POST", "/inventory?lab=groomlake", { headers: { "x-admin-token": rootToken }, body: { name: "Cable Tester", qty: 4 } });
const cableTester = r.data.find((i) => i.name === "Cable Tester");

// --- validation ---
r = await call(kitsMod, "POST", "/kits?lab=groomlake", { headers: { "x-admin-token": rootToken }, body: { name: "", items: [{ itemId: multimeter.id, qty: 1 }] } });
assert(r.status === 400, "an empty kit name is rejected");

r = await call(kitsMod, "POST", "/kits?lab=groomlake", { headers: { "x-admin-token": rootToken }, body: { name: "Empty Kit", items: [] } });
assert(r.status === 400, "a kit with no items is rejected");

r = await call(kitsMod, "POST", "/kits?lab=groomlake", { headers: { "x-admin-token": rootToken }, body: { name: "Bad Kit", items: [{ itemId: "nonexistent-id", qty: 1 }] } });
assert(r.status === 404, "a kit referencing an itemId that doesn't exist in this lab is rejected");

// --- happy path: create, list, edit, delete ---
r = await call(kitsMod, "POST", "/kits?lab=groomlake", {
  headers: { "x-admin-token": rootToken },
  body: { name: "Field Repair Kit", items: [{ itemId: multimeter.id, qty: 1 }, { itemId: cableTester.id, qty: 2 }] },
});
assert(r.status === 201, "root creates a kit spanning two items");
let kit = r.data.find((k) => k.name === "Field Repair Kit");
assert(!!kit, "the created kit comes back in the list");
assert(kit.items.length === 2, "both item references are present");
assert(!("name" in kit.items[0]) && !("classification" in kit.items[0]), "a kit item reference is just {itemId, qty} - no captured/duplicated item metadata");
const kitId = kit.id;

r = await call(kitsMod, "GET", "/kits?lab=groomlake", { headers: { "x-admin-token": rootToken } });
assert(r.status === 200 && r.data.some((k) => k.id === kitId), "GET lists the kit back for the scoped admin");

r = await call(kitsMod, "GET", `/kits?${anonLabQuery}`, {});
assert(r.status === 200 && r.data.some((k) => k.id === kitId), "an anonymous shopper (resolving the lab by its access token) can read kits too - needed for the quick-add UI");

r = await call(kitsMod, "PUT", "/kits?lab=groomlake", { headers: { "x-admin-token": rootToken }, body: { id: kitId, name: "Field Repair Kit v2", items: [{ itemId: multimeter.id, qty: 3 }] } });
assert(r.status === 200, "root edits the kit's name and item list");
kit = r.data.find((k) => k.id === kitId);
assert(kit.name === "Field Repair Kit v2" && kit.items.length === 1 && kit.items[0].qty === 3, "the edit landed - renamed, down to one item at the new qty");

r = await call(kitsMod, "PUT", "/kits?lab=groomlake", { headers: { "x-admin-token": rootToken }, body: { id: "nonexistent-kit", name: "x" } });
assert(r.status === 404, "editing a kit id that doesn't exist 404s");

// --- access control: same shape as inventory.mjs/checkouts.mjs ---
r = await call(kitsMod, "POST", "/kits?lab=groomlake", { body: { name: "Anon Kit", items: [{ itemId: multimeter.id, qty: 1 }] } });
assert(r.status === 401, "an anonymous caller can't create a kit");

r = await call(adminsMod, "POST", "/admins", { headers: { "x-admin-token": rootToken }, body: { username: "otherlabtech", password: "otherlabpw1", role: "labadmin", labs: [] } });
r = await call(adminAuthMod, "POST", "/admin-auth", { body: { action: "login", username: "otherlabtech", password: "otherlabpw1" } });
const unscopedToken = r.data.token;
// Using the raw internal id (rather than the lab's access token) as an
// unscoped admin fails to resolve a lab at all - see lib/lab-registry.mjs's
// resolveLab, which only honors the id path for an admin already scoped to
// it - so this hits the earlier "locked" 401, not the later write-gate 403.
r = await call(kitsMod, "POST", "/kits?lab=groomlake", { headers: { "x-admin-token": unscopedToken }, body: { name: "Unscoped Kit", items: [{ itemId: multimeter.id, qty: 1 }] } });
assert(r.status === 401, "an unscoped admin can't even resolve the lab by its raw id");
// The lab's own access token *does* resolve for anyone, admin or not - this
// is the path that actually reaches the write-gate's 403.
r = await call(kitsMod, "POST", `/kits?${anonLabQuery}`, { headers: { "x-admin-token": unscopedToken }, body: { name: "Unscoped Kit", items: [{ itemId: multimeter.id, qty: 1 }] } });
assert(r.status === 403, "an admin who resolves the lab via its share link, but isn't scoped to it, gets 403 on write - not a silent success");

// --- classification: a kit's item list respects clearance the same way inventory/checkouts do ---
r = await call(inventoryMod, "POST", "/inventory?lab=groomlake", { headers: { "x-admin-token": rootToken }, body: { name: "Secret Sensor", qty: 5, classification: "black" } });
assert(r.status === 403, "root has no clearance yet, so root can't create a black item");

const rootAdmins = await call(adminsMod, "GET", "/admins", { headers: { "x-admin-token": rootToken } });
const rootId = rootAdmins.data.find((a) => a.username === "root").id;
await call(adminsMod, "PATCH", "/admins", { headers: { "x-admin-token": rootToken }, body: { id: rootId, grantClearance: { labId: "groomlake", tier: "black" } } });

r = await call(inventoryMod, "POST", "/inventory?lab=groomlake", { headers: { "x-admin-token": rootToken }, body: { name: "Secret Sensor", qty: 5, classification: "black" } });
assert(r.status === 200, "now cleared, root creates the black item");
const secretSensor = r.data.find((i) => i.name === "Secret Sensor");

r = await call(kitsMod, "POST", "/kits?lab=groomlake", {
  headers: { "x-admin-token": rootToken },
  body: { name: "Classified Kit", items: [{ itemId: secretSensor.id, qty: 1 }, { itemId: cableTester.id, qty: 1 }] },
});
assert(r.status === 201, "cleared root builds a kit mixing a classified item with a standard one");
const classifiedKitId = r.data.find((k) => k.name === "Classified Kit").id;

// give the other admin access to groomlake now, without clearance, to test the kit-filtering path
await call(adminsMod, "PATCH", "/admins", { headers: { "x-admin-token": rootToken }, body: { id: rootAdmins.data.find((a) => a.username === "otherlabtech").id, labs: ["groomlake"] } });

r = await call(kitsMod, "GET", "/kits?lab=groomlake", { headers: { "x-admin-token": unscopedToken } });
const mixedKitAsUncleared = r.data.find((k) => k.id === classifiedKitId);
assert(!!mixedKitAsUncleared, "an uncleared admin still sees the mixed kit - it has a standard item too");
assert(mixedKitAsUncleared.items.length === 1 && mixedKitAsUncleared.items[0].itemId === cableTester.id, "but the classified item's reference is filtered out of that kit's item list");

r = await call(kitsMod, "POST", "/kits?lab=groomlake", {
  headers: { "x-admin-token": rootToken },
  body: { name: "All Classified Kit", items: [{ itemId: secretSensor.id, qty: 1 }] },
});
const allClassifiedKitId = r.data.find((k) => k.name === "All Classified Kit").id;
r = await call(kitsMod, "GET", "/kits?lab=groomlake", { headers: { "x-admin-token": unscopedToken } });
assert(!r.data.some((k) => k.id === allClassifiedKitId), "a kit built entirely from a classified item disappears completely for an uncleared admin - its existence doesn't leak either");

r = await call(kitsMod, "POST", "/kits?lab=groomlake", {
  headers: { "x-admin-token": unscopedToken },
  body: { name: "Sneaky Kit", items: [{ itemId: secretSensor.id, qty: 1 }] },
});
assert(r.status === 404, "an uncleared admin can't even reference the classified item by id when building a new kit - defense in depth against a crafted request");

r = await call(kitsMod, "GET", `/kits?${anonLabQuery}`, {});
assert(r.data.some((k) => k.id === allClassifiedKitId) && r.data.find((k) => k.id === allClassifiedKitId).items.length === 1, "an anonymous shopper sees the classified item's reference unfiltered - matches inventory.mjs's existing checkout-visible-to-shoppers rule for classified items");

// --- delete ---
r = await call(kitsMod, "DELETE", "/kits?lab=groomlake", { headers: { "x-admin-token": rootToken }, body: { id: kitId } });
assert(r.status === 200 && !r.data.some((k) => k.id === kitId), "deleting a kit removes it from the list");
r = await call(inventoryMod, "GET", "/inventory?lab=groomlake", { headers: { "x-admin-token": rootToken } });
assert(r.data.some((i) => i.id === multimeter.id), "deleting the kit never touches the underlying inventory item");

r = await call(kitsMod, "DELETE", "/kits?lab=groomlake", { headers: { "x-admin-token": rootToken }, body: { id: kitId } });
assert(r.status === 404, "deleting an already-deleted kit id 404s instead of silently succeeding");

console.log("\n" + (failures === 0 ? "ALL KITS TESTS PASSED" : `${failures} TEST(S) FAILED`));
process.exit(failures === 0 ? 0 : 1);
