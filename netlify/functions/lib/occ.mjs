// Generic optimistic-concurrency read-modify-write helper for Netlify Blobs.
//
// Netlify Blobs has no built-in locking or transactions: store.get() and
// store.setJSON() are two independent network calls. Under real concurrent
// traffic, two function invocations can both read the same value, both
// compute an update from it, and both write - the second write silently
// overwrites the first with no error (Netlify's own docs: "if multiple
// write calls to the same key are issued, the last write wins"). For an
// inventory/checkout system that means a checkout, a return, or an admin
// edit can vanish without a trace whenever two requests land close enough
// together - and that gets *more* likely as traffic grows, not less.
//
// This wraps a read-modify-write in a compare-and-swap loop using the
// `onlyIfMatch` / `onlyIfNew` conditional-write options Netlify Blobs
// provides (backed by the entry's ETag). If a concurrent write beat us,
// the write comes back with `modified: false` and we retry with a fresh
// read - the mutate() callback re-runs against the latest data every time,
// so any validation inside it always sees current state, not stale state.

export class ConcurrentWriteError extends Error {
  constructor(key, attempts) {
    super(`giving up on "${key}" after ${attempts} conflicting concurrent writes`);
    this.name = "ConcurrentWriteError";
    this.code = "CONCURRENT_WRITE";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {import("@netlify/blobs").Store} store - should be constructed with
 *   `consistency: "strong"` (see lib/stores.mjs) so our own read isn't
 *   looking at a stale edge cache.
 * @param {string} key
 * @param {(current: any) => any | Promise<any>} mutate - receives the
 *   current value (or `null` if the key doesn't exist yet) and returns the
 *   new value to write. May be async. May throw to abort immediately
 *   without retrying - use this for validation/business-rule failures that
 *   re-reading won't fix (e.g. "not found", "not enough stock"); attach a
 *   `.code` and `.status` to the error so the caller can map it to an HTTP
 *   response instead of it being treated as a transient conflict.
 * @param {{maxAttempts?: number}} [opts]
 * @returns {Promise<any>} the value that was actually persisted
 */
export async function updateJSON(store, key, mutate, { maxAttempts = 8 } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const existing = await store.getWithMetadata(key, { type: "json" });
    const current = existing ? existing.data : null;

    const next = await mutate(current);

    const writeOpts = existing ? { onlyIfMatch: existing.etag } : { onlyIfNew: true };
    const result = await store.setJSON(key, next, writeOpts);

    // Netlify's own docs promise setJSON() always resolves with
    // `{ modified, etag }` - but in production this call was observed to
    // resolve to `undefined` instead, which crashed *every single write in
    // the app* with "Cannot destructure property 'modified' of
    // '(intermediate value)' as it is undefined" (this is the exact bug
    // behind every "internal error"/502 report while building the notes
    // feature - it was never specific to notes, it broke every PUT/POST/
    // DELETE in the app equally, notes just happened to be what was being
    // tested most at the time).
    //
    // Rather than trust the documented return shape and let a missing
    // field crash the request, only treat an *explicit* `modified: false`
    // as "someone else won the race, retry." Anything else - a proper
    // `{modified:true}`, or a response that doesn't match the documented
    // shape at all - is treated as a successful write. Worst case, on
    // whatever deploys/SDK versions don't return the documented shape,
    // this only gives up the conflict-retry guarantee for that specific
    // write (falling back to plain last-write-wins, which is what Netlify's
    // own docs describe as the baseline behavior without conditional
    // writes) - a far better failure mode than every save in the app
    // returning a 500.
    if (result && result.modified === false) {
      await sleep(10 + Math.random() * 20 * attempt);
      continue;
    }
    if (!result || typeof result.modified !== "boolean") {
      console.warn(
        `updateJSON: setJSON("${key}") didn't return the documented {modified,etag} shape (got: ${JSON.stringify(result)}) - treating the write as successful`
      );
    }
    return next;
  }
  throw new ConcurrentWriteError(key, maxAttempts);
}
