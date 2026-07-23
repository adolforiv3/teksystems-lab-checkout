import {
  loadAdmins,
  updateAdmins,
  hashPassword,
  publicAdmin,
  resolveAdmin,
  isSuperadmin,
  findByUsername,
  isValidClassification,
} from "./lib/auth.mjs";
import { ConcurrentWriteError } from "./lib/occ.mjs";
import { json, withErrorBoundary } from "./lib/http.mjs";

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function countSuperadmins(admins) {
  return admins.filter((a) => a.role === "superadmin").length;
}

// All the "business rule" checks below (username uniqueness, "don't demote
// the last superadmin") used to run once against a single load(), then
// write back unconditionally. Two admins editing accounts at the same
// moment could both pass those checks against the same stale snapshot -
// e.g. two requests each demoting a *different* superadmin, each correctly
// seeing "1 other superadmin remains" at read time, and both succeeding,
// leaving zero superadmins and everyone locked out. Every mutation here now
// runs inside updateAdmins(), so every check re-evaluates against the
// freshest state on every attempt, and conflicting concurrent writes retry
// instead of silently clobbering each other.
async function runAdminMutation(res) {
  try {
    return { list: await res() };
  } catch (err) {
    if (err instanceof ApiError) return { error: err };
    if (err instanceof ConcurrentWriteError) {
      return { error: new ApiError("too much contention updating admin accounts - please retry", 409) };
    }
    throw err;
  }
}

export default withErrorBoundary(async (req) => {
  const requester = await resolveAdmin(req);
  if (!isSuperadmin(requester)) {
    return json({ error: "superadmin access required" }, 403);
  }

  const method = req.method;

  if (method === "GET") {
    const admins = await loadAdmins();
    return json(admins.map(publicAdmin));
  }

  if (method === "POST") {
    const body = await req.json();
    const username = (body.username || "").trim();
    const password = body.password || "";
    const role = body.role === "superadmin" ? "superadmin" : "labadmin";
    const labs = role === "superadmin" ? [] : Array.isArray(body.labs) ? body.labs : [];

    if (!username || password.length < 6) {
      return json({ error: "username and a password (6+ chars) required" }, 400);
    }

    const { list, error } = await runAdminMutation(() =>
      updateAdmins(async (admins) => {
        if (findByUsername(admins, username)) {
          throw new ApiError("that username is already taken", 400);
        }
        const { salt, hash } = hashPassword(password);
        const admin = {
          id: crypto.randomUUID(),
          username,
          salt,
          hash,
          role,
          labs,
          email: (body.email || "").trim(),
          createdAt: new Date().toISOString(),
        };
        return [...admins, admin];
      })
    );
    if (error) return json({ error: error.message }, error.status);
    return json(list.map(publicAdmin), 201);
  }

  if (method === "PATCH") {
    // { id, username?, password?, role?, labs?, email?, grantClearance?: {labId, tier}, revokeClearance?: {labId} }
    //
    // Clearance is deliberately a separate action from role/labs edits
    // above, not folded into "labs" - assigning someone to a lab (normal
    // access) and clearing them to see that lab's black/ultraBlack items
    // are different grants on purpose, per the compartmentalization model
    // in lib/auth.mjs. Both require superadmin (already gated above), but
    // are tracked and can be revoked independently.
    const body = await req.json();

    const { list, error } = await runAdminMutation(() =>
      updateAdmins(async (admins) => {
        const idx = admins.findIndex((a) => a.id === body.id);
        if (idx === -1) throw new ApiError("admin not found", 404);

        const target = admins[idx];
        const updated = { ...target };

        if (body.grantClearance && typeof body.grantClearance.labId === "string") {
          const { labId, tier } = body.grantClearance;
          if (!isValidClassification(tier) || tier === "standard") {
            throw new ApiError("clearance tier must be 'black' or 'ultraBlack'", 400);
          }
          const clearances = (Array.isArray(target.clearances) ? target.clearances : []).filter(
            (c) => c.labId !== labId
          );
          clearances.push({
            labId,
            tier,
            grantedAt: new Date().toISOString(),
            grantedBy: requester.username || requester.id,
          });
          updated.clearances = clearances;
        }
        if (body.revokeClearance && typeof body.revokeClearance.labId === "string") {
          updated.clearances = (Array.isArray(target.clearances) ? target.clearances : []).filter(
            (c) => c.labId !== body.revokeClearance.labId
          );
        }

        if (typeof body.username === "string" && body.username.trim()) {
          const clash = findByUsername(admins, body.username);
          if (clash && clash.id !== target.id) {
            throw new ApiError("that username is already taken", 400);
          }
          updated.username = body.username.trim();
        }
        if (typeof body.email === "string") {
          updated.email = body.email.trim();
        }
        if (typeof body.password === "string" && body.password) {
          if (body.password.length < 6) throw new ApiError("password must be 6+ characters", 400);
          const { salt, hash } = hashPassword(body.password);
          updated.salt = salt;
          updated.hash = hash;
        }
        if (body.role === "superadmin" || body.role === "labadmin") {
          // guard against demoting away the last remaining superadmin -
          // re-checked against `admins` fresh on every attempt
          if (target.role === "superadmin" && body.role !== "superadmin") {
            const remaining = countSuperadmins(admins.filter((a) => a.id !== target.id));
            if (remaining === 0) {
              throw new ApiError("can't demote the last remaining superadmin", 400);
            }
          }
          updated.role = body.role;
          if (body.role === "superadmin") updated.labs = [];
        }
        if (Array.isArray(body.labs) && updated.role !== "superadmin") {
          updated.labs = body.labs;
        }

        const next = [...admins];
        next[idx] = updated;
        return next;
      })
    );
    if (error) return json({ error: error.message }, error.status);
    return json(list.map(publicAdmin));
  }

  if (method === "DELETE") {
    const { id } = await req.json();

    const { list, error } = await runAdminMutation(() =>
      updateAdmins(async (admins) => {
        const target = admins.find((a) => a.id === id);
        if (!target) throw new ApiError("admin not found", 404);
        if (target.role === "superadmin") {
          const remaining = countSuperadmins(admins.filter((a) => a.id !== id));
          if (remaining === 0) {
            throw new ApiError("can't remove the last remaining superadmin", 400);
          }
        }
        return admins.filter((a) => a.id !== id);
      })
    );
    if (error) return json({ error: error.message }, error.status);
    return json(list.map(publicAdmin));
  }

  return json({ error: "method not allowed" }, 405);
});
