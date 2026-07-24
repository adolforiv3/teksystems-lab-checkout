// Dedicated coverage for the checkout history/trail feature: every
// checkout record now carries a `history` array recording when it was
// checked out and every subsequent return/edit event, so "when was this
// actually checked out" stays answerable long after the status badge just
// says "returned".
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
const inventoryMod = await import("./functions/inventory.mjs");
const checkoutsMod = await import("./functions/checkouts.mjs");

let r = await call(adminAuthMod, "POST", "/admin-auth", { body: { action: "bootstrap", masterPasscode: "masterpass123", username: "root", password: "supersecret" } });
const rootToken = r.data.token;

r = await call(inventoryMod, "POST", "/inventory?lab=groomlake", { headers: { "x-admin-token": rootToken }, body: { name: "Widget", qty: 20 } });
const widget = r.data.find((i) => i.name === "Widget");
r = await call(inventoryMod, "POST", "/inventory?lab=groomlake", { headers: { "x-admin-token": rootToken }, body: { name: "Gadget", qty: 20 } });
const gadget = r.data.find((i) => i.name === "Gadget");

// Anonymous callers can only ever resolve a lab by its unguessable access
// token, never the raw internal id "groomlake" (see
// functions/lib/lab-registry.mjs's resolveLab) - fetch it the same way a
// real shopper's share link would carry it, for the genuinely anonymous
// self-checkout/self-return calls below.
r = await call(labsMod, "GET", "/labs", { headers: { "x-admin-token": rootToken } });
const groomlakeToken = r.data.find((l) => l.id === "groomlake").accessToken;
const anonLabQuery = "lab=" + encodeURIComponent(groomlakeToken);

// --- self-checkout: history starts with exactly one 'checked-out' entry ---
r = await call(checkoutsMod, "POST", `/checkouts?${anonLabQuery}`, {
  body: { name: "Alice", email: "alice@example.com", indefinite: true, items: [{ itemId: widget.id, name: "Widget", qty: 2 }, { itemId: gadget.id, name: "Gadget", qty: 1 }] },
});
assert(r.status === 201, "Alice's self-checkout succeeds");
const aliceId = r.data.id;
assert(Array.isArray(r.data.history) && r.data.history.length === 1, "the fresh checkout record has exactly one history entry");
assert(r.data.history[0].action === "checked-out", "that entry's action is 'checked-out'");
assert(r.data.history[0].at === r.data.createdAt, "its timestamp matches the record's own createdAt - this is the fact that answers 'when was it checked out'");
assert(r.data.history[0].by === undefined, "no 'by' admin on a genuine self-checkout");
assert(
  r.data.history[0].items.length === 2 &&
    r.data.history[0].items.some((it) => it.itemId === widget.id && it.qty === 2) &&
    r.data.history[0].items.some((it) => it.itemId === gadget.id && it.qty === 1),
  "the checked-out entry records exactly what was taken"
);

// --- self-service partial return: adds a 'self-returned' entry, stamps returnedAt on just that item ---
r = await call(checkoutsMod, "PATCH", `/checkouts?${anonLabQuery}`, {
  body: { id: aliceId, action: "returnItems", email: "alice@example.com", itemIds: [widget.id] },
});
assert(r.status === 200, "Alice self-returns just the widget");
let aliceRecord = r.data.find((c) => c.id === aliceId);
assert(aliceRecord.items.find((it) => it.itemId === widget.id).returned === true, "widget is now marked returned");
assert(typeof aliceRecord.items.find((it) => it.itemId === widget.id).returnedAt === "string", "widget has a returnedAt timestamp");
assert(aliceRecord.items.find((it) => it.itemId === gadget.id).returned === false, "gadget is still outstanding - untouched by the partial return");
assert(aliceRecord.history.length === 2, "history now has 2 entries: checked-out, then this return");
assert(aliceRecord.history[1].action === "self-returned", "second entry is 'self-returned'");
assert(
  aliceRecord.history[1].items.length === 1 && aliceRecord.history[1].items[0].itemId === widget.id,
  "the return entry only references the item that was actually just returned, not the whole cart"
);
assert(aliceRecord.history[0].action === "checked-out", "the original checked-out entry is still there, untouched - the trail accumulates, it doesn't get overwritten");

// --- no-op return (already-returned item, nothing new) doesn't add a phantom history entry ---
r = await call(checkoutsMod, "PATCH", `/checkouts?${anonLabQuery}`, {
  body: { id: aliceId, action: "returnItems", email: "alice@example.com", itemIds: [widget.id] },
});
aliceRecord = r.data.find((c) => c.id === aliceId);
assert(aliceRecord.history.length === 2, "returning an already-returned item again doesn't add a duplicate/phantom history entry");

// --- admin marks the rest returned: adds a 'returned' entry with the admin's identity, only for the still-outstanding item ---
r = await call(checkoutsMod, "PATCH", "/checkouts?lab=groomlake", { headers: { "x-admin-token": rootToken }, body: { id: aliceId } });
assert(r.status === 200, "admin marks the rest of the checkout returned");
aliceRecord = r.data.find((c) => c.id === aliceId);
assert(aliceRecord.history.length === 3, "history now has 3 entries");
assert(aliceRecord.history[2].action === "returned" && aliceRecord.history[2].by === "root", "third entry is an admin-attributed 'returned' event");
assert(
  aliceRecord.history[2].items.length === 1 && aliceRecord.history[2].items[0].itemId === gadget.id,
  "it only references the gadget - the widget (already returned earlier) isn't re-listed"
);
assert(typeof aliceRecord.items.find((it) => it.itemId === gadget.id).returnedAt === "string", "gadget also got its own returnedAt, separate from the widget's");
assert(
  aliceRecord.items.find((it) => it.itemId === widget.id).returnedAt !== aliceRecord.items.find((it) => it.itemId === gadget.id).returnedAt,
  "the two items have distinct returnedAt timestamps, reflecting when each was actually returned"
);

// --- admin edits items on a fresh checkout: adds an 'items-updated' entry, no item-level detail needed (current items array already shows the new state) ---
r = await call(checkoutsMod, "POST", "/checkouts?lab=groomlake", {
  headers: { "x-admin-token": rootToken },
  body: { name: "Bob", email: "bob@example.com", indefinite: true, items: [{ itemId: widget.id, name: "Widget", qty: 1 }] },
});
const bobId = r.data.id;
r = await call(checkoutsMod, "PATCH", "/checkouts?lab=groomlake", {
  headers: { "x-admin-token": rootToken },
  body: { id: bobId, action: "updateItems", items: [{ itemId: widget.id, name: "Widget", qty: 3 }] },
});
assert(r.status === 200, "admin edits Bob's checkout");
const bobRecord = r.data.checkouts.find((c) => c.id === bobId);
assert(bobRecord.history.length === 2, "Bob's history now has checked-out + items-updated");
assert(bobRecord.history[1].action === "items-updated" && bobRecord.history[1].by === "root", "the edit is attributed to the admin who made it");

console.log("\n" + (failures === 0 ? "ALL CHECKOUT-HISTORY TESTS PASSED" : `${failures} TEST(S) FAILED`));
process.exit(failures === 0 ? 0 : 1);
