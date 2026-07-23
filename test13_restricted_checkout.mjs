// Dedicated coverage for the "shoppers can check out Black/Ultra Black
// devices without clearance, via a lab-wide release passcode, but still
// can't see confidential fields or modify anything" feature:
//   - inventory.mjs: classified items are now checkout-visible (redacted)
//     to anonymous callers, while the admin/management view keeps the
//     original need-to-know model untouched.
//   - checkouts.mjs: checking one out requires clearance OR the lab's
//     current release passcode - for everyone, admins included.
//   - labs.mjs: the release passcode itself is a write-only admin setting,
//     never echoed back raw.
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

const labsMod = await import("./functions/labs.mjs");
const adminAuthMod = await import("./functions/admin-auth.mjs");
const adminsMod = await import("./functions/admins.mjs");
const inventoryMod = await import("./functions/inventory.mjs");
const checkoutsMod = await import("./functions/checkouts.mjs");

// --- setup: root superadmin, cleared for groomlake/black; an uncleared labadmin; a black item ---
let r = await call(adminAuthMod, "POST", "/admin-auth", { body: { action: "bootstrap", masterPasscode: "masterpass123", username: "root", password: "supersecret" } });
const rootToken = r.data.token;
const rootId = r.data.admin.id;
r = await call(adminsMod, "PATCH", "/admins", { headers: { "x-admin-token": rootToken }, body: { id: rootId, grantClearance: { labId: "groomlake", tier: "black" } } });
assert(r.status === 200, "root granted 'black' clearance for groomlake");

r = await call(adminsMod, "POST", "/admins", { headers: { "x-admin-token": rootToken }, body: { username: "labtech", password: "labtechpw1", role: "labadmin", labs: ["groomlake"] } });
assert(r.status === 201, "uncleared labtech created, scoped to groomlake");
r = await call(adminAuthMod, "POST", "/admin-auth", { body: { action: "login", username: "labtech", password: "labtechpw1" } });
const labtechToken = r.data.token;

r = await call(inventoryMod, "POST", "/inventory?lab=groomlake", {
  headers: { "x-admin-token": rootToken },
  body: { name: "Spectrum Analyzer", qty: 2, classification: "black", serialNumber: "SA-9981" },
});
assert(r.status === 200, "cleared root creates a black item with a serial number");
const analyzer = r.data.find((i) => i.name === "Spectrum Analyzer");

r = await call(inventoryMod, "POST", "/inventory?lab=groomlake", { headers: { "x-admin-token": rootToken }, body: { name: "Multimeter", qty: 10 } });
const meter = r.data.find((i) => i.name === "Multimeter");

// Anonymous callers can only ever resolve a lab by its unguessable access
// token, never the raw internal id (see lib/lab-registry.mjs's resolveLab)
// - fetch it here the same way a real shopper's share link would carry it.
r = await call(labsMod, "GET", "/labs", { headers: { "x-admin-token": rootToken } });
const groomlakeToken = r.data.find((l) => l.id === "groomlake").accessToken;
const anonLabParam = `lab=${encodeURIComponent(groomlakeToken)}`;

// --- GET /inventory as a true anonymous shopper: classified item is now VISIBLE, but redacted ---
r = await call(inventoryMod, "GET", `/inventory?${anonLabParam}`);
assert(r.status === 200, "anonymous GET succeeds");
const anonAnalyzer = r.data.find((i) => i.id === analyzer.id);
assert(!!anonAnalyzer, "the black item now appears in the anonymous shopper's inventory list");
assert(anonAnalyzer.restricted === true, "it's flagged generically as 'restricted'");
assert(anonAnalyzer.serialNumber === undefined, "the serial number is stripped from the anonymous response");
assert(anonAnalyzer.classification === undefined, "the exact tier ('black') is not exposed to the anonymous shopper either");
assert(anonAnalyzer.name === "Spectrum Analyzer" && anonAnalyzer.qty === 2, "name and qty still come through so it can be browsed/added to cart");
const anonMeter = r.data.find((i) => i.id === meter.id);
assert(anonMeter.restricted === undefined, "a standard item is completely unaffected - no restricted flag");

// --- GET /inventory as an UNCLEARED admin: unchanged need-to-know model - item still fully absent ---
r = await call(inventoryMod, "GET", "/inventory?lab=groomlake", { headers: { "x-admin-token": labtechToken } });
assert(!r.data.some((i) => i.id === analyzer.id), "an uncleared admin still can't see the black item at all - the admin-side model didn't change");

// --- GET /inventory as the CLEARED admin: full detail, unaffected ---
r = await call(inventoryMod, "GET", "/inventory?lab=groomlake", { headers: { "x-admin-token": rootToken } });
const clearedAnalyzer = r.data.find((i) => i.id === analyzer.id);
assert(clearedAnalyzer.serialNumber === "SA-9981", "the cleared admin still sees the full serial number");
assert(clearedAnalyzer.classification === "black", "the cleared admin still sees the real classification");

// --- an anonymous shopper still cannot MODIFY the restricted item, even though they can now see it ---
r = await call(inventoryMod, "PUT", `/inventory?${anonLabParam}`, { body: { id: analyzer.id, qty: 99 } });
assert(r.status === 401, "anonymous PUT on the restricted item is rejected (no admin session at all) - visibility never implied write access");

// --- checkout: no release passcode configured yet -> even a correctly-guessed code can't work, clear message ---
r = await call(checkoutsMod, "POST", `/checkouts?${anonLabParam}`, {
  body: { name: "Traveler", email: "traveler@example.com", indefinite: true, items: [{ itemId: analyzer.id, name: "Spectrum Analyzer", qty: 1 }] },
});
assert(r.status === 403 && /release passcode/i.test(r.data.error), "checkout of the restricted item fails before any code is set - got: " + JSON.stringify(r.data));

// --- admin sets the release passcode; never echoed back raw ---
r = await call(labsMod, "PATCH", "/labs", { headers: { "x-admin-token": rootToken }, body: { id: "groomlake", classifiedReleaseCode: "sesame-open" } });
assert(r.status === 200, "release passcode set");
assert(r.data.updated.restrictedCheckoutSet === true, "response confirms a code is now set...");
assert(r.data.updated.classifiedReleaseCode === undefined, "...but never echoes the raw code back");
assert(JSON.stringify(r.data).indexOf("sesame-open") === -1, "the raw code string doesn't appear anywhere in the PATCH response body");

// --- checkout: wrong code still rejected ---
r = await call(checkoutsMod, "POST", `/checkouts?${anonLabParam}`, {
  body: { name: "Traveler", email: "traveler@example.com", indefinite: true, items: [{ itemId: analyzer.id, name: "Spectrum Analyzer", qty: 1 }], releaseCode: "nope" },
});
assert(r.status === 403, "wrong release passcode is rejected");

// --- checkout: correct code succeeds, for a totally anonymous shopper, no clearance at all ---
r = await call(checkoutsMod, "POST", `/checkouts?${anonLabParam}`, {
  body: { name: "Traveler", email: "traveler@example.com", indefinite: true, items: [{ itemId: analyzer.id, name: "Spectrum Analyzer", qty: 1 }], releaseCode: "sesame-open" },
});
assert(r.status === 201, "correct release passcode lets an anonymous shopper check out the restricted device - got: " + JSON.stringify(r.data));
const travelerCheckoutId = r.data.id;

// --- a CLEARED admin needs no code at all ---
r = await call(checkoutsMod, "POST", "/checkouts?lab=groomlake", {
  headers: { "x-admin-token": rootToken },
  body: { name: "Root-Assigned", email: "assignee@example.com", indefinite: true, items: [{ itemId: analyzer.id, name: "Spectrum Analyzer", qty: 1 }] },
}); // no releaseCode in body at all
assert(r.status === 201, "a cleared admin can check the item out with zero release code, clearance alone suffices");

// --- availability math: anonymous GET /checkouts must include the restricted item's line so the shopper's 'available' count is correct ---
r = await call(checkoutsMod, "GET", `/checkouts?${anonLabParam}`);
const anonRecord = r.data.find((c) => c.id === travelerCheckoutId);
assert(!!anonRecord, "the anonymous shopper's own checkout record is visible in the anonymous checkout log");
assert(anonRecord.items.some((it) => it.itemId === analyzer.id), "...and it includes the restricted item's line, needed to compute remaining availability client-side");

// --- but an UNCLEARED admin still can't see who has the restricted device - need-to-know preserved for staff ---
r = await call(checkoutsMod, "GET", "/checkouts?lab=groomlake", { headers: { "x-admin-token": labtechToken } });
assert(!r.data.some((c) => c.id === travelerCheckoutId), "the uncleared labtech's checkout-log view still has the all-restricted record dropped entirely");

console.log("\n" + (failures === 0 ? "ALL RESTRICTED-CHECKOUT TESTS PASSED" : `${failures} TEST(S) FAILED`));
process.exit(failures === 0 ? 0 : 1);
