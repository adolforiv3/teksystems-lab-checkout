import { resolveAdmin, canAccessLab, isSuperadmin, isClient, loadAdmins, findByUsername } from "./lib/auth.mjs";
import { labStore, sourceRequestsStore, labRegistryStore } from "./lib/stores.mjs";
import { loadLabsForRead } from "./lib/lab-registry.mjs";
import { updateJSON, ConcurrentWriteError } from "./lib/occ.mjs";
import { sendEmail } from "./lib/email.mjs";
import { json, withErrorBoundary } from "./lib/http.mjs";

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// Best-effort - never blocks the actual request/resolution, same principle
// as transfers.mjs's notifyLab and lib/lowstock.mjs's notifier.
async function notifyLabAdmins(labId, labName, subject, text) {
  try {
    const admins = await loadAdmins();
    const recipients = admins.filter((a) => {
      if (!a.email) return false;
      return a.role === "superadmin" || (a.labs || []).includes(labId);
    });
    for (const admin of recipients) {
      await sendEmail({ to: admin.email, subject, text, fromName: `${labName} Supply Checkout` });
    }
  } catch (e) {
    console.error(`source-requests: notification email failed for lab "${labId}" (non-fatal):`, e);
  }
}

// A client's own account may or may not carry an email (same optional field
// every admin account has) - if it does, let them know their request was
// acted on rather than making them come back and check "My Requests" cold.
async function notifyClient(clientUsername, subject, text) {
  try {
    const admins = await loadAdmins();
    const target = findByUsername(admins, clientUsername);
    if (!target || !target.email) return;
    await sendEmail({ to: target.email, subject, text, fromName: "Lab Supply Checkout" });
  } catch (e) {
    console.error(`source-requests: client notification email failed for "${clientUsername}" (non-fatal):`, e);
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

      await notifyLabAdmins(
        foundLab.id,
        foundLab.name,
        `Source request — ${foundItem.name} × ${body.qty}`,
        `${record.clientOrg ? `Client org ${record.clientOrg}` : "A client"} requested ${body.qty} × "${foundItem.name}" from ${foundLab.name}.\n\n` +
          (note ? `Note: ${note}\n\n` : "") +
          `Review it from the Source Requests section in the admin panel.`
      );

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

      let resolvedRecord = null; // set inside the mutator on whichever attempt actually wins
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
        resolvedRecord = {
          ...r,
          status: action === "fulfill" ? "fulfilled" : "declined",
          resolvedBy: actor,
          resolvedAt: nowIso,
          history: [...r.history, { at: nowIso, action, by: actor, note }],
        };
        next[idx] = resolvedRecord;
        return next;
      });

      await notifyClient(
        resolvedRecord.clientUsername,
        `Source request ${action === "fulfill" ? "fulfilled" : "declined"} — ${resolvedRecord.itemName}`,
        `Your request for ${resolvedRecord.qty} × "${resolvedRecord.itemName}" was ${action === "fulfill" ? "fulfilled" : "declined"} by ${actor}.\n\n` +
          (note ? `Note: ${note}\n\n` : "") +
          `See it in the Client Portal under "My Requests".`
      );

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
