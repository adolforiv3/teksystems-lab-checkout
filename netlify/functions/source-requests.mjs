import { resolveAdmin, canAccessLab, isSuperadmin, isClient } from "./lib/auth.mjs";
import { labStore, sourceRequestsStore, labRegistryStore } from "./lib/stores.mjs";
import { loadLabsForRead } from "./lib/lab-registry.mjs";
import { updateJSON, ConcurrentWriteError } from "./lib/occ.mjs";
import { json, withErrorBoundary } from "./lib/http.mjs";

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// A client's claim on an item, not a stock mutation - deliberately just a
// record for staff to act on through the normal checkout flow whenever
// they get to it (per the "request record only" design: nothing here ever
// touches an item's qty). `labId`/`labName` are captured at creation time
// so staff can actually go find the thing, but that's exactly the field a
// client must never see back - see viewForRole() below, the one place that
// distinction is enforced, mirroring sanitizeItemForRole's role in
// inventory.mjs.
function viewForRole(reqRecord, admin) {
  if (isClient(admin)) {
    const { labId, labName, clientOrg, clientUsername, ...rest } = reqRecord;
    return rest;
  }
  return reqRecord;
}

// client: only requests from their own org (not other clients' - the
//   spec's "not viewable by other client DRIs" requirement, scoped by org
//   rather than by individual account in case an org ever has more than
//   one DRI).
// labadmin: only requests against an item in a lab they manage.
// superadmin: everything.
function visibleTo(reqRecord, admin) {
  if (isClient(admin)) return reqRecord.clientOrg === admin.clientOrg;
  if (isSuperadmin(admin)) return true;
  return canAccessLab(admin, reqRecord.labId);
}

export default withErrorBoundary(async (req) => {
  const method = req.method;
  const admin = await resolveAdmin(req);
  if (!admin) return json({ error: "unauthorized" }, 401);

  const store = sourceRequestsStore();

  if (method === "GET") {
    const list = (await store.get("requests", { type: "json" })) || [];
    const visible = list.filter((r) => visibleTo(r, admin));
    visible.sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));
    return json(visible.map((r) => viewForRole(r, admin)));
  }

  try {
    if (method === "POST") {
      // Client DRIs only - this is the one write action their role has at
      // all (see the spec this role came from: "does not directly edit
      // inventory - creates a request record for Company A to fulfill").
      if (!isClient(admin)) {
        return json({ error: "client account required" }, 403);
      }
      const body = await req.json(); // { itemId, qty, note? }
      if (typeof body.itemId !== "string" || !body.itemId) {
        return json({ error: "itemId required" }, 400);
      }
      if (!(typeof body.qty === "number" && body.qty > 0)) {
        return json({ error: "a positive qty is required" }, 400);
      }
      const note = typeof body.note === "string" ? body.note.trim() : "";

      // The client never told us (and never could - see inventory.mjs's
      // client catalog branch, which never attaches lab identity to a row)
      // which lab this item actually lives in, so it's resolved here by
      // scanning every lab's inventory for a matching id. Fine for a
      // client-initiated, low-frequency write; not a pattern to repeat on
      // anything shopper-facing.
      const labs = await loadLabsForRead(labRegistryStore());
      let foundLab = null;
      let foundItem = null;
      for (const lab of labs) {
        const inv = (await labStore(lab.id).get("inventory", { type: "json" })) || [];
        const item = inv.find((i) => i.id === body.itemId);
        if (item) {
          foundLab = lab;
          foundItem = item;
          break;
        }
      }
      if (!foundItem) return json({ error: "item not found" }, 404);

      const nowIso = new Date().toISOString();
      const record = {
        id: crypto.randomUUID(),
        itemId: foundItem.id,
        itemName: foundItem.name,
        qty: body.qty,
        labId: foundLab.id,
        labName: foundLab.name,
        clientOrg: admin.clientOrg || "",
        clientUsername: admin.username || admin.id,
        status: "pending",
        note,
        requestedAt: nowIso,
        history: [{ at: nowIso, action: "requested", by: admin.username || admin.id, note }],
      };
      const list = await updateJSON(store, "requests", async (current) => [...(current || []), record]);
      return json(list.filter((r) => visibleTo(r, admin)).map((r) => viewForRole(r, admin)), 201);
    }

    if (method === "PATCH") {
      // Staff-only (superadmin, or a labadmin scoped to the lab this
      // request's item actually lives in) - a client can see their own
      // requests but never resolves them.
      const body = await req.json(); // { id, action: "fulfill"|"decline", note? }
      const { id, action } = body;
      if (action !== "fulfill" && action !== "decline") {
        return json({ error: "action must be 'fulfill' or 'decline'" }, 400);
      }
      const actor = admin.username || admin.id;
      const note = typeof body.note === "string" ? body.note.trim() : "";

      const list = await updateJSON(store, "requests", async (current) => {
        const arr = current || [];
        const idx = arr.findIndex((r) => r.id === id);
        if (idx === -1) throw new ApiError("source request not found", 404);
        const r = arr[idx];
        if (!isSuperadmin(admin) && !canAccessLab(admin, r.labId)) {
          throw new ApiError("you don't have access to the lab this request is against", 403);
        }
        if (r.status !== "pending") throw new ApiError("this request has already been resolved", 400);
        const nowIso = new Date().toISOString();
        const next = [...arr];
        next[idx] = {
          ...r,
          status: action === "fulfill" ? "fulfilled" : "declined",
          resolvedBy: actor,
          resolvedAt: nowIso,
          history: [...r.history, { at: nowIso, action, by: actor, note }],
        };
        return next;
      });
      return json(list.filter((r) => visibleTo(r, admin)).map((r) => viewForRole(r, admin)));
    }
  } catch (err) {
    if (err instanceof ApiError) return json({ error: err.message }, err.status);
    if (err instanceof ConcurrentWriteError) {
      return json({ error: "too much contention on source requests - please retry" }, 409);
    }
    throw err;
  }

  return json({ error: "method not allowed" }, 405);
});
