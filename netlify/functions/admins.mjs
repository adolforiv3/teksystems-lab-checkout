import {
  loadAdmins,
  updateAdmins,
  hashPassword,
  publicAdmin,
  resolveAdmin,
  isSuperadmin,
  findByUsername,
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
    const role = body.role === "superadmin" ? "superadmin" : body.role === "client" ? "client" : "labadmin";
    const labs = role === "labadmin" && Array.isArray(body.labs) ? body.labs : [];
    // A client DRI is never scoped to a lab the way a labadmin is (see
    // isClient() in lib/auth.mjs) - `clientOrg` is a free-text tag
    // (e.g. "B") that only labels their source requests for audit
    // purposes; it never restricts what inventory they can see.
    const clientOrg = role === "client" ? (body.clientOrg || "").trim() : undefined;

    if (!username || password.length < 6) {
      return json({ error: "username and a password (6+ chars) required" }, 400);
    }
    if (role === "client" && !clientOrg) {
      return json({ error: "an org tag is required for a client account" }, 400);
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
          ...(role === "client" ? { clientOrg } : {}),
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
    // { id, username?, password?, role?, labs?, email? }
    const body = await req.json();

    const { list, error } = await runAdminMutation(() =>
      updateAdmins(async (admins) => {
        const idx = admins.findIndex((a) => a.id === body.id);
        if (idx === -1) throw new ApiError("admin not found", 404);

        const target = admins[idx];
        const updated = { ...target };

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
        if (body.role === "superadmin" || body.role === "labadmin" || body.role === "client") {
          // guard against demoting away the last remaining superadmin -
          // re-checked against `admins` fresh on every attempt
          if (target.role === "superadmin" && body.role !== "superadmin") {
            const remaining = countSuperadmins(admins.filter((a) => a.id !== target.id));
            if (remaining === 0) {
              throw new ApiError("can't demote the last remaining superadmin", 400);
            }
          }
          updated.role = body.role;
          // Lab scope and org tag are mutually exclusive with each other -
          // switching roles clears whichever one no longer applies, rather
          // than leaving a stale labs[] on a client or a stale clientOrg on
          // a labadmin.
          if (body.role !== "labadmin") updated.labs = [];
          if (body.role !== "client") delete updated.clientOrg;
        }
        if (Array.isArray(body.labs) && updated.role === "labadmin") {
          updated.labs = body.labs;
        }
        if (typeof body.clientOrg === "string" && updated.role === "client") {
          updated.clientOrg = body.clientOrg.trim();
        }
        if (updated.role === "client" && !updated.clientOrg) {
          throw new ApiError("an org tag is required for a client account", 400);
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
