import { resolveAdmin, canAccessLab, isSuperadmin, isClient } from "./lib/auth.mjs";
import { labStore, labRegistryStore, sourceRequestsStore, transfersStore } from "./lib/stores.mjs";
import { resolveLab, loadLabsForRead, labsVisibleTo } from "./lib/lab-registry.mjs";
import { updateJSON, ConcurrentWriteError } from "./lib/occ.mjs";
import { checkLowStockAndNotify, availableQty } from "./lib/lowstock.mjs";
import { json, withErrorBoundary } from "./lib/http.mjs";

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function sortInventory(inventory) {
  return [...inventory].sort((a, b) =>
    (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" })
  );
}

// How much of each item is currently spoken for but hasn't actually left
// the shelf yet - a pending client source request, or a pending outgoing
// "send" transfer proposal this lab made that the destination hasn't
// accepted yet. Neither one touches qty (see source-requests.mjs and
// transfers.mjs - both are deliberately "nothing moves until someone
// actually accepts/fulfills it"), so real stock is still fully available
// to a shopper checking out right now; this is purely an informational
// heads-up for staff deciding what to do with what's left. A pending
// "request" transfer never counts here even when this lab is the source -
// it's just a named wishlist until *this* lab picks real items to fulfill
// it with, so there's no specific item to attribute the hold to yet.
async function computePendingHolds(labId) {
  const holds = new Map(); // itemId -> qty on hold
  try {
    const [requests, transfers] = await Promise.all([
      sourceRequestsStore().get("requests", { type: "json" }),
      transfersStore().get("transfers", { type: "json" }),
    ]);
    for (const r of requests || []) {
      if (r.status === "pending" && r.labId === labId) {
        holds.set(r.itemId, (holds.get(r.itemId) || 0) + r.qty);
      }
    }
    for (const t of transfers || []) {
      if (t.status === "pending" && t.direction === "send" && t.sourceLabId === labId) {
        for (const it of t.items) {
          holds.set(it.itemId, (holds.get(it.itemId) || 0) + it.qty);
        }
      }
    }
  } catch (e) {
    console.error(`inventory: computePendingHolds failed for lab "${labId}" (non-fatal, holds just won't show):`, e);
  }
  return holds;
}

// The single place role-based field-stripping happens for item data,
// rather than each endpoint growing its own copy of this logic (the drift
// that produces is exactly what an external client's data exposure can't
// afford to risk). For a "client" role - see isClient() in lib/auth.mjs -
// this is deliberately an *allowlist*, not a blocklist: a blocklist only
// protects against the fields it was written to know about, so a field
// added to the item shape later (or anything already here that's really
// just internal shorthand, like admin-authored notes or low-stock
// thresholds) would leak to an external client by default instead of by
// decision. An allowlist can't drift that way - a new field is invisible to
// a client until someone deliberately adds it here. serialNumber is
// included on purpose: a DRI needs to verify the exact physical unit
// they're requesting, same as a shopper checking one out sees. Lab/project
// identity isn't handled here at all, since it's simply never attached to a
// client-facing row in the first place (see the ?all=1 client branch
// below).
function sanitizeItemForRole(item, role) {
  if (role !== "client") return item;
  return {
    id: item.id,
    name: item.name,
    category: item.category || "",
    attribute: item.attribute || "",
    serialNumber: item.serialNumber || "",
    qty: item.qty,
    available: item.available,
  };
}

function visitorAccessOk(req, lab, admin, labId) {
  if (!lab || !lab.entryPasscode) return true; // no lab passcode set - open access
  if (canAccessLab(admin, labId)) return true; // an admin scoped to this lab always gets in
  return req.headers.get("x-lab-passcode") === lab.entryPasscode;
}

// Each item's note history lives under its own key, one per item, instead
// of embedded in the shared per-lab "inventory" blob. Notes are the
// highest-churn field in the app by far (every add/edit/delete of a single
// note used to mean a full read-modify-write of *every* item's data,
// contending with every quantity/name/category edit on the same lab, and
// with every other item's note edits too) - splitting them out means that
// churn is now fully isolated per item, which is what actually lets item
// count and concurrent-editor count scale independently of each other. See
// writeNoteHistory() below for the one narrow exception (the hasNotes
// flag).
function notesKey(itemId) {
  return `notes:${itemId}`;
}

// The client sends the *whole* desired note list on every save (same
// pattern as every other field here). Normalized server-side rather than
// trusted as-is: drop anything without real text, and make sure every
// entry has a real id/createdAt even if the client didn't set one.
function normalizeNoteHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((n) => n && typeof n.text === "string" && n.text.trim())
    .map((n) => ({
      id: typeof n.id === "string" && n.id ? n.id : crypto.randomUUID(),
      text: n.text,
      createdAt: typeof n.createdAt === "string" ? n.createdAt : new Date().toISOString(),
      ...(typeof n.updatedAt === "string" ? { updatedAt: n.updatedAt } : {}),
    }));
}

// Writes one item's note history to its own dedicated key. Only touches the
// shared "inventory" blob on a genuine 0<->nonzero transition of that
// item's `hasNotes` flag (first note ever added, or the last one removed) -
// every other call (edits, additional notes, deletes that don't zero the
// list out) never contends with quantity/name edits on this item, or with
// note edits on any other item in the lab. Returns the freshly written
// inventory array only when that transition write actually happened, so
// the caller knows whether it needs its own separate inventory read.
async function writeNoteHistory({ store, itemId, rawHistory }) {
  const currentInventory = (await store.get("inventory", { type: "json" })) || [];
  const target = currentInventory.find((i) => i.id === itemId);
  if (!target) throw new ApiError("item not found", 404);

  const normalized = normalizeNoteHistory(rawHistory);
  await updateJSON(store, notesKey(itemId), async () => normalized);

  const shouldHaveNotes = normalized.length > 0;
  let freshInventory = null;
  if (!!target.hasNotes !== shouldHaveNotes) {
    freshInventory = await updateJSON(store, "inventory", async (current) => {
      const inv = current || [];
      return inv.map((i) => (i.id === itemId ? { ...i, hasNotes: shouldHaveNotes } : i));
    });
  }

  return { noteHistory: normalized, inventory: freshInventory };
}

export default withErrorBoundary(async (req) => {
  const url = new URL(req.url);
  const labParam = url.searchParams.get("lab") || "";
  const method = req.method;

  const admin = await resolveAdmin(req);

  // Client-DRI catalog: every item across EVERY lab company-wide - a client
  // isn't "scoped" to any lab the way a labadmin is (isClient() admins
  // carry no labs[] at all), that's the whole point of the role. Checked
  // and handled entirely separately from the superadmin branch just below,
  // even though they share the same `?all=1` flag, because the two have
  // fundamentally different field-visibility rules: the superadmin branch
  // tags every row with labId/labName on purpose; this branch must never
  // let that leak - the actual security requirement this role exists to
  // satisfy - so those fields are simply never attached to a row here in
  // the first place, not stripped after the fact. See sanitizeItemForRole
  // for the exact allowlist of fields a client ever sees.
  if (method === "GET" && isClient(admin) && url.searchParams.get("all") === "1") {
    const labs = await loadLabsForRead(labRegistryStore());
    const rows = (
      await Promise.all(
        labs.map(async (lab) => {
          const labInventoryStore = labStore(lab.id);
          const [labInventory, labCheckouts] = await Promise.all([
            labInventoryStore.get("inventory", { type: "json" }),
            labInventoryStore.get("checkouts", { type: "json" }),
          ]);
          const checkouts = labCheckouts || [];
          return (labInventory || []).map((item) =>
            sanitizeItemForRole({ ...item, available: availableQty(item, checkouts) }, "client")
          );
        })
      )
    ).flat();
    rows.sort((a, b) => (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }));
    return json(rows);
  }

  // Company-wide inventory: every item across every lab a superadmin can
  // see, in one list, each tagged with which lab it belongs to. Its own
  // branch rather than something reachable via `?lab=` - it isn't scoped to
  // a single lab's access-token model at all, so it needs a superadmin
  // session outright rather than a lab passcode or access token standing in
  // for one. This fans out one read per visible lab, which is fine for an
  // admin-only, low-frequency view but would not be the right pattern for
  // anything on the shopper-facing path.
  if (method === "GET" && url.searchParams.get("all") === "1") {
    if (!isSuperadmin(admin)) {
      return json({ error: admin ? "superadmin access required" : "unauthorized" }, admin ? 403 : 401);
    }
    const labs = labsVisibleTo(await loadLabsForRead(labRegistryStore()), admin);
    const rows = (
      await Promise.all(
        labs.map(async (lab) => {
          const labInventoryStore = labStore(lab.id);
          const [labInventory, labCheckouts] = await Promise.all([
            labInventoryStore.get("inventory", { type: "json" }),
            labInventoryStore.get("checkouts", { type: "json" }),
          ]);
          const checkouts = labCheckouts || [];
          return (labInventory || []).map((item) => ({
            ...item,
            labId: lab.id,
            labName: lab.name,
            available: availableQty(item, checkouts),
          }));
        })
      )
    ).flat();
    rows.sort((a, b) => {
      const labCmp = (a.labName || "").localeCompare(b.labName || "", undefined, { sensitivity: "base" });
      return labCmp || (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" });
    });
    return json(rows);
  }

  // Resolves either the lab's unguessable access token (the normal
  // vendor-facing path) or, for an admin already scoped to it, the raw
  // internal id (keeps bookmarked/typed admin URLs working) - see
  // lib/lab-registry.mjs. Anything else, including a guessed id from
  // someone who isn't an admin on that lab, resolves to nothing.
  const lab = await resolveLab(labParam, admin);
  if (!lab) return json({ error: "locked", locked: true }, 401);
  const labId = lab.id;
  const store = labStore(labId);

  if (!visitorAccessOk(req, lab, admin, labId)) {
    return json({ error: "locked", locked: true }, 401);
  }

  if (method === "GET" && url.searchParams.get("notes")) {
    // Fetches one item's full note history - the bulk listing below only
    // ever carries a cheap `hasNotes` boolean (see writeNoteHistory), so the
    // admin UI calls this on demand when someone actually opens an item's
    // notes panel. Admin-only: the shopper-facing item cards use the
    // separate single-string `notes` field, not this history.
    if (!canAccessLab(admin, labId)) {
      return json({ error: admin ? "you don't have access to this lab" : "unauthorized" }, admin ? 403 : 401);
    }
    const itemId = url.searchParams.get("notes");
    const inv = (await store.get("inventory", { type: "json" })) || [];
    const target = inv.find((i) => i.id === itemId);
    if (!target) return json({ error: "item not found" }, 404);
    // Lazy migration path: an item saved before this split may still carry
    // its history embedded directly on the item record - fall back to that
    // if the dedicated per-item key hasn't been written yet. The next save
    // through writeNoteHistory() moves it over for good.
    const stored = await store.get(notesKey(itemId), { type: "json" });
    const history = stored ?? normalizeNoteHistory(target.noteHistory);
    return json({ itemId, noteHistory: history });
  }

  if (method === "GET") {
    const inventory = (await store.get("inventory", { type: "json" })) || [];
    const sorted = sortInventory(inventory);
    // Hold counts are a staff concern (they name a client org/other lab
    // that a shopper has no business seeing) - only attached for a caller
    // actually scoped to this lab, never for an anonymous shopper.
    if (!canAccessLab(admin, labId)) return json(sorted);
    const holds = await computePendingHolds(labId);
    return json(sorted.map((i) => ({ ...i, onHold: holds.get(i.id) || 0 })));
  }

  // every write below requires the requester to be an admin scoped to this lab.
  // 401 = no valid session at all; 403 = valid session, wrong lab scope.
  if (!canAccessLab(admin, labId)) {
    return json({ error: admin ? "you don't have access to this lab" : "unauthorized" }, admin ? 403 : 401);
  }

  const labName = lab ? lab.name : labId;

  try {
    if (method === "POST") {
      const body = await req.json();
      if (!body.name || !(body.qty > 0)) return json({ error: "name and positive qty required" }, 400);

      const newItem = {
        id: crypto.randomUUID(),
        name: body.name,
        category: body.category || "",
        qty: body.qty,
        notes: body.notes || "",
        hasNotes: false, // note history itself lives at notes:<id> - see writeNoteHistory()
        // Both free-text, optional, and purely for telling similar items
        // apart at a glance - `attribute` for a utilitarian descriptor
        // (color, brand, SKU, etc.), `serialNumber` for an individually-
        // tracked device's own identifier.
        attribute: typeof body.attribute === "string" ? body.attribute.trim() : "",
        serialNumber: typeof body.serialNumber === "string" ? body.serialNumber.trim() : "",
        lowStockThreshold: typeof body.lowStockThreshold === "number" ? body.lowStockThreshold : 0,
      };
      const writtenInventory = await updateJSON(store, "inventory", async (current) => {
        const inventory = current || [];
        return [...inventory, newItem];
      });
      // checkLowStockAndNotify is best-effort housekeeping on top of the
      // write above, which has already committed by this point - if the
      // notify step itself hits a problem (email hiccup, a second round of
      // write contention, etc.) it logs and returns null rather than
      // throwing, so we fall back to the inventory we already know is
      // correct instead of turning a successful save into a 500.
      const finalInventory = (await checkLowStockAndNotify(labId, labName, store)) || writtenInventory;
      return json(sortInventory(finalInventory));
    }

    if (method === "PUT") {
      const body = await req.json(); // { id, qty?, name?, category?, notes?, noteHistory?, lowStockThreshold?, attribute?, serialNumber? } - any subset

      // noteHistory is handled entirely separately from every other field
      // below (see writeNoteHistory) - it's the one field that no longer
      // lives in the "inventory" blob at all, specifically so its high
      // churn rate stops contending with ordinary qty/name/category edits
      // on this or any other item in the lab.
      const hasFieldUpdates = [
        "qty",
        "name",
        "category",
        "notes",
        "lowStockThreshold",
        "attribute",
        "serialNumber",
      ].some((k) => body[k] !== undefined);

      let inventorySnapshot = null;

      if (hasFieldUpdates) {
        const writtenInventory = await updateJSON(store, "inventory", async (current) => {
          const inventory = current || [];
          return inventory.map((i) => {
            if (i.id !== body.id) return i;
            const updated = { ...i };
            if (typeof body.qty === "number" && body.qty >= 0) updated.qty = body.qty;
            if (typeof body.name === "string" && body.name.trim()) updated.name = body.name.trim();
            if (typeof body.category === "string") updated.category = body.category.trim();
            if (typeof body.notes === "string") updated.notes = body.notes;
            if (typeof body.lowStockThreshold === "number" && body.lowStockThreshold >= 0) {
              updated.lowStockThreshold = body.lowStockThreshold;
            }
            if (typeof body.attribute === "string") updated.attribute = body.attribute.trim();
            if (typeof body.serialNumber === "string") updated.serialNumber = body.serialNumber.trim();
            return updated;
          });
        });
        // See the POST branch above - same best-effort fallback.
        inventorySnapshot = (await checkLowStockAndNotify(labId, labName, store)) || writtenInventory;
      }

      let responseNoteHistory;
      if (Array.isArray(body.noteHistory)) {
        const result = await writeNoteHistory({
          store,
          itemId: body.id,
          rawHistory: body.noteHistory,
        });
        responseNoteHistory = result.noteHistory;
        // Only overwrite inventorySnapshot if this call actually wrote to
        // "inventory" (the rare hasNotes 0<->nonzero transition) - otherwise
        // keep whatever the field-update branch above already produced, or
        // fall through to the plain read below.
        if (result.inventory) inventorySnapshot = result.inventory;
      }

      if (!inventorySnapshot) {
        // Neither branch above wrote to "inventory" (a noteHistory save that
        // didn't cross the hasNotes threshold, with no other fields in the
        // same request) - a plain read is enough to answer with current state.
        inventorySnapshot = (await store.get("inventory", { type: "json" })) || [];
      }

      const visibleInventory = sortInventory(inventorySnapshot);
      // Keep the response shape backward compatible for ordinary field-update
      // PUTs (every existing caller expects the array directly) - only wrap
      // it when a noteHistory write actually happened, since that's the one
      // case that needs to hand back note data alongside the inventory list.
      if (responseNoteHistory !== undefined) {
        return json({ inventory: visibleInventory, noteHistory: responseNoteHistory });
      }
      return json(visibleInventory);
    }

    if (method === "DELETE") {
      const { id } = await req.json();
      const inventory = await updateJSON(store, "inventory", async (current) => {
        const list = current || [];
        return list.filter((i) => i.id !== id);
      });
      // Best-effort cleanup of the item's now-orphaned notes:<id> key - not
      // on the critical path (the item is already gone from `inventory`
      // either way), so a failure here is logged and swallowed rather than
      // turning a successful delete into an error response.
      try {
        await store.delete(notesKey(id));
      } catch (e) {
        console.error(`inventory DELETE: failed to clean up notes key for item "${id}" (non-fatal):`, e);
      }
      return json(sortInventory(inventory));
    }
  } catch (err) {
    if (err instanceof ApiError) return json({ error: err.message }, err.status);
    if (err instanceof ConcurrentWriteError) {
      return json({ error: "too much contention updating inventory - please retry" }, 409);
    }
    throw err;
  }

  return json({ error: "method not allowed" }, 405);
});
