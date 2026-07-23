// Dedicated coverage for the password-reset workflow: requestPasswordReset /
// resetPassword actions in admin-auth.mjs, and the purpose-scoped,
// hash-fingerprint-single-use token machinery in lib/auth.mjs.
process.env.ADMIN_PASSCODE = "masterpass123";

const base = "http://local";
let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error("FAIL:", msg); }
  else console.log("ok  :", msg);
}

async function call(mod, method, path, { headers = {}, body } = {}) {
  const req = new Request(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const res = await mod.default(req);
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

const adminAuthMod = await import("./functions/admin-auth.mjs");
const authLib = await import("./functions/lib/auth.mjs");

const GENERIC_MSG = "If that account exists, a password reset link has been sent to its email address.";

// --- setup: superadmin with an email on file, and one lab-scoped admin with no email ---
let r = await call(adminAuthMod, "POST", "/admin-auth", {
  body: { action: "bootstrap", masterPasscode: "masterpass123", username: "root", password: "originalpw1", email: "root@example.com" },
});
assert(r.status === 201, "root bootstrapped with an email on file");
const rootId = r.data.admin.id;

// --- requestPasswordReset: identical generic response regardless of whether the account exists ---
r = await call(adminAuthMod, "POST", "/admin-auth", { body: { action: "requestPasswordReset", username: "nonexistent-user" } });
assert(r.status === 200 && r.data.message === GENERIC_MSG, "unknown username still gets the generic 'sent' message (no enumeration)");

r = await call(adminAuthMod, "POST", "/admin-auth", { body: { action: "requestPasswordReset", username: "" } });
assert(r.status === 200 && r.data.message === GENERIC_MSG, "empty username also gets the generic message, not a validation error");

r = await call(adminAuthMod, "POST", "/admin-auth", { body: { action: "requestPasswordReset", username: "root" } });
assert(r.status === 200 && r.data.message === GENERIC_MSG, "real username with an email on file gets the exact same generic message");

// --- resetPassword: end-to-end happy path using a token minted the same way the email link's token is ---
const admins = await authLib.loadAdmins();
const rootAdmin = admins.find((a) => a.id === rootId);
const resetToken = authLib.newPasswordResetToken(rootAdmin);

r = await call(adminAuthMod, "POST", "/admin-auth", { body: { action: "resetPassword", token: resetToken, newPassword: "short" } });
assert(r.status === 400, "resetPassword rejects a too-short new password before even checking the token");

r = await call(adminAuthMod, "POST", "/admin-auth", { body: { action: "resetPassword", token: "not-a-real-token", newPassword: "brandnewpw1" } });
assert(r.status === 401, "resetPassword rejects a garbage/malformed token");

r = await call(adminAuthMod, "POST", "/admin-auth", { body: { action: "resetPassword", token: resetToken, newPassword: "brandnewpw1" } });
assert(r.status === 200 && r.data.token && r.data.admin.username === "root", "valid reset token + valid new password succeeds and logs the admin straight in");
const postResetSessionToken = r.data.token;

r = await call(adminAuthMod, "POST", "/admin-auth", { body: { action: "login", username: "root", password: "originalpw1" } });
assert(r.status === 401, "the OLD password no longer works after the reset");

r = await call(adminAuthMod, "POST", "/admin-auth", { body: { action: "login", username: "root", password: "brandnewpw1" } });
assert(r.status === 200, "the NEW password works");

// --- single-use enforcement: the same token (and any other outstanding token for the same account) is dead after use ---
r = await call(adminAuthMod, "POST", "/admin-auth", { body: { action: "resetPassword", token: resetToken, newPassword: "anotherpw1" } });
assert(r.status === 401 && /invalid|expired|already used/i.test(r.data.error), "reusing the same reset token a second time fails - got: " + JSON.stringify(r.data));

// mint TWO valid tokens for the same account before either is used, then use only one
const adminsNow = await authLib.loadAdmins();
const rootAdminNow = adminsNow.find((a) => a.id === rootId);
const tokenA = authLib.newPasswordResetToken(rootAdminNow);
const tokenB = authLib.newPasswordResetToken(rootAdminNow);
r = await call(adminAuthMod, "POST", "/admin-auth", { body: { action: "resetPassword", token: tokenA, newPassword: "secondpw123" } });
assert(r.status === 200, "tokenA (minted before either was used) successfully resets the password");
r = await call(adminAuthMod, "POST", "/admin-auth", { body: { action: "resetPassword", token: tokenB, newPassword: "thirdpw1234" } });
assert(r.status === 401, "tokenB, minted for the same account before tokenA was used, is ALSO invalidated by tokenA's use - zero extra storage needed");

// --- expiry: a token whose exp has already passed is rejected, independent of the fingerprint check ---
const adminsForExpiry = await authLib.loadAdmins();
const rootAdminForExpiry = adminsForExpiry.find((a) => a.id === rootId);
const freshToken = authLib.newPasswordResetToken(rootAdminForExpiry);
const freshPayload = authLib.verifyToken(freshToken); // not expired yet, so this decodes fine
const expiredToken = authLib.signToken({ ...freshPayload, exp: Date.now() - 1000 });
r = await call(adminAuthMod, "POST", "/admin-auth", { body: { action: "resetPassword", token: expiredToken, newPassword: "expiredflow1" } });
assert(r.status === 401, "an expired reset token is rejected even though its fingerprint is still valid");

// --- purpose-scoping: a password-reset token can never be used as a normal session token ---
const anotherResetToken = authLib.newPasswordResetToken(rootAdminForExpiry);
r = await call(adminAuthMod, "POST", "/admin-auth", { headers: { "x-admin-token": anotherResetToken }, body: { action: "whoami" } });
assert(r.status === 401, "a password-reset token is rejected outright as a session token by resolveAdmin(), regardless of validity as a reset token");

// the actual post-reset SESSION token (from the earlier successful reset), by contrast, DOES work as a session -
// ordinary sessions are keyed only on {id, exp}, not on the password hash, so later password changes don't
// retroactively revoke an already-issued session (a separate, deliberate design tradeoff from the reset-token's
// hash-fingerprint binding, which exists specifically because reset tokens are the one credential meant to be emailed).
r = await call(adminAuthMod, "POST", "/admin-auth", { headers: { "x-admin-token": postResetSessionToken }, body: { action: "whoami" } });
assert(r.status === 200 && r.data.admin.username === "root", "the normal session token issued by the reset still works as a session, unaffected by later password changes");

console.log("\n" + (failures === 0 ? "ALL PASSWORD-RESET TESTS PASSED" : `${failures} TEST(S) FAILED`));
process.exit(failures === 0 ? 0 : 1);
