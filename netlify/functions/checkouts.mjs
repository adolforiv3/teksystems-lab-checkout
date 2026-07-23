import { resolveAdmin, canAccessLab, hasClearance } from "./lib/auth.mjs";
import { labStore } from "./lib/stores.mjs";
import { resolveLab } from "./lib/lab-registry.mjs";
import { updateJSON, ConcurrentWriteError } from "./lib/occ.mjs";
import { sendEmail } from "./lib/email.mjs";
import { checkLowStockAndNotify, availableQty } from "./lib/lowstock.mjs";
import { json, withErrorBoundary } from "./lib/http.mjs";

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// Wraps an updateJSON() call and turns our coded errors into HTTP
// responses, so every PATCH/POST branch below doesn't have to repeat the
// same try/catch. `value` is only set when the write actually succeeded.
async function runMutation(fn) {
  try {
    return { value: await fn() };
  } catch (err) {
    if (err instanceof ApiError) return { errorResponse: json({ error: err.message }, err.status) };
    if (err instanceof ConcurrentWriteError) {
      return { errorResponse: json({ error: "too much contention on this checkout log - please retry" }, 409) };
    }
    throw err;
  }
}

async function sendCheckoutEmail(record, { assignedByAdmin, updated, labName }) {
  if (!record.email) return { sent: false, reason: "no email on record" };

  const displayLab = labName || record.labName || "Lab Supply Checkout";

  const itemLines = record.items.map((it) => `  • ${it.name} × ${it.qty}`).join("\n");
  const returnLine = record.indefinite
    ? "No return needed (indefinite / consumable)."
    : record.returnDate
    ? `Please return by: ${record.returnDate}`
    : "No return date set.";

  const intro = updated
    ? "Your supply checkout has been updated. Here's what's currently assigned to you:"
    : assignedByAdmin
    ? "A lab admin has assigned you the following supplies:"
    : "You've checked out the following supplies:";

  const subject = updated
    ? `Updated supply checkout — ${displayLab}`
    : assignedByAdmin
    ? `Supplies assigned to you — ${displayLab}`
    : `Supply checkout confirmation — ${displayLab}`;

  const text = `Hi ${record.name},\n\n${intro}\n\n${itemLines}\n\n${returnLine}\n\nQuestions? Reach out to your lab admin.\n\n— ${displayLab} Supply Checkout`;

  return sendEmail({ to: record.email, subject, text, fromName: `${displayLab} Supply Checkout` });
}

function visitorAccessOk(req, lab, admin, labId) {
  if (!lab || !lab.entryPasscode) return true; // no lab passcode set - open access
  if (canAccessLab(admin, labId)) return true; // an admin scoped to this lab always gets in
  return req.headers.get("x-lab-passcode") === lab.entryPasscode;
}

// A checkout record's line items reference inventory items by id, and
// currently carry that item's *name* directly on the record too (so the
// checkout log still reads sensibly even after an item is later renamed or
// deleted). For an authenticated ADMIN who isn't individually cleared for a
// classified item's tier, that name is filtered here the same way
// inventory.mjs filters the inventory list itself - the internal
// need-to-know model among staff is unchanged. For an anonymous/shopper
// caller (admin === null), classified line items are now included the same
// as standard ones - restricted devices are checkout-visible to shoppers
// (see inventory.mjs's sanitizeForCheckout), and the frontend needs this
// endpoint's data to correctly compute how much of one is still available
// (see reindexCheckouts() client-side). A record left with zero visible
// items (every line filtered out for an uncleared admin) is dropped
// entirely, so its mere existence doesn't leak to staff who shouldn't know
// about it either.
function itemVisible(itemId, classById, admin, labId) {
  const tier = classById.get(itemId) || "standard";
  if (tier === "standard") return true;
  if (!admin) return true;
  return hasClearance(admin, labId, tier);
}

// The history trail (see the POST/PATCH branches below) carries the same
// kind of item references the top-level `items` array does - so it needs
// the exact same per-item confidentiality filter, not just the checkout
// record as a whole. Without this, an uncleared admin could still learn
// that a classified item existed and when it was returned just by opening
// a checkout's history, even with the top-level `items` array itself
// correctly filtered. A history entry that references specific items
// (returned/self-returned) is dropped entirely if none of its items remain
// visible; a record-level entry with no item references (checked-out,
// items-updated) is always kept, since its visibility already rides on the
// record surviving the `items.length > 0` filter below.
function filterHistory(history, classById, admin, labId) {
  if (!Array.isArray(history)) return [];
  return history
    .map((entry) => {
      if (!Array.isArray(entry.items)) return entry;
      const items = entry.items.filter((it) => itemVisible(it.itemId, classById, admin, labId));
      return { ...entry, items };
    })
    .filter((entry) => !Array.isArray(entry.items) || entry.items.length > 0);
}

async function visibleCheckouts(list, admin, labId, store) {
  const inventory = (await store.get("inventory", { type: "json" })) || [];
  const classById = new Map(inventory.map((i) => [i.id, i.classification || "standard"]));
  return list
    .map((c) => {
      const items = c.items.filter((it) => itemVisible(it.itemId, classById, admin, labId));
      const history = filterHistory(c.history, classById, admin, labId);
      return { ...c, items, history };
    })
    .filter((c) => c.items.length > 0);
}

// Best-effort "attach the send result to the record" patch. This runs
// *after* the authoritative write already succeeded, purely to annotate
// the record for the admin UI - if it loses a rare race, the checkout data
// itself is already safe, so we swallow errors here rather than fail the
// whole request over a cosmetic field.
async function annotateLastEmail(store, id, lastEmail) {
  try {
    return await updateJSON(store, "checkouts", async (current) => {
      const list = current || [];
      return list.map((c) => (c.id === id ? { ...c, lastEmail } : c));
    });
  } catch {
    return null;
  }
}

export default withErrorBoundary(async (req) => {
  const url = new URL(req.url);
  const labParam = url.searchParams.get("lab") || "";
  const method = req.method;

  const requester = await resolveAdmin(req);
  // See inventory.mjs / lib/lab-registry.mjs - resolves either the lab's
  // unguessable access token, or (for an admin already scoped to it) the
  // raw internal id.
  const lab = await resolveLab(labParam, requester);
  if (!lab) return json({ error: "locked", locked: true }, 401);
  const labId = lab.id;
  const store = labStore(labId);
  const isAdminForLab = canAccessLab(requester, labId);
  const labName = lab.name || labId;

  if (!visitorAccessOk(req, lab, requester, labId)) {
    return json({ error: "locked", locked: true }, 401);
  }

  if (method === "GET") {
    const checkouts = (await store.get("checkouts", { type: "json" })) || [];
    return json(await visibleCheckouts(checkouts, requester, labId, store));
  }

  if (method === "POST") {
    // anyone can submit a checkout - this is the public "confirm checkout" action,
    // OR an admin (scoped to this lab) submitting on someone else's behalf
    const body = await req.json();
    if (!body.name || !body.email || !Array.isArray(body.items) || body.items.length === 0) {
      return json({ error: "name, email, and items required" }, 400);
    }

    // admins may backdate a checkout (e.g. supplies that were checked out before this
    // system existed); regular self-checkout always uses the current server time
    let createdAt = new Date().toISOString();
    if (isAdminForLab && body.checkedOutAt) {
      const parsed = new Date(body.checkedOutAt);
      if (!isNaN(parsed.getTime())) createdAt = parsed.toISOString();
    }

    // A cart line optionally carries which kit it was quick-added from (see
    // the shopper/assign-supplies UI) - captured here as a snapshot on the
    // item line itself, same reasoning as capturing `name`: so a kit that's
    // later renamed or deleted doesn't erase the context of what someone
    // was actually issued, and so the missing-items log (see the
    // reportMissing action below) can show "this was part of Field Repair
    // Kit" without having to cross-reference the live kits list.
    const items = body.items.map((it) => ({
      itemId: it.itemId,
      name: it.name,
      qty: it.qty,
      returned: false,
      ...(typeof it.kitId === "string" && it.kitId ? { kitId: it.kitId, kitName: it.kitName || "" } : {}),
    }));
    const actor = isAdminForLab && requester ? requester.username || requester.id : undefined;
    const record = {
      id: crypto.randomUUID(),
      name: body.name,
      email: body.email,
      indefinite: !!body.indefinite,
      returnDate: body.indefinite ? null : body.returnDate,
      createdAt,
      assignedByAdmin: isAdminForLab,
      labName: body.labName || "",
      items,
      // The full event trail for this checkout - see visibleCheckouts()
      // above for why item references in here get the same
      // classification-based filtering as the top-level `items` array does.
      // This is what actually answers "when was this checked out" once a
      // checkout's current status has moved on to "returned" - the
      // top-level `createdAt` never changes, but it's easy to lose track of
      // once the badge just says "returned".
      history: [
        {
          at: createdAt,
          action: "checked-out",
          by: actor,
          items: items.map((it) => ({ itemId: it.itemId, name: it.name, qty: it.qty })),
        },
      ],
    };

    const { errorResponse } = await runMutation(() =>
      updateJSON(store, "checkouts", async (current) => {
        const checkouts = current || [];

        // Checking a classified item OUT requires either admin clearance for
        // its tier, or the lab's current release passcode - the "yes, you
        // can take this restricted device" step. Unlike inventory.mjs's
        // *visibility* rule (classified items are now shown to any
        // shopper), this is the actual authorization gate for walking out
        // with one, and it applies to *everyone*, admins included: an
        // uncleared superadmin needs the code exactly like a shopper does.
        // Checked fresh every retry attempt in case clearance or the code
        // changes mid-flight. No "item not found" masking here (unlike
        // inventory.mjs's PUT/DELETE) - the item's existence is no longer a
        // secret from this caller, since they could already see it in the
        // grid; the error just explains what's still missing.
        const inventoryForClearance = (await store.get("inventory", { type: "json" })) || [];
        const releaseCodeOk =
          !!lab.classifiedReleaseCode &&
          typeof body.releaseCode === "string" &&
          body.releaseCode === lab.classifiedReleaseCode;
        for (const reqItem of record.items) {
          const invItem = inventoryForClearance.find((i) => i.id === reqItem.itemId);
          const tier = invItem ? invItem.classification || "standard" : "standard";
          if (tier !== "standard" && !hasClearance(requester, labId, tier) && !releaseCodeOk) {
            throw new ApiError(
              lab.classifiedReleaseCode
                ? "a valid release passcode is required to check out a restricted item"
                : "this lab hasn't set a release passcode yet - ask an admin to set one before checking out a restricted item",
              403
            );
          }
        }

        // The client only ever saw a snapshot of "available" stock from
        // whenever it last loaded the page - by the time this request
        // lands, someone else may have taken the last one. This check runs
        // fresh on every retry attempt (inventory + checkouts are both
        // re-read each time), so it's checking real current state, not
        // what the shopper's browser thought was true a minute ago.
        // Admins keep the ability to over-allocate deliberately (e.g.
        // logging historical/backdated checkouts), matching the existing
        // backdating privilege above.
        if (!isAdminForLab) {
          const inventory = inventoryForClearance;
          for (const reqItem of record.items) {
            const invItem = inventory.find((i) => i.id === reqItem.itemId);
            const available = invItem ? availableQty(invItem, checkouts) : 0;
            if (reqItem.qty > available) {
              throw new ApiError(`not enough "${reqItem.name}" available (${available} left)`, 409);
            }
          }
        }

        return [...checkouts, record];
      })
    );
    if (errorResponse) return errorResponse;

    // Only send the confirmation email once the checkout is durably
    // committed and validated - never before, so a rejected/oversold
    // request can't still result in a "you're all set!" email going out.
    const emailResult = await sendCheckoutEmail(record, { assignedByAdmin: isAdminForLab, labName: body.labName });
    const lastEmail = { ...emailResult, sentAt: new Date().toISOString() };
    await annotateLastEmail(store, record.id, lastEmail);

    await checkLowStockAndNotify(labId, labName, store);
    return json({ ...record, lastEmail, email_notification: emailResult }, 201);
  }

  if (method === "PATCH") {
    const body = await req.json(); // { id, action? } - action: "returnItems" | "resendEmail" | "updateItems" | default (mark returned, admin only)
    const { id, action } = body;

    if (action === "returnItems") {
      // Self-service return - anyone can call this, no admin needed. The
      // only gate is that the caller has to know the email the checkout was
      // made under (keeps a random visitor from returning someone else's
      // stuff by guessing an id), matching how self-checkout itself works.
      const requesterEmail = (body.email || "").trim().toLowerCase();
      const { value, errorResponse } = await runMutation(() =>
        updateJSON(store, "checkouts", async (current) => {
          const list = current || [];
          const idx = list.findIndex((c) => c.id === id);
          if (idx === -1) throw new ApiError("checkout not found", 404);
          const record = list[idx];
          if (!requesterEmail || (record.email || "").toLowerCase() !== requesterEmail) {
            throw new ApiError("that email doesn't match this checkout", 403);
          }
          const itemIds = Array.isArray(body.itemIds) && body.itemIds.length ? body.itemIds : null;
          const nowIso = new Date().toISOString();
          const justReturned = [];
          const updatedItems = record.items.map((it) => {
            if (it.returned || (itemIds && !itemIds.includes(it.itemId))) return it;
            justReturned.push({ itemId: it.itemId, name: it.name, qty: it.qty });
            // If this item was flagged missing, it just showed back up -
            // returned and missing can't both be true at once, so the flag
            // (and its report details) drop the moment it's actually back.
            const { missing, missingAt, missingNote, ...rest } = it;
            return { ...rest, returned: true, returnedAt: nowIso };
          });
          const next = [...list];
          next[idx] = {
            ...record,
            items: updatedItems,
            // Only append an entry if something actually changed - a
            // repeat/no-op return call (everything already returned)
            // shouldn't add a phantom event to the trail.
            history: justReturned.length
              ? [...(record.history || []), { at: nowIso, action: "self-returned", items: justReturned }]
              : record.history || [],
          };
          return next;
        })
      );
      if (errorResponse) return errorResponse;
      await checkLowStockAndNotify(labId, labName, store); // returning may clear a low-stock flag
      return json(await visibleCheckouts(value, requester, labId, store));
    }

    if (action === "backfillReturnDate") {
      // Lets either the original requester (self-service, verified by email
      // match - same trust model as returnItems above) or an admin fill in
      // a real return date for items that are already marked returned but
      // never got one captured - anything checked out and returned before
      // per-item timestamps existed shows up as "returned at some point" in
      // the trail with no way to know when. This never invents a date on
      // its own; a person has to supply it, and the resulting history entry
      // is tagged distinctly ("returned-backfilled", with who reported it)
      // so it doesn't read with the same certainty as a date captured live
      // at the moment of return.
      const parsed = body.returnedAt ? new Date(body.returnedAt) : null;
      if (!parsed || isNaN(parsed.getTime())) {
        return json({ error: "a valid return date is required" }, 400);
      }
      if (parsed.getTime() > Date.now() + 60_000) {
        return json({ error: "return date can't be in the future" }, 400);
      }
      const returnedAtIso = parsed.toISOString();
      const requesterEmail = (body.email || "").trim().toLowerCase();
      const backfillActor = isAdminForLab && requester ? requester.username || requester.id : "self-reported";

      const { value, errorResponse } = await runMutation(() =>
        updateJSON(store, "checkouts", async (current) => {
          const list = current || [];
          const idx = list.findIndex((c) => c.id === id);
          if (idx === -1) throw new ApiError("checkout not found", 404);
          const record = list[idx];

          if (!isAdminForLab) {
            if (!requesterEmail || (record.email || "").toLowerCase() !== requesterEmail) {
              throw new ApiError("that email doesn't match this checkout", 403);
            }
          }
          if (returnedAtIso < record.createdAt) {
            throw new ApiError("return date can't be before this checkout happened", 400);
          }

          const itemIds = Array.isArray(body.itemIds) && body.itemIds.length ? body.itemIds : null;
          const backfilled = [];
          const updatedItems = record.items.map((it) => {
            if (!it.returned || it.returnedAt || (itemIds && !itemIds.includes(it.itemId))) return it;
            backfilled.push({ itemId: it.itemId, name: it.name, qty: it.qty });
            return { ...it, returnedAt: returnedAtIso };
          });
          if (backfilled.length === 0) {
            throw new ApiError("nothing here needs a return date - it's already recorded", 400);
          }
          const next = [...list];
          next[idx] = {
            ...record,
            items: updatedItems,
            history: [
              ...(record.history || []),
              { at: returnedAtIso, action: "returned-backfilled", by: backfillActor, items: backfilled },
            ],
          };
          return next;
        })
      );
      if (errorResponse) return errorResponse;
      return json(await visibleCheckouts(value, requester, labId, store));
    }

    // every other action requires an admin scoped to this lab.
    // 401 = no valid session at all; 403 = valid session, wrong lab scope.
    if (!isAdminForLab) {
      return json({ error: requester ? "you don't have access to this lab" : "unauthorized" }, requester ? 403 : 401);
    }

    if (action === "reportMissing") {
      // { id, itemIds?, note? } - itemIds omitted means every not-yet-
      // returned, not-already-missing item on this checkout (same "omit
      // means all" convention as returnItems/backfillReturnDate above).
      // Admin-only for now: this is the "we noticed something's gone"
      // report a lab manager files during a kit hand-off or audit, not a
      // self-service action. `missing` is deliberately a separate flag from
      // `returned`, not a replacement state: a missing item is still
      // unavailable (availableQty/checkedOutQty key off `returned` alone,
      // untouched by this), it just also needs someone to go find it.
      const itemIds = Array.isArray(body.itemIds) && body.itemIds.length ? body.itemIds : null;
      const note = typeof body.note === "string" ? body.note.trim() : "";
      const actor = requester.username || requester.id;

      const { value, errorResponse } = await runMutation(() =>
        updateJSON(store, "checkouts", async (current) => {
          const list = current || [];
          const idx = list.findIndex((c) => c.id === id);
          if (idx === -1) throw new ApiError("checkout not found", 404);
          const record = list[idx];
          const nowIso = new Date().toISOString();
          const justReported = [];
          const updatedItems = record.items.map((it) => {
            if ((itemIds && !itemIds.includes(it.itemId)) || it.returned || it.missing) return it;
            justReported.push({ itemId: it.itemId, name: it.name, qty: it.qty });
            return { ...it, missing: true, missingAt: nowIso, missingNote: note };
          });
          if (justReported.length === 0) {
            throw new ApiError("nothing here can be reported missing - it's already returned or already flagged", 400);
          }
          const next = [...list];
          next[idx] = {
            ...record,
            items: updatedItems,
            history: [
              ...(record.history || []),
              { at: nowIso, action: "reported-missing", by: actor, items: justReported, note },
            ],
          };
          return next;
        })
      );
      if (errorResponse) return errorResponse;
      return json(await visibleCheckouts(value, requester, labId, store));
    }

    if (action === "resolveMissing") {
      // { id, itemIds?, resolution: "found" | "written-off", note? }
      // "found" just clears the flag - the item goes back to plain
      // outstanding, still checked out, still needs a normal return.
      // "written-off" additionally marks it returned (it's not coming back
      // through this checkout) and permanently reduces the item's on-hand
      // inventory qty by what was lost - see below for why that's a
      // required write, not best-effort housekeeping.
      if (body.resolution !== "found" && body.resolution !== "written-off") {
        return json({ error: "resolution must be 'found' or 'written-off'" }, 400);
      }
      const writtenOff = body.resolution === "written-off";
      const itemIds = Array.isArray(body.itemIds) && body.itemIds.length ? body.itemIds : null;
      const note = typeof body.note === "string" ? body.note.trim() : "";
      const actor = requester.username || requester.id;

      // Populated by the mutator below on whichever attempt actually wins,
      // so the inventory write after it reflects exactly what was resolved.
      let writtenOffQtyByItem = [];

      const { value, errorResponse } = await runMutation(() =>
        updateJSON(store, "checkouts", async (current) => {
          const list = current || [];
          const idx = list.findIndex((c) => c.id === id);
          if (idx === -1) throw new ApiError("checkout not found", 404);
          const record = list[idx];
          const nowIso = new Date().toISOString();
          const resolved = [];
          writtenOffQtyByItem = [];
          const updatedItems = record.items.map((it) => {
            if ((itemIds && !itemIds.includes(it.itemId)) || !it.missing) return it;
            resolved.push({ itemId: it.itemId, name: it.name, qty: it.qty });
            if (writtenOff) writtenOffQtyByItem.push({ itemId: it.itemId, qty: it.qty });
            const { missingAt, missingNote, ...rest } = it;
            return writtenOff ? { ...rest, missing: false, returned: true, returnedAt: nowIso } : { ...rest, missing: false };
          });
          if (resolved.length === 0) {
            throw new ApiError("nothing here is currently marked missing", 400);
          }
          const next = [...list];
          next[idx] = {
            ...record,
            items: updatedItems,
            history: [
              ...(record.history || []),
              { at: nowIso, action: "missing-resolved", by: actor, resolution: body.resolution, items: resolved, note },
            ],
          };
          return next;
        })
      );
      if (errorResponse) return errorResponse;

      if (writtenOff && writtenOffQtyByItem.length) {
        // A written-off item is genuinely gone - silently swallowing a
        // failure here (the way checkLowStockAndNotify does for its own
        // best-effort housekeeping) would leave the lab's counted stock
        // overstating what's really on the shelf, so this surfaces a
        // conflict as a real error the admin can retry instead.
        try {
          await updateJSON(store, "inventory", async (invCurrent) => {
            const inv = invCurrent || [];
            return inv.map((i) => {
              const lost = writtenOffQtyByItem.find((r) => r.itemId === i.id);
              return lost ? { ...i, qty: Math.max(0, i.qty - lost.qty) } : i;
            });
          });
        } catch (e) {
          if (e instanceof ConcurrentWriteError) {
            return json(
              {
                error:
                  "marked returned and written off, but too much contention updating stock - please retry adjusting the item's quantity manually",
              },
              409
            );
          }
          throw e;
        }
      }

      await checkLowStockAndNotify(labId, labName, store);
      return json(await visibleCheckouts(value, requester, labId, store));
    }

    if (action === "resendEmail") {
      // A quick, non-authoritative peek to build the email content - this
      // is a manual, idempotent admin action (not a state transition other
      // requests are racing to make), so a rare stale read here just means
      // a resend email reflects items a split-second out of date, not lost
      // or corrupted data.
      const snapshot = (await store.get("checkouts", { type: "json" })) || [];
      const record = snapshot.find((c) => c.id === id);
      if (!record) return json({ error: "checkout not found" }, 404);

      const emailResult = await sendCheckoutEmail(record, {
        assignedByAdmin: record.assignedByAdmin,
        labName: body.labName,
      });
      const lastEmail = { ...emailResult, sentAt: new Date().toISOString() };

      const { value, errorResponse } = await runMutation(() =>
        updateJSON(store, "checkouts", async (current) => {
          const list = current || [];
          const idx = list.findIndex((c) => c.id === id);
          if (idx === -1) throw new ApiError("checkout not found", 404);
          const next = [...list];
          next[idx] = { ...next[idx], lastEmail };
          return next;
        })
      );
      if (errorResponse) return errorResponse;
      return json({ checkouts: await visibleCheckouts(value, requester, labId, store), email_notification: emailResult });
    }

    if (action === "updateItems") {
      const items = Array.isArray(body.items) ? body.items : [];
      if (items.length === 0) return json({ error: "items required" }, 400);
      const actor = requester ? requester.username || requester.id : "unknown";

      let updatedRecord;
      const { value, errorResponse } = await runMutation(() =>
        updateJSON(store, "checkouts", async (current) => {
          const list = current || [];
          const idx = list.findIndex((c) => c.id === id);
          if (idx === -1) throw new ApiError("checkout not found", 404);
          const record = list[idx];
          const newItems = items.map((it) => ({ itemId: it.itemId, name: it.name, qty: it.qty, returned: false }));
          updatedRecord = {
            ...record,
            items: newItems,
            // Record-level event, not tied to specific item ids - the new
            // item list itself is exactly what's already shown in the
            // (now-current) `items` array, so there's no separate
            // clearance-filtering need for this entry the way there is for
            // returned/self-returned entries above.
            history: [
              ...(record.history || []),
              { at: new Date().toISOString(), action: "items-updated", by: actor },
            ],
          };
          const next = [...list];
          next[idx] = updatedRecord;
          return next;
        })
      );
      if (errorResponse) return errorResponse;

      const emailResult = await sendCheckoutEmail(updatedRecord, {
        assignedByAdmin: updatedRecord.assignedByAdmin,
        updated: true,
        labName: body.labName,
      });
      const lastEmail = { ...emailResult, sentAt: new Date().toISOString() };
      const finalList = await annotateLastEmail(store, id, lastEmail);

      await checkLowStockAndNotify(labId, labName, store);
      return json({
        checkouts: await visibleCheckouts(finalList || value, requester, labId, store),
        email_notification: emailResult,
      });
    }

    // default action: mark every item on this checkout as returned
    const markReturnedActor = requester ? requester.username || requester.id : "unknown";
    const { value, errorResponse } = await runMutation(() =>
      updateJSON(store, "checkouts", async (current) => {
        const list = current || [];
        const idx = list.findIndex((c) => c.id === id);
        if (idx === -1) throw new ApiError("checkout not found", 404);
        const record = list[idx];
        const nowIso = new Date().toISOString();
        const justReturned = [];
        const items = record.items.map((it) => {
          if (it.returned) return it;
          justReturned.push({ itemId: it.itemId, name: it.name, qty: it.qty });
          // Same "returned clears missing" rule as returnItems above.
          const { missing, missingAt, missingNote, ...rest } = it;
          return { ...rest, returned: true, returnedAt: nowIso };
        });
        const next = [...list];
        next[idx] = {
          ...record,
          items,
          history: justReturned.length
            ? [
                ...(record.history || []),
                { at: nowIso, action: "returned", by: markReturnedActor, items: justReturned },
              ]
            : record.history || [],
        };
        return next;
      })
    );
    if (errorResponse) return errorResponse;
    await checkLowStockAndNotify(labId, labName, store);
    return json(await visibleCheckouts(value, requester, labId, store));
  }

  return json({ error: "method not allowed" }, 405);
});
