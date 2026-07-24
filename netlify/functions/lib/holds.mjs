import { sourceRequestsStore, transfersStore, cartHoldsStore } from "./stores.mjs";

// How much of each item is currently claimed by a pending client source
// request, keyed by the lab that request is against. Doesn't touch real
// stock (see source-requests.mjs - fulfilling still never moves qty on its
// own), but it IS a real claim: two different parties can't both be allowed
// to walk away with the same units, so this is the thing every other
// availability check below folds in before deciding what's actually still
// claimable.
export async function computePendingRequestHolds(labId) {
  const holds = new Map();
  const requests = (await sourceRequestsStore().get("requests", { type: "json" })) || [];
  for (const r of requests) {
    if (r.status === "pending" && r.labId === labId) {
      holds.set(r.itemId, (holds.get(r.itemId) || 0) + r.qty);
    }
  }
  return holds;
}

// Same idea for a pending outgoing "send" transfer proposal this lab made -
// the destination hasn't accepted yet, but the source lab has already
// committed to sending those units if they do, so nobody else should be able
// to claim them out from under that proposal in the meantime. A pending
// "request"-direction transfer never appears here - it has no real itemId
// yet (see transfers.mjs), so there's nothing specific to hold.
export async function computePendingSendTransferHolds(labId) {
  const holds = new Map();
  const transfers = (await transfersStore().get("transfers", { type: "json" })) || [];
  for (const t of transfers) {
    if (t.status === "pending" && t.direction === "send" && t.sourceLabId === labId) {
      for (const it of t.items) {
        holds.set(it.itemId, (holds.get(it.itemId) || 0) + it.qty);
      }
    }
  }
  return holds;
}

// Not yet a request or a transfer at all - just "someone's browser has this
// many of this item sitting in an unsubmitted cart right now" (see
// cart-holds.mjs). Short-lived and self-expiring: a hold whose `expiresAt`
// has already passed is treated as if it were never written, no separate
// cleanup pass required. `excludeSessionId` is for the one caller who
// legitimately already "has" these units in their own cart and is about to
// convert that into a real claim (a checkout or a source request) - without
// it, a shopper's own reservation would count against their own checkout and
// block them from claiming the very units they already have.
export async function computeCartHolds(labId, { excludeSessionId } = {}) {
  const holds = new Map();
  const now = Date.now();
  const records = (await cartHoldsStore().get("holds", { type: "json" })) || [];
  for (const rec of records) {
    if (rec.labId !== labId) continue;
    if (excludeSessionId && rec.sessionId === excludeSessionId) continue;
    if (new Date(rec.expiresAt).getTime() <= now) continue;
    holds.set(rec.itemId, (holds.get(rec.itemId) || 0) + rec.qty);
  }
  return holds;
}

// Combined view: every unit of every item in this lab that's currently
// spoken for by *something* other than an actual checkout - a pending client
// request, a pending outgoing transfer proposal, or someone else's
// unsubmitted cart. This is the single source of truth every write path
// (checkouts, source-requests, transfers) and every read path (inventory's
// per-lab listing, the DRI catalog) uses to decide what's really still
// claimable, so two different parties can't both successfully claim the
// same stock.
export async function computePendingHolds(labId, { excludeSessionId } = {}) {
  try {
    const [requestHolds, transferHolds, cartHolds] = await Promise.all([
      computePendingRequestHolds(labId),
      computePendingSendTransferHolds(labId),
      computeCartHolds(labId, { excludeSessionId }),
    ]);
    const holds = new Map(requestHolds);
    for (const [itemId, qty] of transferHolds) {
      holds.set(itemId, (holds.get(itemId) || 0) + qty);
    }
    for (const [itemId, qty] of cartHolds) {
      holds.set(itemId, (holds.get(itemId) || 0) + qty);
    }
    return holds;
  } catch (e) {
    console.error(`holds: computePendingHolds failed for lab "${labId}" (non-fatal, holds just won't show/apply):`, e);
    return new Map();
  }
}

// What's actually left for a new party to claim right now: real on-hand
// stock, minus what's already checked out, minus whatever's already held by
// someone else's still-pending claim on it. Never negative.
export function claimableQty(item, available, holds) {
  return Math.max(0, available - (holds.get(item.id) || 0));
}
