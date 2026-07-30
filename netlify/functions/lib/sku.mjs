import { updateJSON } from "./occ.mjs";
import { skuRegistryStore } from "./stores.mjs";

// One global, monotonically-increasing counter (see skuRegistryStore) backs
// every item's SKU across every lab in the company - there is exactly one
// sequence, so two items minted at the same moment in two different labs
// still can never collide. updateJSON's compare-and-swap loop is what makes
// "read the counter, add 1, write it back" safe under concurrent item
// creation from multiple labs at once; a plain read-then-write here would
// let two nearly-simultaneous adds both read the same counter value and
// both hand out the same SKU.
function formatSku(n) {
  return `INV-${String(n).padStart(6, "0")}`;
}

export async function nextSku(store = skuRegistryStore()) {
  const next = await updateJSON(store, "counter", async (current) => (typeof current === "number" ? current : 0) + 1);
  return formatSku(next);
}

// Batch variant for backfilling N items in one counter update instead of N
// separate compare-and-swap round trips - see the backfillSkus admin action
// in inventory.mjs, which can be assigning SKUs to hundreds of legacy items
// across every lab in one pass.
export async function nextSkuBatch(count, store = skuRegistryStore()) {
  if (count <= 0) return [];
  const last = await updateJSON(store, "counter", async (current) => (typeof current === "number" ? current : 0) + count);
  const first = last - count + 1;
  const skus = [];
  for (let n = first; n <= last; n++) skus.push(formatSku(n));
  return skus;
}
