import { resolveAdmin, canAccessLab, loadAdmins } from "./lib/auth.mjs";
import { labStore, transfersStore, labRegistryStore } from "./lib/stores.mjs";
import { loadLabsForRead } from "./lib/lab-registry.mjs";
import { updateJSON, ConcurrentWriteError } from "./lib/occ.mjs";
import { availableQty, checkLowStockAndNotify } from "./lib/lowstock.mjs";
import { computePendingHolds } from "./lib/holds.mjs";
import { sendEmail } from "./lib/email.mjs";
import { json, withErrorBoundary } from "./lib/http.mjs";

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// Lab-to-lab transfers. A transfer always moves real stock out of the lab
// that currently owns it (the "source"), toward another lab (the
// "destination") - and the source always has final say over exactly what
// leaves its own shelf, regardless of which lab actually proposed the
// transfer:
//
//   - "send": the source lab picks real items from its own inventory and
//     proposes sending them. The destination must still accept/deny before
//     anything moves - a lab can't be handed stock it never agreed to.
//   - "request": the destination lab asks for an item by name + qty. It
//     never gets to see or touch the source's real inventory (see
//     lib/lab-registry.mjs's labDirectory - only {id,name} is exposed
//     across labs, never stock levels), so the source reviews the request
//     and fulfills it against its own real items (choosing exactly what and
//     how much - full or partial), or denies it outright.
//
// Either way, `approverLabId` (destination for a send, source for a
// request) is the one lab whose admin can accept or deny - the other side
// can only cancel its own still-pending proposal.
function approverLabId(t) {
  return t.direction === "send" ? t.destinationLabId : t.sourceLabId;
}
function initiatorLabId(t) {
  return t.direction === "send" ? t.sourceLabId : t.destinationLabId;
}

// A transfer is visible to an admin scoped to *either* side of it.
function canSeeTransfer(t, admin) {
  return canAccessLab(admin, t.sourceLabId) || canAccessLab(admin, t.destinationLabId);
}

// Best-effort - never blocks the actual transfer action, same principle as
// the low-stock notifier.
async function notifyLab(labId, labName, subject, text) {
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
    console.error(`transfers: notification email failed for lab "${labId}" (non-fatal):`, e);
  }
}

export default withErrorBoundary(async (req) => {
  const method = req.method;
  const admin = await resolveAdmin(req);
  // Transfers are an admin-only, cross-lab concern end to end - there's no
  // anonymous/shopper-facing side to this the way inventory/checkouts have.
  if (!admin) return json({ error: "unauthorized" }, 401);

  const allLabs = await loadLabsForRead(labRegistryStore());
  const labById = (id) => allLabs.find((l) => l.id === id) || null;
  const store = transfersStore();

  if (method === "GET") {
    const list = (await store.get("transfers", { type: "json" })) || [];
    const visible = list.filter((t) => canSeeTransfer(t, admin));
    visible.sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));
    return json(visible);
  }

  try {
    if (method === "POST") {
      const body = await req.json(); // { sourceLabId, destinationLabId, direction: "send"|"request", items, note? }
      const direction = body.direction === "request" ? "request" : "send";
      const sourceLabId = body.sourceLabId;
      const destinationLabId = body.destinationLabId;
      if (!sourceLabId || !destinationLabId || sourceLabId === destinationLabId) {
        return json({ error: "a distinct source and destination lab are required" }, 400);
      }
      const sourceLab = labById(sourceLabId);
      const destinationLab = labById(destinationLabId);
      if (!sourceLab || !destinationLab) return json({ error: "lab not found" }, 404);

      // The proposing lab is whichever side this admin actually belongs to
      // - a "send" is proposed by the source, a "request" by the
      // destination. Not scoped to either side at all: no transfer.
      const proposerLabId = direction === "send" ? sourceLabId : destinationLabId;
      if (!canAccessLab(admin, proposerLabId)) {
        return json({ error: "you don't have access to the lab proposing this transfer" }, 403);
      }

      const note = typeof body.note === "string" ? body.note.trim() : "";
      const actor = admin.username || admin.id;
      let items;

      if (direction === "send") {
        if (!Array.isArray(body.items) || body.items.length === 0) {
          return json({ error: "at least one item is required" }, 400);
        }
        const sourceStore = labStore(sourceLabId);
        const inventory = (await sourceStore.get("inventory", { type: "json" })) || [];
        const checkouts = (await sourceStore.get("checkouts", { type: "json" })) || [];
        // Excludes anything already claimed by a pending client source
        // request or another pending send proposal from this same lab, so
        // this lab can't propose sending units it's already promised
        // somewhere else.
        const holds = await computePendingHolds(sourceLabId);
        const seen = new Set();
        items = [];
        for (const raw of body.items) {
          const qty = raw && raw.qty;
          if (typeof raw.itemId !== "string" || !raw.itemId) return json({ error: "each item needs an itemId" }, 400);
          if (!(typeof qty === "number" && qty > 0)) return json({ error: "each item needs a positive qty" }, 400);
          const invItem = inventory.find((i) => i.id === raw.itemId);
          if (!invItem) return json({ error: "item not found" }, 404);
          const avail = Math.max(0, availableQty(invItem, checkouts) - (holds.get(invItem.id) || 0));
          if (qty > avail) return json({ error: `not enough "${invItem.name}" available (${avail} left)` }, 409);
          if (seen.has(raw.itemId)) continue;
          seen.add(raw.itemId);
          items.push({ itemId: invItem.id, name: invItem.name, category: invItem.category || "", qty });
        }
        if (items.length === 0) return json({ error: "at least one item is required" }, 400);
      } else {
        // A "request" never references real items - the requester can't see
        // the source lab's inventory at all (see labDirectory). Just a
        // named wishlist the source lab reviews against its own real stock.
        if (!Array.isArray(body.items) || body.items.length === 0) {
          return json({ error: "at least one item is required" }, 400);
        }
        items = body.items.map((raw) => ({
          name: typeof raw.name === "string" ? raw.name.trim() : "",
          qty: typeof raw.qty === "number" && raw.qty > 0 ? raw.qty : null,
        }));
        if (items.some((it) => !it.name || !it.qty)) {
          return json({ error: "each requested item needs a name and a positive qty" }, 400);
        }
      }

      const nowIso = new Date().toISOString();
      const record = {
        id: crypto.randomUUID(),
        sourceLabId,
        sourceLabName: sourceLab.name,
        destinationLabId,
        destinationLabName: destinationLab.name,
        direction,
        items,
        status: "pending",
        note,
        requestedBy: actor,
        requestedAt: nowIso,
        history: [{ at: nowIso, action: direction === "send" ? "sent" : "requested", by: actor, note }],
      };

      const list = await updateJSON(store, "transfers", async (current) => [...(current || []), record]);

      const approver = labById(approverLabId(record));
      const approverAction = direction === "send" ? "receive" : "fulfill";
      await notifyLab(
        approver.id,
        approver.name,
        `Transfer ${direction === "send" ? "incoming" : "request"} — ${sourceLab.name} ↔ ${destinationLab.name}`,
        `${sourceLab.name} and ${destinationLab.name} have a pending transfer that needs your team to ${approverAction} it.\n\n` +
          items.map((it) => `  • ${it.name} × ${it.qty}`).join("\n") +
          (note ? `\n\nNote: ${note}` : "") +
          `\n\nReview it from the Transfers section in the admin panel.`
      );

      return json(list.filter((t) => canSeeTransfer(t, admin)), 201);
    }

    if (method === "PATCH") {
      const body = await req.json(); // { id, action: "accept"|"deny"|"cancel", fulfillment?, note? }
      const { id, action } = body;
      const actor = admin.username || admin.id;

      if (action === "cancel") {
        const list = await updateJSON(store, "transfers", async (current) => {
          const arr = current || [];
          const idx = arr.findIndex((t) => t.id === id);
          if (idx === -1) throw new ApiError("transfer not found", 404);
          const t = arr[idx];
          if (t.status !== "pending") throw new ApiError("this transfer has already been resolved", 400);
          if (!canAccessLab(admin, initiatorLabId(t))) {
            throw new ApiError("only the lab that proposed this transfer can cancel it", 403);
          }
          const nowIso = new Date().toISOString();
          const next = [...arr];
          next[idx] = {
            ...t,
            status: "cancelled",
            respondedBy: actor,
            respondedAt: nowIso,
            history: [...t.history, { at: nowIso, action: "cancelled", by: actor }],
          };
          return next;
        });
        return json(list.filter((t) => canSeeTransfer(t, admin)));
      }

      if (action === "deny") {
        let denied = null;
        const list = await updateJSON(store, "transfers", async (current) => {
          const arr = current || [];
          const idx = arr.findIndex((t) => t.id === id);
          if (idx === -1) throw new ApiError("transfer not found", 404);
          const t = arr[idx];
          if (t.status !== "pending") throw new ApiError("this transfer has already been resolved", 400);
          if (!canAccessLab(admin, approverLabId(t))) {
            throw new ApiError("you don't have access to the lab this transfer needs a decision from", 403);
          }
          const nowIso = new Date().toISOString();
          const note = typeof body.note === "string" ? body.note.trim() : "";
          denied = { ...t, status: "denied" };
          const next = [...arr];
          next[idx] = {
            ...t,
            status: "denied",
            respondedBy: actor,
            respondedAt: nowIso,
            history: [...t.history, { at: nowIso, action: "denied", by: actor, note }],
          };
          return next;
        });
        if (denied) {
          const initiator = labById(initiatorLabId(denied));
          await notifyLab(
            initiator.id,
            initiator.name,
            `Transfer denied — ${denied.sourceLabName} ↔ ${denied.destinationLabName}`,
            `Your transfer ${denied.direction === "send" ? "to" : "request from"} ${
              denied.direction === "send" ? denied.destinationLabName : denied.sourceLabName
            } was denied.\n\n` + denied.items.map((it) => `  • ${it.name} × ${it.qty}`).join("\n")
          );
        }
        return json(list.filter((t) => canSeeTransfer(t, admin)));
      }

      if (action === "accept") {
        // The transfer record and the two lab inventories are three
        // separate keys (two of them in entirely different per-lab
        // stores), so there's no way to move stock and resolve the
        // transfer in one atomic write. Handled in two phases instead:
        //
        // 1. Atomically *claim* the transfer first - flip it to "accepted"
        //    only if it's still "pending", via the normal OCC
        //    compare-and-swap. This is the single-winner step: if two
        //    concurrent accept clicks raced on the same transfer, only one
        //    of them can win this write, so only one ever proceeds to
        //    actually move stock. Without this, both requests could read
        //    "pending", both pass validation, and both move stock -
        //    double-decrementing the source and double-crediting the
        //    destination.
        // 2. Actually move the stock. If that fails for any reason before
        //    the source has been touched, the claim is rolled back to
        //    "pending" so a failed attempt doesn't permanently strand the
        //    transfer as falsely resolved with nothing having moved. Once
        //    the source *has* been decremented, a further failure is no
        //    longer rolled back - the move partially happened for real, so
        //    reverting the transfer's own status would be actively wrong;
        //    it surfaces as a hard error asking for a retry instead, same
        //    discipline as checkouts.mjs's written-off resolution.
        let transferSnapshot = null;
        let moves = []; // [{itemId, qty}] real source items to actually move

        try {
          await updateJSON(store, "transfers", async (current) => {
            const arr = current || [];
            const idx = arr.findIndex((t) => t.id === id);
            if (idx === -1) throw new ApiError("transfer not found", 404);
            const t = arr[idx];
            if (t.status !== "pending") throw new ApiError("this transfer has already been resolved", 400);
            if (!canAccessLab(admin, approverLabId(t))) {
              throw new ApiError("you don't have access to the lab this transfer needs a decision from", 403);
            }
            transferSnapshot = t;

            if (t.direction === "send") {
              moves = t.items.map((it) => ({ itemId: it.itemId, qty: it.qty }));
            } else {
              const fulfillment = Array.isArray(body.fulfillment) ? body.fulfillment : [];
              if (fulfillment.length === 0) {
                throw new ApiError("pick at least one real item to fulfill this with, or deny it if you can't", 400);
              }
              // Deduped by itemId (summing qty) rather than trusted as-is -
              // two fulfillment lines for the same real item would otherwise
              // let the source-side decrement (which looks up each item by
              // id, so a repeat just overwrites rather than adds) and the
              // destination-side credit (built by iterating every line, so
              // a repeat counts twice) disagree with each other.
              const byItemId = new Map();
              for (const f of fulfillment) {
                if (typeof f.itemId !== "string" || !f.itemId) throw new ApiError("each fulfillment line needs an itemId", 400);
                if (!(typeof f.qty === "number" && f.qty > 0)) throw new ApiError("each fulfillment line needs a positive qty", 400);
                byItemId.set(f.itemId, (byItemId.get(f.itemId) || 0) + f.qty);
              }
              moves = [...byItemId.entries()].map(([itemId, qty]) => ({ itemId, qty }));
            }

            const next = [...arr];
            next[idx] = { ...t, status: "accepted", respondedBy: actor, respondedAt: new Date().toISOString() };
            return next;
          });
        } catch (e) {
          if (e instanceof ApiError) return json({ error: e.message }, e.status);
          if (e instanceof ConcurrentWriteError) {
            return json({ error: "too much contention on transfers - please retry" }, 409);
          }
          throw e;
        }

        // Reverts the provisional "accepted" claim back to "pending" - only
        // called when the stock move failed before the source was actually
        // touched, so nothing real happened yet and the transfer is safe to
        // reopen. Best-effort: if this itself fails, the transfer is stuck
        // showing "accepted" with no matching stock movement, which is
        // exactly the failure mode this whole claim step exists to avoid,
        // but is at least now a rare double-failure rather than the common
        // case.
        async function rollbackClaim() {
          try {
            await updateJSON(store, "transfers", async (current) => {
              const arr = current || [];
              const idx = arr.findIndex((t) => t.id === id);
              if (idx === -1) return arr;
              const t = arr[idx];
              if (t.status !== "accepted" || t.fulfilled) return arr; // already finalized or already reverted - leave alone
              const next = [...arr];
              const { respondedBy, respondedAt, ...rest } = t;
              next[idx] = { ...rest, status: "pending" };
              return next;
            });
          } catch (e) {
            console.error(`transfers: failed to roll back a failed accept claim for "${id}" (non-fatal, may need manual review):`, e);
          }
        }

        // --- move the stock: decrement source, then find-or-create at destination ---
        let resolvedMoves = [];
        const sourceStoreRef = labStore(transferSnapshot.sourceLabId);
        try {
          await updateJSON(sourceStoreRef, "inventory", async (current) => {
            const inv = current || [];
            const checkouts = (await sourceStoreRef.get("checkouts", { type: "json" })) || [];
            // This transfer already flipped to "accepted" in the previous
            // step, so it no longer counts as a "pending" hold itself here -
            // what's left is everyone ELSE's still-pending claim (another
            // DRI request, another pending transfer) that may have shown up
            // against this same item in the time between this transfer being
            // proposed and actually being accepted.
            const holds = await computePendingHolds(transferSnapshot.sourceLabId);
            resolvedMoves = [];
            for (const m of moves) {
              const item = inv.find((i) => i.id === m.itemId);
              if (!item) throw new ApiError("an item in this transfer no longer exists at the source", 409);
              const avail = Math.max(0, availableQty(item, checkouts) - (holds.get(item.id) || 0));
              if (m.qty > avail) {
                throw new ApiError(`not enough "${item.name}" available at the source now (${avail} left)`, 409);
              }
              resolvedMoves.push({
                itemId: item.id,
                name: item.name,
                category: item.category || "",
                qty: m.qty,
                attribute: item.attribute || "",
                serialNumber: item.serialNumber || "",
              });
            }
            return inv.map((item) => {
              const m = moves.find((x) => x.itemId === item.id);
              return m ? { ...item, qty: item.qty - m.qty } : item;
            });
          });
        } catch (e) {
          // The source inventory write never happened - safe to reopen the
          // transfer for another attempt.
          await rollbackClaim();
          if (e instanceof ApiError) return json({ error: e.message }, e.status);
          if (e instanceof ConcurrentWriteError) {
            return json({ error: "too much contention on the source lab's inventory - please retry" }, 409);
          }
          throw e;
        }

        const destStoreRef = labStore(transferSnapshot.destinationLabId);
        try {
          await updateJSON(destStoreRef, "inventory", async (current) => {
            let inv = current || [];
            for (const rm of resolvedMoves) {
              // An item carrying a serial number is individually tracked -
              // merging two different physical devices into one qty>1
              // record would silently lose one's serial number, so it
              // always gets its own fresh record at the destination
              // instead. Everything else merges into a matching name if the
              // destination already stocks it, same as any other restock.
              const existing = !rm.serialNumber
                ? inv.find((i) => i.name.toLowerCase() === rm.name.toLowerCase() && !i.serialNumber)
                : null;
              if (existing) {
                inv = inv.map((i) => (i.id === existing.id ? { ...i, qty: i.qty + rm.qty } : i));
              } else {
                inv = [
                  ...inv,
                  {
                    id: crypto.randomUUID(),
                    name: rm.name,
                    category: rm.category,
                    qty: rm.qty,
                    notes: "",
                    hasNotes: false,
                    attribute: rm.attribute,
                    serialNumber: rm.serialNumber,
                    lowStockThreshold: 0,
                  },
                ];
              }
            }
            return inv;
          });
        } catch (e) {
          if (e instanceof ConcurrentWriteError) {
            return json(
              { error: "stock left the source lab but too much contention updating the destination - please retry, or reconcile manually" },
              409
            );
          }
          throw e;
        }

        // Stock leaving the source could cross its low-stock threshold;
        // stock arriving at the destination could just as easily clear an
        // existing one there - check both sides.
        await checkLowStockAndNotify(transferSnapshot.sourceLabId, transferSnapshot.sourceLabName, sourceStoreRef);
        await checkLowStockAndNotify(transferSnapshot.destinationLabId, transferSnapshot.destinationLabName, destStoreRef);

        const nowIso = new Date().toISOString();
        const finalList = await updateJSON(store, "transfers", async (current) => {
          const arr = current || [];
          const idx = arr.findIndex((t) => t.id === id);
          if (idx === -1) return arr; // shouldn't happen - already validated above
          const t = arr[idx];
          const next = [...arr];
          next[idx] = {
            ...t,
            status: "accepted",
            fulfilled: resolvedMoves.map((rm) => ({ itemId: rm.itemId, name: rm.name, qty: rm.qty })),
            respondedBy: actor,
            respondedAt: nowIso,
            history: [...t.history, { at: nowIso, action: "accepted", by: actor, items: resolvedMoves.map((rm) => ({ itemId: rm.itemId, name: rm.name, qty: rm.qty })) }],
          };
          return next;
        });

        const initiator = labById(initiatorLabId(transferSnapshot));
        await notifyLab(
          initiator.id,
          initiator.name,
          `Transfer accepted — ${transferSnapshot.sourceLabName} ↔ ${transferSnapshot.destinationLabName}`,
          `Your transfer ${transferSnapshot.direction === "send" ? "to" : "request from"} ${
            transferSnapshot.direction === "send" ? transferSnapshot.destinationLabName : transferSnapshot.sourceLabName
          } was accepted.\n\n` + resolvedMoves.map((rm) => `  • ${rm.name} × ${rm.qty}`).join("\n")
        );

        return json(finalList.filter((t) => canSeeTransfer(t, admin)));
      }

      return json({ error: "unknown action" }, 400);
    }
  } catch (err) {
    if (err instanceof ApiError) return json({ error: err.message }, err.status);
    if (err instanceof ConcurrentWriteError) {
      return json({ error: "too much contention on transfers - please retry" }, 409);
    }
    throw err;
  }

  return json({ error: "method not allowed" }, 405);
});
