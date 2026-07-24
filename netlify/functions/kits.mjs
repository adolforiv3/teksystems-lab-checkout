import { resolveAdmin, canAccessLab } from "./lib/auth.mjs";
import { labStore } from "./lib/stores.mjs";
import { resolveLab } from "./lib/lab-registry.mjs";
import { updateJSON, ConcurrentWriteError } from "./lib/occ.mjs";
import { json, withErrorBoundary } from "./lib/http.mjs";

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// A kit is a *recipe*, not a snapshot: just a name plus a list of
// {itemId, qty} references into this lab's inventory. Deliberately no
// captured item name/category here (unlike a checkout record's line items,
// which do capture a name so history still reads sensibly after a rename)
// - a kit is a live template a field tech quick-adds from, always meant to
// reflect whatever that item is called *right now*, not what it was called
// when the kit was built. The frontend resolves display names from the
// inventory list it already has loaded.
function sortKits(kits) {
  return [...kits].sort((a, b) => (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }));
}

function visitorAccessOk(req, lab, admin, labId) {
  if (!lab || !lab.entryPasscode) return true; // no lab passcode set - open access
  if (canAccessLab(admin, labId)) return true; // an admin scoped to this lab always gets in
  return req.headers.get("x-lab-passcode") === lab.entryPasscode;
}

// Defense in depth against a crafted request bypassing the admin UI's own
// item picker: reject any itemId in the submitted list that doesn't exist
// in this lab's inventory.
function validateKitItems(items, inventory) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ApiError("at least one item is required", 400);
  }
  const seen = new Set();
  const cleaned = [];
  for (const raw of items) {
    const itemId = raw && raw.itemId;
    const qty = raw && raw.qty;
    if (typeof itemId !== "string" || !itemId) throw new ApiError("each item needs an itemId", 400);
    if (!(typeof qty === "number" && qty > 0)) throw new ApiError("each item needs a positive qty", 400);
    const invItem = inventory.find((i) => i.id === itemId);
    if (!invItem) throw new ApiError("item not found", 404);
    if (!seen.has(itemId)) {
      seen.add(itemId);
      cleaned.push({ itemId, qty });
    }
  }
  return cleaned;
}

export default withErrorBoundary(async (req) => {
  const url = new URL(req.url);
  const labParam = url.searchParams.get("lab") || "";
  const method = req.method;

  const admin = await resolveAdmin(req);
  // Same lab-resolution rules as inventory.mjs/checkouts.mjs: a lab's
  // unguessable access token for anyone, or the raw internal id for an
  // admin already scoped to it.
  const lab = await resolveLab(labParam, admin);
  if (!lab) return json({ error: "locked", locked: true }, 401);
  const labId = lab.id;
  const store = labStore(labId);

  if (!visitorAccessOk(req, lab, admin, labId)) {
    return json({ error: "locked", locked: true }, 401);
  }

  if (method === "GET") {
    const kits = (await store.get("kits", { type: "json" })) || [];
    return json(sortKits(kits));
  }

  // every write below requires the requester to be an admin scoped to this lab.
  // 401 = no valid session at all; 403 = valid session, wrong lab scope.
  if (!canAccessLab(admin, labId)) {
    return json({ error: admin ? "you don't have access to this lab" : "unauthorized" }, admin ? 403 : 401);
  }

  try {
    if (method === "POST") {
      const body = await req.json();
      const name = (body.name || "").trim();
      if (!name) return json({ error: "kit name required" }, 400);

      const inventory = (await store.get("inventory", { type: "json" })) || [];
      const items = validateKitItems(body.items, inventory);

      const newKit = { id: crypto.randomUUID(), name, items, createdAt: new Date().toISOString() };
      const kits = await updateJSON(store, "kits", async (current) => [...(current || []), newKit]);
      return json(sortKits(kits), 201);
    }

    if (method === "PUT") {
      const body = await req.json(); // { id, name?, items? } - either/both
      if (body.name !== undefined && !String(body.name).trim()) {
        return json({ error: "kit name can't be blank" }, 400);
      }

      const kits = await updateJSON(store, "kits", async (current) => {
        const list = current || [];
        const idx = list.findIndex((k) => k.id === body.id);
        if (idx === -1) throw new ApiError("kit not found", 404);

        const updated = { ...list[idx] };
        if (body.name !== undefined) updated.name = String(body.name).trim();
        if (body.items !== undefined) {
          // Re-read inventory + re-validate fresh on every retry attempt, same
          // reasoning as every other OCC mutator in this app - an item could
          // be deleted out from under a slow-to-land edit.
          const inventory = (await store.get("inventory", { type: "json" })) || [];
          updated.items = validateKitItems(body.items, inventory);
        }

        const next = [...list];
        next[idx] = updated;
        return next;
      });
      return json(sortKits(kits));
    }

    if (method === "DELETE") {
      const { id } = await req.json();
      const kits = await updateJSON(store, "kits", async (current) => {
        const list = current || [];
        if (!list.some((k) => k.id === id)) throw new ApiError("kit not found", 404);
        return list.filter((k) => k.id !== id);
      });
      return json(sortKits(kits));
    }
  } catch (err) {
    if (err instanceof ApiError) return json({ error: err.message }, err.status);
    if (err instanceof ConcurrentWriteError) {
      return json({ error: "too much contention updating kits - please retry" }, 409);
    }
    throw err;
  }

  return json({ error: "method not allowed" }, 405);
});
