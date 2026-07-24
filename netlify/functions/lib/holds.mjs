import { sourceRequestsStore, transfersStore } from "./stores.mjs";

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

// Combined view: every unit of every item in this lab that's currently
// spoken for by *something* other than an actual checkout - a pending client
// request, or a pending outgoing transfer proposal. This is the single
// source of truth every write path (checkouts, source-requests, transfers)
// and every read path (inventory's per-lab listing, the DRI catalog) uses to
// decide what's really still claimable, so two different parties can't both
// successfully claim the same stock.
export async function computePendingHolds(labId) {
  try {
    const [requestHolds, transferHolds] = await Promise.all([
      computePendingRequestHolds(labId),
      computePendingSendTransferHolds(labId),
    ]);
    const holds = new Map(requestHolds);
    for (const [itemId, qty] of transferHolds) {
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
