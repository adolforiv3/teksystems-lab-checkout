import { updateJSON } from "./occ.mjs";

// Append-only audit trail for classified (black/ultraBlack) item mutations.
// Kept as its own key per lab, separate from "inventory", so reading the
// audit log never touches (or contends with) the hot inventory write path,
// and so a lab's own normal admins - who by definition aren't cleared for
// classified items - can be kept from reading it just as easily as the
// items themselves.
//
// This intentionally only logs *writes* (create/update/delete/reclassify),
// not every read - logging every GET of a classified item would balloon
// volume for little benefit here and isn't what "real controls" typically
// means in practice; the write trail (who created/changed/removed a
// classified entry, and when) is the part worth being able to answer for.
const MAX_ENTRIES = 2000; // keep the log bounded; oldest entries roll off

export async function logClassifiedAccess(store, entry) {
  try {
    await updateJSON(store, "auditLog", async (current) => {
      const log = current || [];
      const next = [
        ...log,
        {
          id: crypto.randomUUID(),
          at: new Date().toISOString(),
          ...entry,
        },
      ];
      return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
    });
  } catch (e) {
    // Never let an audit-logging hiccup fail (or even delay retrying) the
    // actual mutation it's describing - same "best-effort side effect"
    // principle as the low-stock notifier. The action itself already
    // committed by the time this runs.
    console.error("logClassifiedAccess: failed to append audit entry (non-fatal):", e);
  }
}

export async function readAuditLog(store) {
  return (await store.get("auditLog", { type: "json" })) || [];
}
