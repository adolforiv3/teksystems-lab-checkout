import { scryptSync, randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { adminRegistryStore } from "./stores.mjs";
import { updateJSON } from "./occ.mjs";

// Kept as a superadmin bootstrap/recovery key even after real admin accounts
// exist, per explicit product decision - avoids permanent lockout risk.
const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE || "labadmin";
const TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET || "lab-checkout-dev-secret-change-me";
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}
function fromB64url(str) {
  return Buffer.from(str, "base64url");
}

export function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

export function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  const attempt = scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(attempt, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function signToken(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", TOKEN_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", TOKEN_SECRET).update(body).digest("base64url");
  const sigBuf = Buffer.from(sig, "utf8");
  const expBuf = Buffer.from(expected, "utf8");
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const payload = JSON.parse(fromB64url(body).toString("utf8"));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload; // { id, exp }
  } catch {
    return null;
  }
}

export function newSessionToken(adminId) {
  return signToken({ id: adminId, exp: Date.now() + TOKEN_TTL_MS });
}

// --- Password reset tokens ---
//
// A distinct token kind from a normal session token, deliberately: it's the
// one credential in this app designed to be emailed, so it needs much
// tighter blast radius than a 12-hour full-access session token. Two things
// enforce that:
//
// 1. `purpose: "password-reset"` marks it as scoped - resolveAdmin() below
//    explicitly refuses to accept any token carrying a `purpose` field as a
//    normal session, so a captured reset link can never be replayed as
//    general account access, only through the dedicated reset action.
// 2. A short TTL (30 min) *and* a fingerprint of the account's password
//    hash at issuance time. Reset tokens are stateless signed values with
//    nothing server-side to revoke on first use, so without this a
//    forwarded/leaked link would stay valid for its entire window even
//    after being used once. Tying validity to "the hash hasn't changed
//    since this token was issued" means using the token to actually set a
//    new password immediately invalidates it (and any other outstanding
//    reset token for that account) for free, with no extra storage.
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

function hashFingerprint(hash) {
  return createHmac("sha256", TOKEN_SECRET).update(hash || "").digest("base64url").slice(0, 16);
}

export function newPasswordResetToken(admin) {
  return signToken({
    id: admin.id,
    purpose: "password-reset",
    hfp: hashFingerprint(admin.hash),
    exp: Date.now() + RESET_TOKEN_TTL_MS,
  });
}

// Resolves a password-reset token to the admin it's for, or null if it's
// missing/expired/malformed, not actually a reset-purpose token, or stale
// (the account's password has changed since this token was issued - either
// because this exact token was already used, or the password changed some
// other way in the meantime, either of which should invalidate it).
export async function resolvePasswordResetToken(token) {
  const payload = verifyToken(token);
  if (!payload || payload.purpose !== "password-reset" || !payload.id) return null;
  const admins = await loadAdmins();
  const admin = admins.find((a) => a.id === payload.id);
  if (!admin) return null;
  if (hashFingerprint(admin.hash) !== payload.hfp) return null;
  return admin;
}

export async function loadAdmins() {
  const store = adminRegistryStore();
  return (await store.get("admins", { type: "json" })) || [];
}

// OCC-safe read-modify-write for the admin registry. `mutate(admins)`
// receives the *current* array on every attempt (never a stale copy) and
// must return the new array, or throw a coded error (e.g. `{code:'CONFLICT'}`)
// to abort without retrying for a genuine business-rule failure (duplicate
// username, "can't demote the last superadmin", etc). Every writer of the
// admin registry (admins.mjs, admin-auth.mjs) goes through this so two
// simultaneous admin edits - or two people racing to bootstrap the very
// first account - can never silently overwrite one another.
export async function updateAdmins(mutate) {
  const store = adminRegistryStore();
  return updateJSON(store, "admins", async (current) => mutate(current || []));
}

// Strips password material before anything touches the client.
export function publicAdmin(a) {
  if (!a) return a;
  const { salt, hash, ...rest } = a;
  return rest; // { id, username, role, labs, createdAt }
}

function findByUsername(admins, username) {
  const key = (username || "").trim().toLowerCase();
  return admins.find((a) => a.username.toLowerCase() === key);
}

export { findByUsername };

// Resolves the requesting admin from either a bearer session token (normal
// path, issued at login) or the legacy shared passcode header (kept as an
// always-on superadmin bootstrap/recovery key). Returns a public admin shape
// or null.
export async function resolveAdmin(req) {
  const token = req.headers.get("x-admin-token");
  if (token) {
    const payload = verifyToken(token);
    // A token carrying a `purpose` field (e.g. a password-reset link) is
    // never accepted as a normal session, no matter how well-formed its
    // signature is - see newPasswordResetToken() above.
    if (payload && !payload.purpose) {
      const admins = await loadAdmins();
      const admin = admins.find((a) => a.id === payload.id);
      if (admin) return publicAdmin(admin);
    }
  }
  const legacy = req.headers.get("x-admin-passcode");
  if (legacy && legacy === ADMIN_PASSCODE) {
    return { id: "__bootstrap__", username: "master", role: "superadmin", labs: [] };
  }
  return null;
}

export function isSuperadmin(admin) {
  return !!admin && admin.role === "superadmin";
}

export function canAccessLab(admin, labId) {
  if (!admin) return false;
  if (admin.role === "superadmin") return true;
  return Array.isArray(admin.labs) && admin.labs.includes(labId);
}

export function checkMasterPasscode(passcode) {
  return !!passcode && passcode === ADMIN_PASSCODE;
}

// --- Classification / clearance ---
//
// Deliberately separate from lab access (canAccessLab above) and from
// superadmin status. A vendor being scoped to a lab (or a superadmin's
// blanket admin authority) only ever grants visibility into that lab's
// "standard" items. Seeing or touching a "black"/"ultraBlack" item requires
// an *explicit* clearance grant for that specific lab and tier - including
// for superadmins, and including for the legacy master-passcode bootstrap
// identity, neither of which carry any clearances by default. This is a
// deliberate least-privilege/need-to-know model: administrative authority
// over the app (creating labs, managing accounts) is not the same thing as
// being read into a specific compartment of what's stored in one of them.
const CLASSIFICATION_TIERS = { standard: 0, black: 1, ultraBlack: 2 };

export function isValidClassification(tier) {
  return Object.prototype.hasOwnProperty.call(CLASSIFICATION_TIERS, tier);
}

function classificationRank(tier) {
  return CLASSIFICATION_TIERS[tier] ?? 0;
}

// `admin.clearances` is an array of `{ labId, tier }` grants, managed only
// by superadmins via admins.mjs. A grant at tier "ultraBlack" also covers
// "black" for that same lab (clearance is a ceiling, not an exact match).
export function hasClearance(admin, labId, tier) {
  if (!tier || tier === "standard") return true;
  if (!admin) return false;
  const required = classificationRank(tier);
  return (
    Array.isArray(admin.clearances) &&
    admin.clearances.some((c) => c && c.labId === labId && classificationRank(c.tier) >= required)
  );
}
