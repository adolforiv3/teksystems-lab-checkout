import { updateJSON } from "./occ.mjs";
import { skuRegistryStore } from "./stores.mjs";

// A short, readable stand-in for a category so a SKU actually says
// something at a glance ("BOOK-000004" beats "INV-000004") - deterministic
// from the category text alone so the same category always lands on the
// same prefix regardless of which lab or which admin typed it, and
// uncategorized items still get a stable fallback instead of an empty
// prefix. Not a strict abbreviation (categories aren't controlled
// vocabulary) - just the first few letters/digits, uppercased.
export function prefixFor(category) {
  const cleaned = (category || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return cleaned.slice(0, 4) || "GEN";
}

function formatSku(prefix, n) {
  return `${prefix}-${String(n).padStart(6, "0")}`;
}

// One counter per prefix (see skuRegistryStore), not one counter overall -
// every item sharing a category still shares one sequence across every lab
// in the company, so two teams both adding a "Books" item at once still
// can never both mint BOOK-000004. updateJSON's compare-and-swap loop is
// what makes "read the counter, add N, write it back" safe under
// concurrent creation from multiple labs at once; a plain read-then-write
// here would let two nearly-simultaneous adds both read the same counter
// value and both hand out the same SKU.
async function allocate(prefix, count, store) {
  if (count <= 0) return [];
  const last = await updateJSON(store, `counter:${prefix}`, async (current) => (typeof current === "number" ? current : 0) + count);
  const first = last - count + 1;
  const skus = [];
  for (let n = first; n <= last; n++) skus.push(formatSku(prefix, n));
  return skus;
}

export async function nextSku(category, store = skuRegistryStore()) {
  const [sku] = await allocate(prefixFor(category), 1, store);
  return sku;
}

// Batch variant for backfilling N items sharing one already-known prefix in
// a single counter update instead of N separate compare-and-swap round
// trips - see the backfillSkus admin action in inventory.mjs, which groups
// every legacy item across every lab by category prefix first, then makes
// exactly one of these calls per prefix.
export async function nextSkuBatchForPrefix(prefix, count, store = skuRegistryStore()) {
  return allocate(prefix, count, store);
}
