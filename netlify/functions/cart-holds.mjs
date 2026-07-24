import { resolveAdmin, isClient } from "./lib/auth.mjs";
import { labStore, labRegistryStore, cartHoldsStore } from "./lib/stores.mjs";
import { resolveLab, loadLabsForRead } from "./lib/lab-registry.mjs";
import { updateJSON, ConcurrentWriteError } from "./lib/occ.mjs";
import { json, withErrorBoundary } from "./lib/http.mjs";

// How long an unattended cart hold survives before it stops counting against
// anyone else - long enough that a shopper filling out the checkout form (or
// a DRI writing a note) never loses their claim mid-flow, short enough that
// a browser tab someone walked away from doesn't lock stock indefinitely.
// The frontend re-POSTs the current cart on every mutation AND on a repeat
// interval while the cart is non-empty (see index.html), each one resetting
// this window - so an actively-shopped cart's hold effectively never
// expires, only an abandoned one does.
const TTL_MS = 8 * 60 * 1000;

function visitorAccessOk(req, lab, admin) {
  if (!lab || !lab.entryPasscode) return true;
  if (admin) return true; // an authenticated admin session is enough here - this endpoint has no per-lab scoping to check beyond that
  return req.headers.get("x-lab-passcode") === lab.entryPasscode;
}

export default withErrorBoundary(async (req) => {
  const method = req.method;
  if (method !== "POST") return json({ error: "method not allowed" }, 405);

  const url = new URL(req.url);
  const labParam = url.searchParams.get("lab") || "";
  const admin = await resolveAdmin(req);

  const body = await req.json(); // { sessionId, items: [{itemId, qty}] }
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  if (!sessionId) return json({ error: "sessionId required" }, 400);
  const rawItems = Array.isArray(body.items) ? body.items : [];

  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + TTL_MS).toISOString();

  let newRecords = [];

  if (labParam) {
    // Shopper path: every item is scoped to this one lab, resolved the same
    // way inventory.mjs/checkouts.mjs do.
    const lab = await resolveLab(labParam, admin);
    if (!lab) return json({ error: "locked", locked: true }, 401);
    if (!visitorAccessOk(req, lab, admin)) return json({ error: "locked", locked: true }, 401);
    const inventory = (await labStore(lab.id).get("inventory", { type: "json" })) || [];
    for (const raw of rawItems) {
      const qty = raw && raw.qty;
      if (typeof raw.itemId !== "string" || !(typeof qty === "number" && qty > 0)) continue;
      if (!inventory.some((i) => i.id === raw.itemId)) continue; // ignore anything that isn't real - not worth erroring a fire-and-forget sync over
      newRecords.push({ sessionId, itemId: raw.itemId, labId: lab.id, qty, createdAt: nowIso, expiresAt });
    }
  } else {
    // DRI path: a client's cart can span every lab, and a client's own
    // session never knows which lab an item lives in (see source-
    // requests.mjs - same resolution approach: scan every lab once).
    if (!isClient(admin)) return json({ error: admin ? "client account required" : "unauthorized" }, admin ? 403 : 401);
    const labs = await loadLabsForRead(labRegistryStore());
    const itemLab = new Map(); // itemId -> labId
    await Promise.all(
      labs.map(async (lab) => {
        const inv = (await labStore(lab.id).get("inventory", { type: "json" })) || [];
        for (const item of inv) itemLab.set(item.id, lab.id);
      })
    );
    for (const raw of rawItems) {
      const qty = raw && raw.qty;
      if (typeof raw.itemId !== "string" || !(typeof qty === "number" && qty > 0)) continue;
      const labId = itemLab.get(raw.itemId);
      if (!labId) continue;
      newRecords.push({ sessionId, itemId: raw.itemId, labId, qty, createdAt: nowIso, expiresAt });
    }
  }

  try {
    await updateJSON(cartHoldsStore(), "holds", async (current) => {
      const arr = current || [];
      const now = Date.now();
      // Replace this session's entire prior snapshot with the new one, and
      // drop anything (any session) that's aged out - same "resend the
      // whole current state" pattern the frontend already uses for the DRI
      // cart itself, so removals need no separate call: an item missing
      // from `items` just isn't in the new snapshot.
      const kept = arr.filter((rec) => rec.sessionId !== sessionId && new Date(rec.expiresAt).getTime() > now);
      return [...kept, ...newRecords];
    });
  } catch (e) {
    if (e instanceof ConcurrentWriteError) {
      return json({ error: "too much contention on cart holds - please retry" }, 409);
    }
    throw e;
  }

  return json({ ok: true, count: newRecords.length });
});
