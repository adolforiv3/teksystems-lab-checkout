import { loadAdmins, hasClearance } from "./auth.mjs";
import { sendEmail } from "./email.mjs";
import { updateJSON } from "./occ.mjs";

// O(checkouts) single-item lookup - fine when you only need one item's
// availability (e.g. validating one checkout request). Do NOT call this in
// a loop over many items: each call rescans every checkout from scratch, so
// checking N items this way costs O(N x total checked-out line items). For
// that case use buildCheckedOutIndex() once and read from the Map instead -
// see checkLowStockAndNotify() below.
export function availableQty(item, checkouts) {
  const checkedOut = checkouts.reduce((sum, c) => {
    const forThisItem = (c.items || [])
      .filter((it) => it.itemId === item.id && !it.returned)
      .reduce((s, it) => s + it.qty, 0);
    return sum + forThisItem;
  }, 0);
  return Math.max(0, item.qty - checkedOut);
}

// One pass over every checkout (and every line item in it) building an
// itemId -> outstanding qty map. Checking M items against this index is
// O(M) total instead of O(M x checkouts).
export function buildCheckedOutIndex(checkouts) {
  const index = new Map();
  for (const c of checkouts) {
    for (const it of c.items || []) {
      if (it.returned) continue;
      index.set(it.itemId, (index.get(it.itemId) || 0) + it.qty);
    }
  }
  return index;
}

function availableQtyFromIndex(item, index) {
  return Math.max(0, item.qty - (index.get(item.id) || 0));
}

// `requiredTier` gates the recipient list the same way inventory.mjs gates
// reads/writes: for a classified item, "scoped to this lab" (or even
// superadmin) is not sufficient on its own - a low-stock email naming a
// "black"/"ultraBlack" item must only reach admins who hold clearance for
// that specific lab and tier, or the alert itself becomes the leak.
async function notifyLabRecipients(labId, labName, subject, text, requiredTier = "standard") {
  const admins = await loadAdmins();
  const recipients = admins.filter((a) => {
    if (!a.email) return false;
    const scoped = a.role === "superadmin" || (a.labs || []).includes(labId);
    if (!scoped) return false;
    return hasClearance(a, labId, requiredTier);
  });
  const results = [];
  for (const admin of recipients) {
    const result = await sendEmail({
      to: admin.email,
      subject,
      text,
      fromName: `${labName} Supply Checkout`,
    });
    results.push({ email: admin.email, ...result });
  }
  return results;
}

// Reads the lab's current inventory + checkouts from `store`, and for any
// item with a lowStockThreshold set, emails every admin scoped to this lab
// (assigned lab-admins + all superadmins, provided they have an email on
// file) the first time its available quantity drops to or below that
// threshold. A `lowStockNotified` flag on the item prevents re-sending on
// every subsequent checkout while it stays low, and clears automatically
// once the item is restocked back above the threshold.
//
// IMPORTANT: the inventory write below goes through updateJSON, which will
// re-run its callback if a concurrent write conflicts with ours (e.g. two
// checkouts against the same low-stock item landing at nearly the same
// time). Sending the alert email is a side effect - if it lived *inside*
// that retried callback, a conflict-and-retry would fire the same "low
// stock" email twice. So this function is split in two: first, durably
// commit the notified/reset flags via the OCC loop while only *recording*
// which items crossed a threshold (pure, safe to recompute on every
// attempt); then, once that write has actually landed, send each email
// exactly once, from outside the retry loop.
//
// This whole step is explicitly best-effort housekeeping *on top of* an
// already-successful primary write - every caller in inventory.mjs and
// checkouts.mjs invokes this unconditionally right after its own real
// mutation already committed, and most callers don't even use the return
// value because they already built the response they're about to send. So
// nothing in here is allowed to throw: an email provider hiccup, a second
// round of write contention, or a transient store error must never bubble
// up and turn an already-successful request into a client-visible 500 -
// that would show the user "something went wrong" for a save that, from
// their perspective, already worked (and did: refreshing shows the data).
// Both the OCC write and each individual notification email are wrapped so
// a failure anywhere here is logged and swallowed, never thrown. Callers
// that use the return value (inventory.mjs) fall back to the inventory list
// they already had from their own primary write when this returns null.
function computeFlips(inventory, checkedOutIndex) {
  const flips = [];
  for (const item of inventory) {
    const threshold = item.lowStockThreshold || 0;
    if (!threshold) continue;
    const avail = availableQtyFromIndex(item, checkedOutIndex);
    if (avail <= threshold && !item.lowStockNotified) flips.push({ id: item.id, notified: true, avail, threshold });
    else if (avail > threshold && item.lowStockNotified) flips.push({ id: item.id, notified: false });
  }
  return flips;
}

export async function checkLowStockAndNotify(labId, labName, store) {
  // Fast path, most calls take it: this runs after *every single* inventory
  // and checkout mutation in the app, but the overwhelming majority of
  // those (a note edit, a name change, a checkout of an item with no
  // threshold set) can't possibly change any item's low-stock status. Doing
  // a full second OCC read-modify-write cycle on the same "inventory" key
  // for those calls was pure waste - it doubled the write-contention window
  // on that key for every mutation in the app, for no reason, which matters
  // a lot more once concurrent traffic (and thus write contention) is 10x
  // higher. A plain, uncontended read first tells us whether there's
  // actually anything to flip; only pay for the write cycle when there is.
  let plainInventory, plainCheckouts;
  try {
    plainInventory = (await store.get("inventory", { type: "json" })) || [];
    plainCheckouts = (await store.get("checkouts", { type: "json" })) || [];
  } catch (e) {
    console.error(`low-stock pre-check read failed for lab "${labId}" (non-fatal):`, e);
    return null;
  }
  if (computeFlips(plainInventory, buildCheckedOutIndex(plainCheckouts)).length === 0) {
    return plainInventory;
  }

  let toNotify = [];

  let finalInventory;
  try {
    finalInventory = await updateJSON(store, "inventory", async (current) => {
      const inventory = current || [];
      const checkouts = (await store.get("checkouts", { type: "json" })) || [];
      // Built once per attempt (O(checkouts)), then every item below is an
      // O(1) map lookup instead of an O(checkouts) rescan - the difference
      // between O(inventory) and O(inventory x checkouts) on every single
      // inventory write and every checkout mutation.
      const checkedOutIndex = buildCheckedOutIndex(checkouts);

      // Reset on every attempt - only the batch computed on the attempt that
      // actually wins the write should ever reach the email-sending step.
      toNotify = [];

      return inventory.map((item) => {
        const threshold = item.lowStockThreshold || 0;
        if (!threshold) return item;

        const avail = availableQtyFromIndex(item, checkedOutIndex);

        if (avail <= threshold && !item.lowStockNotified) {
          toNotify.push({ item, avail, threshold });
          return { ...item, lowStockNotified: true };
        }
        if (avail > threshold && item.lowStockNotified) {
          return { ...item, lowStockNotified: false };
        }
        return item;
      });
    });
  } catch (e) {
    console.error(`low-stock check step failed for lab "${labId}" (non-fatal - the write that triggered this already committed):`, e);
    return null;
  }

  for (const { item, avail, threshold } of toNotify) {
    try {
      const subject = `Low stock alert — ${item.name} (${labName})`;
      const text =
        `Heads up: "${item.name}" in ${labName} is down to ${avail} available ` +
        `(alert threshold: ${threshold}, total on hand: ${item.qty}).\n\n` +
        `Restock when you get a chance, or adjust the alert threshold from the admin panel.`;
      // A classified item's low-stock alert must only reach admins cleared
      // for its tier - see notifyLabRecipients above.
      await notifyLabRecipients(labId, labName, subject, text, item.classification || "standard");
    } catch (e) {
      console.error(`low-stock email failed for "${item.name}" in lab "${labId}" (non-fatal):`, e);
    }
  }

  return finalInventory;
}
