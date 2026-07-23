import {
  loadAdmins,
  updateAdmins,
  hashPassword,
  verifyPassword,
  newSessionToken,
  publicAdmin,
  resolveAdmin,
  findByUsername,
  checkMasterPasscode,
  newPasswordResetToken,
  resolvePasswordResetToken,
} from "./lib/auth.mjs";
import { ConcurrentWriteError } from "./lib/occ.mjs";
import { sendEmail } from "./lib/email.mjs";
import { json, withErrorBoundary } from "./lib/http.mjs";

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export default withErrorBoundary(async (req) => {
  const method = req.method;

  if (method === "GET") {
    const admins = await loadAdmins();
    return json({ hasAdmins: admins.length > 0 });
  }

  if (method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  const body = await req.json().catch(() => ({}));
  const action = body.action;

  if (action === "bootstrap") {
    // Only usable while no admin accounts exist yet - creates the very
    // first superadmin, gated by the master passcode (env var).
    //
    // Two people (or a retried request) could hit "bootstrap" at almost the
    // same instant. Plain load-then-save would let both succeed and
    // silently create two competing "first" superadmins, with whichever one
    // saved last wiping out the other's account entirely. Routing this
    // through updateAdmins() re-checks "no admins exist yet" against the
    // freshest possible state on every attempt, so only one bootstrap can
    // ever actually win - the loser gets a clear 400, not silent data loss.
    const username = (body.username || "").trim();
    const password = body.password || "";
    if (!checkMasterPasscode(body.masterPasscode)) {
      return json({ error: "incorrect master passcode" }, 401);
    }
    if (!username || password.length < 6) {
      return json({ error: "username and a password (6+ chars) required" }, 400);
    }

    let createdAdmin;
    try {
      await updateAdmins(async (admins) => {
        if (admins.length > 0) {
          throw new ApiError("an admin account already exists - please log in", 400);
        }
        const { salt, hash } = hashPassword(password);
        createdAdmin = {
          id: crypto.randomUUID(),
          username,
          salt,
          hash,
          role: "superadmin",
          labs: [],
          email: (body.email || "").trim(),
          createdAt: new Date().toISOString(),
        };
        return [createdAdmin];
      });
    } catch (err) {
      if (err instanceof ApiError) return json({ error: err.message }, err.status);
      if (err instanceof ConcurrentWriteError) {
        return json({ error: "another request is setting up the admin account right now - please retry" }, 409);
      }
      throw err;
    }

    const token = newSessionToken(createdAdmin.id);
    return json({ token, admin: publicAdmin(createdAdmin) }, 201);
  }

  if (action === "login") {
    const admins = await loadAdmins();
    const admin = findByUsername(admins, body.username);
    if (!admin || !verifyPassword(body.password || "", admin.salt, admin.hash)) {
      return json({ error: "invalid username or password" }, 401);
    }
    const token = newSessionToken(admin.id);
    return json({ token, admin: publicAdmin(admin) });
  }

  if (action === "whoami") {
    const admin = await resolveAdmin(req);
    if (!admin) return json({ error: "unauthorized" }, 401);
    return json({ admin });
  }

  if (action === "changePassword") {
    const admin = await resolveAdmin(req);
    if (!admin) return json({ error: "unauthorized" }, 401);
    if (admin.id === "__bootstrap__") {
      return json({ error: "log in with a real admin account to change a password" }, 400);
    }
    if (!body.newPassword || body.newPassword.length < 6) {
      return json({ error: "new password must be 6+ characters" }, 400);
    }

    try {
      // Verifying the *current* password inside the mutator (not before it)
      // matters: if someone else changed this same password a split second
      // earlier, we must re-check the caller's "current password" against
      // that fresh hash, not the stale one we might have looked at first.
      await updateAdmins(async (admins) => {
        const idx = admins.findIndex((a) => a.id === admin.id);
        if (idx === -1) throw new ApiError("account not found", 404);
        if (!verifyPassword(body.currentPassword || "", admins[idx].salt, admins[idx].hash)) {
          throw new ApiError("current password is incorrect", 401);
        }
        const { salt, hash } = hashPassword(body.newPassword);
        const next = [...admins];
        next[idx] = { ...next[idx], salt, hash };
        return next;
      });
    } catch (err) {
      if (err instanceof ApiError) return json({ error: err.message }, err.status);
      if (err instanceof ConcurrentWriteError) {
        return json({ error: "too much contention updating your account - please retry" }, 409);
      }
      throw err;
    }
    return json({ ok: true });
  }

  if (action === "requestPasswordReset") {
    // Deliberately responds with the exact same generic message whether or
    // not the username exists, has an email on file, or the email actually
    // sends - a distinguishable response here ("no such user" vs "reset
    // sent") would let anyone enumerate which usernames are valid accounts
    // just by trying them. The account holder's own signal that something
    // happened is the email itself landing (or not) in their inbox.
    const GENERIC_MSG = "If that account exists, a password reset link has been sent to its email address.";
    const username = (body.username || "").trim();
    if (!username) return json({ message: GENERIC_MSG });

    const admins = await loadAdmins();
    const admin = findByUsername(admins, username);
    if (admin && admin.email) {
      const token = newPasswordResetToken(admin);
      const origin = new URL(req.url).origin;
      const resetLink = `${origin}/?resetToken=${token}`;
      const text =
        `A password reset was requested for the "${admin.username}" admin account.\n\n` +
        `Reset your password: ${resetLink}\n\n` +
        `This link expires in 30 minutes and can only be used once. If you didn't request this, you can ignore this email - your password hasn't been changed.`;
      // Best-effort - the response is identical either way (see above), so
      // an email-provider hiccup here never leaks anything to the caller
      // and never turns "we tried" into a client-visible error.
      await sendEmail({ to: admin.email, subject: "Reset your password — Lab Supply Checkout", text }).catch(() => {});
    }
    return json({ message: GENERIC_MSG });
  }

  if (action === "resetPassword") {
    if (!body.newPassword || body.newPassword.length < 6) {
      return json({ error: "new password must be 6+ characters" }, 400);
    }
    const target = await resolvePasswordResetToken(body.token);
    if (!target) {
      return json({ error: "this reset link is invalid, expired, or already used" }, 401);
    }

    try {
      // Re-verified inside the mutator against the freshest state, same
      // reasoning as changePassword above - and re-checks the token's hash
      // fingerprint isn't now stale from a second concurrent use of the
      // same link.
      await updateAdmins(async (admins) => {
        const idx = admins.findIndex((a) => a.id === target.id);
        if (idx === -1) throw new ApiError("account not found", 404);
        const { salt, hash } = hashPassword(body.newPassword);
        const next = [...admins];
        next[idx] = { ...next[idx], salt, hash };
        return next;
      });
    } catch (err) {
      if (err instanceof ApiError) return json({ error: err.message }, err.status);
      if (err instanceof ConcurrentWriteError) {
        return json({ error: "too much contention updating this account - please retry" }, 409);
      }
      throw err;
    }

    // Log the admin straight in with a normal session token, so a
    // successful reset drops them right back into the app instead of
    // making them turn around and log in again with the password they just
    // set.
    const token = newSessionToken(target.id);
    return json({ token, admin: publicAdmin(target) });
  }

  return json({ error: "unknown action" }, 400);
});
