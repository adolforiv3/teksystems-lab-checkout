import { labRegistryStore } from "./stores.mjs";
import { updateJSON } from "./occ.mjs";
import { canAccessLab, hasClearance } from "./auth.mjs";

// The very first lab this app shipped with - kept as a fixed id so its
// pre-existing inventory/checkout data (stored under the legacy
// "lab-checkout" store name) never needs to be migrated.
const BOOTSTRAP_LAB = { id: "groomlake", name: "Macara 1 - Groom Lake" };

// Public-facing lab access is by this unguessable token, not by `id` -
// `id` stays around as the internal/admin identifier (used for the lab's
// Blobs store name and for admin.labs[] scoping), but is never required or
// accepted from an unauthenticated caller. Two concatenated UUIDs is
// overkill on entropy on purpose: this is the one credential standing
// between "nobody outside this vendor even knows this lab exists" and
// public discovery, so it's worth erring far on the side of unguessable.
export function generateAccessToken() {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

function seedLab() {
  return { ...BOOTSTRAP_LAB, accessToken: generateAccessToken(), createdAt: new Date().toISOString() };
}

// ---- read-path acceleration ----
//
// resolveLab() below runs on EVERY single inventory/checkout API request,
// across every lab in the system - it used to always pay the cost of
// reading and linear-scanning the ENTIRE labs registry array just to find
// the one lab being accessed: O(total labs system-wide) per request,
// regardless of which lab. That's invisible at a handful of labs; it
// becomes the single biggest cost on the hottest path in the app the
// moment tenant count actually grows, which directly undercuts the
// explicit "10x more tenants" goal this whole redesign was built for.
//
// These two index keys are pure read-side acceleration, rebuilt
// best-effort after every successful registry write (see refreshIndexes,
// called from mutateLabs) - never the source of truth, which stays the
// "labs" array itself. resolveLab() always verifies a hit against the
// record's own current fields before trusting it, and falls back to the
// full O(n) scan on any miss or mismatch - so a stale, missing, or
// failed-to-write index entry can only ever degrade performance back to
// the pre-indexing baseline, never weaken access control. In particular: a
// token that's since been regenerated may leave a stale idx:token:<old>
// entry behind (cleanup below is best-effort, not guaranteed), but that
// entry's own `accessToken` field no longer matches the key it's stored
// under once the lab's real token changes - the self-check below rejects
// it - so an orphaned index entry can never grant access to a revoked
// link, even if it's never explicitly deleted.
function tokenIndexKey(token) {
  return `idx:token:${token}`;
}
function idIndexKey(id) {
  return `idx:id:${id}`;
}

async function refreshIndexes(store, labs, previousLabs) {
  try {
    const writes = [];
    for (const l of labs) {
      writes.push(store.setJSON(idIndexKey(l.id), l));
      if (l.accessToken) writes.push(store.setJSON(tokenIndexKey(l.accessToken), l));
    }
    // Best-effort cleanup of specifically the old token(s)/lab(s) this
    // write just replaced or removed - not required for correctness (see
    // the self-check in resolveLab), just keeps orphaned entries from
    // accumulating in storage indefinitely.
    if (Array.isArray(previousLabs)) {
      for (const old of previousLabs) {
        const current = labs.find((l) => l.id === old.id);
        if (old.accessToken && (!current || current.accessToken !== old.accessToken)) {
          writes.push(store.delete(tokenIndexKey(old.accessToken)));
        }
        if (!current) writes.push(store.delete(idIndexKey(old.id)));
      }
    }
    await Promise.all(writes);
  } catch (e) {
    console.error(
      "refreshIndexes: failed to refresh lab lookup indexes (non-fatal - resolveLab falls back to a full scan on any miss):",
      e
    );
  }
}

// Read-only path: make sure the registry is seeded (tolerating a race where
// two simultaneous first-ever requests both try to seed it - `onlyIfNew`
// guarantees only one seed write actually lands), and make sure every lab
// record has an access token - older labs created before this feature
// existed get one generated and persisted the first time they're read here,
// so nothing needs a manual migration step.
export async function loadLabsForRead(store) {
  const existing = await store.getWithMetadata("labs", { type: "json" });
  let labs = existing && existing.data && existing.data.length ? existing.data : null;

  if (!labs) {
    const seeded = [seedLab()];
    const result = await store.setJSON("labs", seeded, { onlyIfNew: true });
    // Same defensive handling as lib/occ.mjs's updateJSON - only an
    // explicit modified:false means "someone else already seeded it."
    if (!result || result.modified !== false) {
      await refreshIndexes(store, seeded, null);
      return seeded;
    }
    const fresh = await store.get("labs", { type: "json" });
    labs = fresh && fresh.length ? fresh : seeded;
  }

  if (labs.some((l) => !l.accessToken)) {
    try {
      const before = labs;
      labs = await updateJSON(store, "labs", async (current) => {
        const list = current && current.length ? current : before;
        return list.map((l) => (l.accessToken ? l : { ...l, accessToken: generateAccessToken() }));
      });
      await refreshIndexes(store, labs, before);
    } catch (e) {
      console.error("loadLabsForRead: failed to backfill access tokens (non-fatal, retries next read):", e);
      labs = labs.map((l) => (l.accessToken ? l : { ...l, accessToken: generateAccessToken() }));
    }
  }
  return labs;
}

// Write paths all go through this so "does this id already exist", "find by
// id", etc. are evaluated against the freshest registry state on every
// retry attempt, and two concurrent lab edits/creates can't silently
// overwrite one another (see lib/occ.mjs for why that's not paranoia).
// Also keeps the read-path indexes above in sync with every write.
export async function mutateLabs(store, mutate) {
  let previousLabs = null;
  const labs = await updateJSON(store, "labs", async (current) => {
    const list = current && current.length ? current : [seedLab()];
    previousLabs = list; // captured fresh on whichever attempt actually wins
    return mutate(list);
  });
  await refreshIndexes(store, labs, previousLabs);
  return labs;
}

// Resolves whatever came in on `?lab=` to a lab record, for the
// inventory/checkouts endpoints that visitors and admins share.
//
// A valid access token always resolves, for anyone - that's the intended
// public/vendor-facing credential. A raw internal `id` only resolves for a
// caller who is *already* an authenticated admin scoped to that specific
// lab (bookmarked/typed admin URLs keep working) - never for an anonymous
// visitor, or every lab's id becomes a guessable access path regardless of
// how unguessable its token is, defeating the whole point.
export async function resolveLab(labParam, admin) {
  if (!labParam) return null;
  const store = labRegistryStore();

  // Fast path - O(1), independent of total lab count. See refreshIndexes
  // above for why a stale/missing entry here can only ever fall through to
  // the slow path below, never grant access it shouldn't.
  const byTokenIndexed = await store.get(tokenIndexKey(labParam), { type: "json" });
  if (byTokenIndexed && byTokenIndexed.accessToken === labParam) return byTokenIndexed;

  if (admin) {
    const byIdIndexed = await store.get(idIndexKey(labParam), { type: "json" });
    if (byIdIndexed && byIdIndexed.id === labParam && canAccessLab(admin, byIdIndexed.id)) return byIdIndexed;
  }

  // Slow path fallback - covers a cold/missing/stale index (right after a
  // write before refreshIndexes lands, an old deploy's data, or any
  // best-effort index write that failed) without ever weakening
  // correctness, just falling back to the pre-indexing O(total labs)
  // baseline for that one request.
  const labs = await loadLabsForRead(store);
  const byToken = labs.find((l) => l.accessToken === labParam);
  if (byToken) return byToken;
  const byId = labs.find((l) => l.id === labParam);
  if (byId && admin && canAccessLab(admin, byId.id)) return byId;
  return null;
}

// Which labs an authenticated admin is allowed to even see in a management
// list. Non-superadmins: only their own assigned labs (unchanged from
// before). Superadmins: everything *except* a lab that carries its own
// lab-level classification tier they aren't individually cleared for -
// administrative authority over the app doesn't imply read access into a
// classified project, same principle as item-level classification.
export function labsVisibleTo(labs, admin) {
  if (!admin) return [];
  if (admin.role !== "superadmin") {
    return labs.filter((l) => canAccessLab(admin, l.id));
  }
  return labs.filter((l) => {
    const tier = l.classification || "standard";
    return tier === "standard" || hasClearance(admin, l.id, tier);
  });
}

// Never expose the raw entry passcode - only whether one is set. Used for
// the single-lab, token-resolved lookup that unauthenticated visitors hit;
// deliberately minimal (no accessToken echoed back, no classification, no
// createdAt) since the caller already has everything they need to proceed.
export function publicLab(l) {
  return { id: l.id, name: l.name, locked: !!l.entryPasscode };
}

// Fuller shape for authenticated admin listings - includes the access
// token (so the admin UI can render/copy the shareable link) and any
// lab-level classification, but still never the raw passcode(s) - only
// whether each is set. Same treatment now applies to classifiedReleaseCode,
// the checkout-time "yes, you can take this restricted device" code - see
// checkouts.mjs.
export function adminLab(l) {
  const { entryPasscode, classifiedReleaseCode, ...rest } = l;
  return { ...rest, locked: !!entryPasscode, restrictedCheckoutSet: !!classifiedReleaseCode };
}

export function slugify(name) {
  return (
    (name || "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "lab"
  );
}
