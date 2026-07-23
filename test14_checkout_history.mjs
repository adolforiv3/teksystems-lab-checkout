// Dedicated coverage for the checkout history/trail feature: every
// checkout record now carries a `history` array recording when it was
// checked out and every subsequent return/edit event, so "when was this
// actually checked out" stays answerable long after the status badge just
// says "returned". Also verifies the trail's item references get the same
// classification-based confidentiality filtering as the top-level `items`
// array - a history entry is not a backdoor around clearance.
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

// --- confidentiality: a history entry referencing ONLY a classified item is invisible to an uncleared admin ---
r = await call(adminsMod, "POST", "/admins", { headers: { "x-admin-token": rootToken }, body: { username: "labtech", password: "labtechpw1", role: "labadmin", labs: ["groomlake"] } });
r = await call(adminAuthMod, "POST", "/admin-auth", { body: { action: "login", username: "labtech", password: "labtechpw1" } });
const labtechToken = r.data.token;

const rootAdmins = await call(adminsMod, "GET", "/admins", { headers: { "x-admin-token": rootToken } });
const rootId = rootAdmins.data.find((a) => a.username === "root").id;
await call(adminsMod, "PATCH", "/admins", { headers: { "x-admin-token": rootToken }, body: { id: rootId, grantClearance: { labId: "groomlake", tier: "black" } } });

r = await call(inventoryMod, "POST", "/inventory?lab=groomlake", { headers: { "x-admin-token": rootToken }, body: { name: "Secret Device", qty: 5, classification: "black" } });
const secretDevice = r.data.find((i) => i.name === "Secret Device");

r = await call(checkoutsMod, "POST", "/checkouts?lab=groomlake", {
  headers: { "x-admin-token": rootToken },
  body: { name: "Carol", email: "carol@example.com", indefinite: true, items: [{ itemId: secretDevice.id, name: "Secret Device", qty: 1 }] },
});
assert(r.status === 201, "cleared root checks out a classified-only item for Carol");
const carolId = r.data.id;

// An uncleared admin can't even see the record at all (existing behavior - a checkout made up
// entirely of items they're not cleared for has zero visible items, so the whole record drops).
r = await call(checkoutsMod, "GET", "/checkouts?lab=groomlake", { headers: { "x-admin-token": labtechToken } });
assert(!r.data.some((c) => c.id === carolId), "uncleared labtech can't see Carol's all-classified checkout at all - top-level filtering unchanged");

// A cleared admin sees the full record AND its history, including the classified item's name.
r = await call(checkoutsMod, "GET", "/checkouts?lab=groomlake", { headers: { "x-admin-token": rootToken } });
const carolRecord = r.data.find((c) => c.id === carolId);
assert(!!carolRecord, "cleared root sees Carol's checkout");
assert(carolRecord.history[0].items[0].name === "Secret Device", "cleared root sees the classified item's real name in the history trail");

// --- mixed checkout (one classified + one standard item): the record stays visible to an
//     uncleared admin (thanks to the standard item), but the history entry's item list is
//     redacted down to just the standard item - a *partial* redaction within one entry, not
//     the all-or-nothing "whole record disappears" case tested above. ---
r = await call(checkoutsMod, "POST", "/checkouts?lab=groomlake", {
  headers: { "x-admin-token": rootToken },
  body: {
    name: "Dana",
    email: "dana@example.com",
    indefinite: true,
    items: [
      { itemId: secretDevice.id, name: "Secret Device", qty: 1 },
      { itemId: widget.id, name: "Widget", qty: 1 },
    ],
  },
});
const danaId = r.data.id;

r = await call(checkoutsMod, "GET", "/checkouts?lab=groomlake", { headers: { "x-admin-token": labtechToken } });
const danaAsUncleared = r.data.find((c) => c.id === danaId);
assert(!!danaAsUncleared, "uncleared labtech CAN see Dana's checkout - it has a standard item too");
assert(danaAsUncleared.items.length === 1 && danaAsUncleared.items[0].itemId === widget.id, "top-level items: only the widget, secret device dropped");
assert(danaAsUncleared.history.length === 1, "still one history entry (the checked-out event)");
assert(
  danaAsUncleared.history[0].items.length === 1 && danaAsUncleared.history[0].items[0].itemId === widget.id,
  "that entry's item list is ALSO redacted down to just the widget - the classified device never appears in the uncleared admin's history view either"
);

r = await call(checkoutsMod, "GET", "/checkouts?lab=groomlake", { headers: { "x-admin-token": rootToken } });
const danaAsCleared = r.data.find((c) => c.id === danaId);
assert(danaAsCleared.history[0].items.length === 2, "the cleared admin sees both items in the same history entry - nothing hidden from them");

console.log("\n" + (failures === 0 ? "ALL CHECKOUT-HISTORY TESTS PASSED" : `${failures} TEST(S) FAILED`));
process.exit(failures === 0 ? 0 : 1);
