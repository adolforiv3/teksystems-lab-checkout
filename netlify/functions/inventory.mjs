import { resolveAdmin, canAccessLab, hasClearance, isSuperadmin, isValidClassification } from "./lib/auth.mjs";
import { labStore, labRegistryStore } from "./lib/stores.mjs";
import { resolveLab, loadLabsForRead, labsVisibleTo } from "./lib/lab-registry.mjs";
import { updateJSON, ConcurrentWriteError } from "./lib/occ.mjs";
import { checkLowStockAndNotify, availableQty } from "./lib/lowstock.mjs";
import { logClassifiedAccess, readAuditLog } from "./lib/audit.mjs";
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

// Every item has a classification tier ("standard" by default). Seeing a
// non-standard item in the ADMIN/management view requires an explicit
// clearance grant for *this specific lab* at that tier (see lib/auth.mjs's
// hasClearance) - normal lab access alone (canAccessLab) is not enough, and
// neither is being a superadmin. This is what actually enforces "shouldn't
// know about it" for staff: a classified item that fails this check is
// dropped from an admin's response entirely, not just hidden client-side.
function visibleTo(item, admin, labId) {
  const tier = item.classification || "standard";
  if (tier === "standard") return true;
  return hasClearance(admin, labId, tier);
}

// Confidential fields stripped out for a caller browsing without clearance,
// rather than hiding the item outright - see filterVisible() below for why
// classified items are checkout-visible to anonymous shoppers now, even
// though the admin-management view above still requires real clearance to
// see one exist at all. Right now that's just the serial number (an
// individual-device identifier, never meant to leave the admin side) and
// the exact tier label - a shopper only ever learns "restricted", never
// "black" vs "ultraBlack".
function sanitizeForCheckout(item) {
  const tier = item.classification || "standard";
  if (tier === "standard") return item;
  const { serialNumber, classification, ...rest } = item;
  return { ...rest, restricted: true };
}

// POST/PUT/DELETE all still require canAccessLab further down regardless of
// what this returns, so it only ever governs what a caller can *see* here,
// never what they can modify - the actual "cannot change or modify a
// restricted item" guarantee comes from the per-tier hasClearance re-checks
// inside each write branch below, which apply no matter what GET returns.
function filterVisible(inventory, admin, labId) {
  if (admin) {
    // Authenticated admin session (of any kind, including one scoped to a
    // different lab or holding no clearance at all): unchanged "need to
    // know" model - an admin who isn't individually cleared for this item's
    // tier doesn't see it exist, management view included.
    return inventory.filter((i) => visibleTo(i, admin, labId));
  }
  // Anonymous/checkout context - the shopper-facing item grid and cart.
  // Classified devices are now checkout-visible to anyone holding the lab's
  // link, same as any other item: clearance was always an admin-only
  // credential a shopper could never hold, so gating *visibility* on it
  // would make these devices impossible to ever hand out to someone
  // traveling with one. Actually checking one out still requires either
  // admin clearance or the lab's release passcode - see checkouts.mjs's
  // POST handler - this only controls what shows up to browse/add to cart.
  return inventory.map((i) => sanitizeForCheckout(i));
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
async function writeNoteHistory({ store, labId, admin, itemId, rawHistory, actor }) {
  const currentInventory = (await store.get("inventory", { type: "json" })) || [];
  const target = currentInventory.find((i) => i.id === itemId);
  if (!target) throw new ApiError("item not found", 404);
  const tier = target.classification || "standard";
  // Same "item not found" (never 403) leak-prevention pattern as every
  // other classified-item operation - a caller without clearance for this
  // item's tier can't even confirm it exists by probing its notes.
  if (tier !== "standard" && !hasClearance(admin, labId, tier)) {
    throw new ApiError("item not found", 404);
  }

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
  if (tier !== "standard") {
    await logClassifiedAccess(store, {
      action: "notes-update",
      itemId,
      itemName: target.name,
      tier,
      actor,
    });
  }

  return { noteHistory: normalized, inventory: freshInventory };
}

export default withErrorBoundary(async (req) => {
  const url = new URL(req.url);
  const labParam = url.searchParams.get("lab") || "";
  const method = req.method;

  const admin = await resolveAdmin(req);

  // Company-wide inventory: every item across every lab a superadmin can
  // see, in one list, each tagged with which lab it belongs to. Its own
  // branch rather than something reachable via `?lab=` - it isn't scoped to
  // a single lab's access-token model at all, so it needs a superadmin
  // session outright rather than a lab passcode or access token standing in
  // for one. `labsVisibleTo` already excludes any lab carrying its own
  // lab-level classification tier the superadmin isn't cleared for (see
  // lib/lab-registry.mjs), and `filterVisible` below re-applies the same
  // item-level clearance check inside each lab that a normal per-lab GET
  // would - so this view can never surface an item the same admin couldn't
  // already see by opening that lab directly. This fans out one read per
  // visible lab, which is fine for an admin-only, low-frequency view but
  // would not be the right pattern for anything on the shopper-facing path.
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
          return filterVisible(labInventory || [], admin, lab.id).map((item) => ({
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

  if (method === "GET" && url.searchParams.get("auditLog") === "1") {
    // The classified-access audit trail is itself sensitive - readable only
    // by an admin holding *some* clearance in this lab (black or
    // ultraBlack), same gate as seeing a classified item in the first
    // place. A normal lab admin with no clearance, or an uncleared
    // superadmin, gets treated the same as an unscoped visitor here.
    if (!hasClearance(admin, labId, "black")) {
      return json({ error: admin ? "you don't have access to this lab" : "unauthorized" }, admin ? 403 : 401);
    }
    const log = await readAuditLog(store);
    return json(log.slice().reverse()); // most recent first
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
    const tier = target.classification || "standard";
    if (tier !== "standard" && !hasClearance(admin, labId, tier)) {
      return json({ error: "item not found" }, 404);
    }
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
    // Classified items are dropped here, server-side, before the array is
    // ever serialized - a non-cleared caller's response simply doesn't
    // contain them, the same as if they didn't exist.
    return json(sortInventory(filterVisible(inventory, admin, labId)));
  }

  // every write below requires the requester to be an admin scoped to this lab.
  // 401 = no valid session at all; 403 = valid session, wrong lab scope.
  if (!canAccessLab(admin, labId)) {
    return json({ error: admin ? "you don't have access to this lab" : "unauthorized" }, admin ? 403 : 401);
  }

  const labName = lab ? lab.name : labId;
  const actor = admin && admin.username ? admin.username : admin ? admin.id : "unknown";

  try {
    if (method === "POST") {
      const body = await req.json();
      if (!body.name || !(body.qty > 0)) return json({ error: "name and positive qty required" }, 400);

      const classification =
        typeof body.classification === "string" && body.classification ? body.classification : "standard";
      if (!isValidClassification(classification)) {
        return json({ error: "invalid classification tier" }, 400);
      }
      // Creating a classified item requires the same clearance as viewing
      // one - you can't stash something in a compartment you don't
      // yourself have access to.
      if (classification !== "standard" && !hasClearance(admin, labId, classification)) {
        return json({ error: `insufficient clearance to create a "${classification}" item in this lab` }, 403);
      }

      const newItem = {
        id: crypto.randomUUID(),
        name: body.name,
        category: body.category || "",
        qty: body.qty,
        notes: body.notes || "",
        hasNotes: false, // note history itself lives at notes:<id> - see writeNoteHistory()
        classification,
        // Free-text device identifier (serial number, asset tag, etc.) -
        // mainly meant for individually-tracked black/ultraBlack devices
        // (the frontend only surfaces the field for those), but not
        // restricted server-side since a standard item having one is
        // harmless. No confidentiality logic needed here specifically: it's
        // just another field on the item record, so it's already covered by
        // the same classification filter that drops the whole item for an
        // uncleared caller (see filterVisible/visibleTo above).
        serialNumber: typeof body.serialNumber === "string" ? body.serialNumber.trim() : "",
        lowStockThreshold: typeof body.lowStockThreshold === "number" ? body.lowStockThreshold : 0,
      };
      const writtenInventory = await updateJSON(store, "inventory", async (current) => {
        const inventory = current || [];
        return [...inventory, newItem];
      });
      if (classification !== "standard") {
        await logClassifiedAccess(store, {
          action: "create",
          itemId: newItem.id,
          itemName: newItem.name,
          tier: classification,
          actor,
        });
      }
      // checkLowStockAndNotify is best-effort housekeeping on top of the
      // write above, which has already committed by this point - if the
      // notify step itself hits a problem (email hiccup, a second round of
      // write contention, etc.) it logs and returns null rather than
      // throwing, so we fall back to the inventory we already know is
      // correct instead of turning a successful save into a 500.
      const finalInventory = (await checkLowStockAndNotify(labId, labName, store)) || writtenInventory;
      return json(sortInventory(filterVisible(finalInventory, admin, labId)));
    }

    if (method === "PUT") {
      const body = await req.json(); // { id, qty?, name?, category?, notes?, noteHistory?, lowStockThreshold?, classification? } - any subset
      if (body.classification !== undefined && !isValidClassification(body.classification)) {
        return json({ error: "invalid classification tier" }, 400);
      }

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
        "classification",
        "serialNumber",
      ].some((k) => body[k] !== undefined);

      let inventorySnapshot = null;

      if (hasFieldUpdates) {
        let touchedClassification = null; // set inside the mutator once we know the item's real tier(s)
        const writtenInventory = await updateJSON(store, "inventory", async (current) => {
          const inventory = current || [];
          const target = inventory.find((i) => i.id === body.id);
          // A caller without clearance for this item's *current* tier gets
          // treated exactly like the item doesn't exist - re-checked fresh on
          // every retry attempt in case clearance changed mid-flight. This is
          // the load-bearing check: without it, an admin who merely has
          // normal lab access could still edit/delete a classified item they
          // were never supposed to be able to see, purely by guessing its id.
          if (target && (target.classification || "standard") !== "standard") {
            if (!hasClearance(admin, labId, target.classification)) {
              throw new ApiError("item not found", 404);
            }
          }
          // Reclassifying also requires clearance for the *new* tier -
          // otherwise a cleared admin could hand a classified item off to a
          // tier they don't actually hold themselves.
          if (
            body.classification !== undefined &&
            body.classification !== "standard" &&
            !hasClearance(admin, labId, body.classification)
          ) {
            throw new ApiError(`insufficient clearance to reclassify an item as "${body.classification}"`, 403);
          }

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
            if (typeof body.serialNumber === "string") updated.serialNumber = body.serialNumber.trim();
            if (body.classification !== undefined) updated.classification = body.classification;
            touchedClassification = updated.classification || "standard";
            return updated;
          });
        });
        if (touchedClassification && touchedClassification !== "standard") {
          await logClassifiedAccess(store, {
            action: "update",
            itemId: body.id,
            tier: touchedClassification,
            actor,
          });
        }
        // See the POST branch above - same best-effort fallback.
        inventorySnapshot = (await checkLowStockAndNotify(labId, labName, store)) || writtenInventory;
      }

      let responseNoteHistory;
      if (Array.isArray(body.noteHistory)) {
        const result = await writeNoteHistory({
          store,
          labId,
          admin,
          itemId: body.id,
          rawHistory: body.noteHistory,
          actor,
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

      const visibleInventory = sortInventory(filterVisible(inventorySnapshot, admin, labId));
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
      let deletedTier = null;
      const inventory = await updateJSON(store, "inventory", async (current) => {
        const list = current || [];
        const target = list.find((i) => i.id === id);
        if (target && (target.classification || "standard") !== "standard") {
          if (!hasClearance(admin, labId, target.classification)) {
            throw new ApiError("item not found", 404);
          }
          deletedTier = target.classification;
        }
        return list.filter((i) => i.id !== id);
      });
      if (deletedTier) {
        await logClassifiedAccess(store, { action: "delete", itemId: id, tier: deletedTier, actor });
      }
      // Best-effort cleanup of the item's now-orphaned notes:<id> key - not
      // on the critical path (the item is already gone from `inventory`
      // either way), so a failure here is logged and swallowed rather than
      // turning a successful delete into an error response.
      try {
        await store.delete(notesKey(id));
      } catch (e) {
        console.error(`inventory DELETE: failed to clean up notes key for item "${id}" (non-fatal):`, e);
      }
      return json(sortInventory(filterVisible(inventory, admin, labId)));
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
