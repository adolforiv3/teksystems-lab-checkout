import { resolveAdmin, canAccessLab } from "./lib/auth.mjs";
import { labStore } from "./lib/stores.mjs";
import { resolveLab } from "./lib/lab-registry.mjs";
import { updateJSON } from "./lib/occ.mjs";
import { json, withErrorBoundary } from "./lib/http.mjs";

function imageKey(itemId) {
  return `image:${itemId}`;
}

// Passcode gate for an anonymous visitor - same rule every other per-lab
// endpoint carries its own copy of (inventory.mjs, kits.mjs, checkouts.mjs,
// cart-holds.mjs).
function visitorAccessOk(req, lab, admin, labId) {
  if (!lab || !lab.entryPasscode) return true;
  if (canAccessLab(admin, labId)) return true;
  return req.headers.get("x-lab-passcode") === lab.entryPasscode;
}

// GET is deliberately more permissive about how the lab gets identified
// than every write below: it tries the normal single-lab resolution first
// (unguessable access token, or an admin already scoped to that lab's raw
// id - see resolveLab), and only if that fails, falls back to accepting a
// raw lab id from ANY authenticated staff/client session with no further
// per-lab scoping. That fallback is what lets a photo actually load from a
// cross-lab view that only ever carries a raw labId, never a token -
// Company Inventory today, and nothing else, since a Client DRI's catalog
// rows deliberately strip labId entirely (see sanitizeItemForRole in
// inventory.mjs) and so can never reach this fallback. An unauthenticated
// caller can never take it either (admin is required), so this can't be
// used to enumerate labs by id the way resolveLab's own restriction on raw
// ids already guards against - it only widens what an ALREADY-authenticated
// session can read, matching the same "nothing confidential left in an
// item's shape between labs" reasoning Company Inventory itself is built
// on.
async function resolveImageRead(labParam, admin) {
  const lab = await resolveLab(labParam, admin);
  if (lab) return { store: labStore(lab.id), lab };
  if (admin) return { store: labStore(labParam), lab: null };
  return null;
}

// The client already resizes/compresses every photo in-browser before it's
// ever sent (see compressImageFile in index.html) - this cap is a hard
// backstop against a bypassed or misbehaving client, not the primary size
// control.
const MAX_IMAGE_BYTES = 400 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export default withErrorBoundary(async (req) => {
  const url = new URL(req.url);
  const labParam = url.searchParams.get("lab") || "";
  const itemId = url.searchParams.get("item") || "";
  const method = req.method;
  if (!itemId) return json({ error: "item id required" }, 400);

  const admin = await resolveAdmin(req);

  if (method === "GET") {
    const resolved = await resolveImageRead(labParam, admin);
    if (!resolved) return json({ error: "locked", locked: true }, 401);
    if (resolved.lab && !visitorAccessOk(req, resolved.lab, admin, resolved.lab.id)) {
      return json({ error: "locked", locked: true }, 401);
    }
    const entry = await resolved.store.getWithMetadata(imageKey(itemId), { type: "arrayBuffer" });
    if (!entry || !entry.data) return json({ error: "no image" }, 404);
    const contentType = (entry.metadata && entry.metadata.contentType) || "image/jpeg";
    return new Response(entry.data, {
      status: 200,
      headers: {
        "content-type": contentType,
        // Content-addressed by item id and only ever changes via a full
        // replace (see POST below) - safe to cache aggressively; a stale
        // photo for a while after a deliberate re-upload costs far less
        // than re-fetching the same bytes on every single render.
        "cache-control": "public, max-age=3600",
      },
    });
  }

  // Every write below is scoped exactly like every other write in this
  // app - resolveLab's normal single-lab rules, then canAccessLab -
  // deliberately NOT the broader cross-lab read fallback above.
  const lab = await resolveLab(labParam, admin);
  if (!lab) return json({ error: "locked", locked: true }, 401);
  if (!canAccessLab(admin, lab.id)) {
    return json({ error: admin ? "you don't have access to this lab" : "unauthorized" }, admin ? 403 : 401);
  }
  const store = labStore(lab.id);

  if (method === "POST") {
    const body = await req.json(); // { dataUrl: "data:image/jpeg;base64,...." } - already compressed client-side
    const match = typeof body.dataUrl === "string" && body.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return json({ error: "expected a base64 image data URL" }, 400);
    const [, contentType, base64] = match;
    if (!ALLOWED_TYPES.has(contentType)) return json({ error: "unsupported image type" }, 400);
    let bytes;
    try {
      bytes = Buffer.from(base64, "base64");
    } catch {
      return json({ error: "malformed image data" }, 400);
    }
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      return json({ error: "image too large even after compression - try a smaller photo" }, 400);
    }

    await store.set(imageKey(itemId), new Blob([bytes], { type: contentType }), { metadata: { contentType } });

    // hasImage mirrors hasNotes exactly (see inventory.mjs's writeNoteHistory)
    // - the bulk inventory listing every card/row render already fetches
    // stays a cheap boolean instead of embedding image bytes in every row.
    const updatedInventory = await updateJSON(store, "inventory", async (current) => {
      const inv = current || [];
      return inv.map((i) => (i.id === itemId ? { ...i, hasImage: true } : i));
    });
    return json(updatedInventory);
  }

  if (method === "DELETE") {
    await store.delete(imageKey(itemId));
    const updatedInventory = await updateJSON(store, "inventory", async (current) => {
      const inv = current || [];
      return inv.map((i) => (i.id === itemId ? { ...i, hasImage: false } : i));
    });
    return json(updatedInventory);
  }

  return json({ error: "method not allowed" }, 405);
});
