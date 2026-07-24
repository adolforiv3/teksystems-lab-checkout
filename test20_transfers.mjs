// Coverage for lab-to-lab transfers: the core rule is that stock only ever
// leaves the lab that actually owns it once THAT lab's own admin approves -
// whether the transfer was proposed as a "send" (source pushes out, but the
// destination must still accept) or a "request" (destination asks by name,
// but the source alone decides what real stock actually fulfills it, never
// the requester pulling directly). This suite exercises exactly the
// scenario from the ask: "lab 1 admin can transfer to lab 2, but lab 2
// admin cannot just take from lab 1."
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
const transfersMod = await import("./functions/transfers.mjs");

function findByNote(list, note) {
  return list.find((t) => t.note === note && t.status === "pending") || list.find((t) => t.note === note);
}

let r = await call(adminAuthMod, "POST", "/admin-auth", { body: { action: "bootstrap", masterPasscode: "masterpass123", username: "root", password: "supersecret" } });
const rootToken = r.data.token;

r = await call(labsMod, "POST", "/labs", { headers: { "x-admin-token": rootToken }, body: { name: "Lab Two" } });
const labTwoId = r.data.created.id;

r = await call(adminsMod, "POST", "/admins", { headers: { "x-admin-token": rootToken }, body: { username: "lab1admin", password: "lab1adminpw", role: "labadmin", labs: ["groomlake"] } });
r = await call(adminAuthMod, "POST", "/admin-auth", { body: { action: "login", username: "lab1admin", password: "lab1adminpw" } });
const lab1Token = r.data.token;

r = await call(adminsMod, "POST", "/admins", { headers: { "x-admin-token": rootToken }, body: { username: "lab2admin", password: "lab2adminpw", role: "labadmin", labs: [labTwoId] } });
r = await call(adminAuthMod, "POST", "/admin-auth", { body: { action: "login", username: "lab2admin", password: "lab2adminpw" } });
const lab2Token = r.data.token;

r = await call(inventoryMod, "POST", "/inventory?lab=groomlake", { headers: { "x-admin-token": lab1Token }, body: { name: "Multimeter", qty: 10 } });
const multimeter = r.data.find((i) => i.name === "Multimeter");

// --- lab directory: names visible company-wide, inventory is not ---
r = await call(labsMod, "GET", "/labs?directory=1", { headers: { "x-admin-token": lab2Token } });
assert(r.status === 200 && r.data.some((l) => l.id === "groomlake"), "lab2admin's directory listing includes groomlake's name, even though they don't manage it");
r = await call(labsMod, "GET", "/labs", { headers: { "x-admin-token": lab2Token } });
assert(!r.data.some((l) => l.id === "groomlake"), "lab2admin's normal admin-management lab listing still excludes groomlake - directory visibility is strictly name-only");

// === SEND: lab1 proposes, lab2 must accept - the core "cannot just take" rule ===

// lab2 cannot propose a send FROM a lab it doesn't manage.
r = await call(transfersMod, "POST", "/transfers", {
  headers: { "x-admin-token": lab2Token },
  body: { sourceLabId: "groomlake", destinationLabId: labTwoId, direction: "send", items: [{ itemId: multimeter.id, qty: 3 }], note: "lab2-tries-to-send-from-groomlake" },
});
assert(r.status === 403, "lab2admin can't propose a send FROM groomlake - they don't manage the source lab");

// Insufficient stock is rejected up front.
r = await call(transfersMod, "POST", "/transfers", {
  headers: { "x-admin-token": lab1Token },
  body: { sourceLabId: "groomlake", destinationLabId: labTwoId, direction: "send", items: [{ itemId: multimeter.id, qty: 999 }], note: "too-much" },
});
assert(r.status === 409, "sending more than is available at the source is rejected at creation time");

// lab1 proposes a legitimate send.
r = await call(transfersMod, "POST", "/transfers", {
  headers: { "x-admin-token": lab1Token },
  body: { sourceLabId: "groomlake", destinationLabId: labTwoId, direction: "send", items: [{ itemId: multimeter.id, qty: 3 }], note: "send-to-deny" },
});
assert(r.status === 201, "lab1admin proposes a send to lab2");
let t = findByNote(r.data, "send-to-deny");
assert(t.status === "pending" && t.direction === "send", "the send is pending, proposed by lab1");

// The proposer (lab1) can't accept/deny their own send - only the destination can.
r = await call(transfersMod, "PATCH", "/transfers", { headers: { "x-admin-token": lab1Token }, body: { id: t.id, action: "accept" } });
assert(r.status === 403, "lab1admin (the proposer) can't accept their own send");

// lab2 (destination) denies it.
r = await call(transfersMod, "PATCH", "/transfers", { headers: { "x-admin-token": lab2Token }, body: { id: t.id, action: "deny", note: "don't need it" } });
assert(r.status === 200, "lab2admin denies the send");
t = r.data.find((x) => x.id === t.id);
assert(t.status === "denied", "status is denied");

r = await call(inventoryMod, "GET", "/inventory?lab=groomlake", { headers: { "x-admin-token": lab1Token } });
assert(r.data.find((i) => i.id === multimeter.id).qty === 10, "a denied send never touches source stock");

// A second, real send that actually gets accepted.
r = await call(transfersMod, "POST", "/transfers", {
  headers: { "x-admin-token": lab1Token },
  body: { sourceLabId: "groomlake", destinationLabId: labTwoId, direction: "send", items: [{ itemId: multimeter.id, qty: 3 }], note: "send-to-accept" },
});
t = findByNote(r.data, "send-to-accept");

r = await call(transfersMod, "PATCH", "/transfers", { headers: { "x-admin-token": lab2Token }, body: { id: t.id, action: "accept" } });
assert(r.status === 200, "lab2admin accepts the send");
t = r.data.find((x) => x.id === t.id);
assert(t.status === "accepted" && t.fulfilled.length === 1 && t.fulfilled[0].qty === 3, "accepted, with a fulfilled record of what actually moved");

r = await call(inventoryMod, "GET", "/inventory?lab=groomlake", { headers: { "x-admin-token": lab1Token } });
assert(r.data.find((i) => i.id === multimeter.id).qty === 7, "source (groomlake) decremented by 3 (10 -> 7)");

r = await call(inventoryMod, "GET", "/inventory?lab=" + labTwoId, { headers: { "x-admin-token": lab2Token } });
let labTwoMultimeter = r.data.find((i) => i.name === "Multimeter");
assert(!!labTwoMultimeter && labTwoMultimeter.qty === 3, "destination (Lab Two) got a new Multimeter record with qty 3 (it had none before)");

// Once resolved, it can't be acted on again.
r = await call(transfersMod, "PATCH", "/transfers", { headers: { "x-admin-token": lab2Token }, body: { id: t.id, action: "accept" } });
assert(r.status === 400, "accepting an already-resolved transfer is rejected");

// === REQUEST: lab2 asks by name, lab1 alone decides what real stock fulfills it ===

// lab1 cannot propose a request INTO a lab it doesn't manage.
r = await call(transfersMod, "POST", "/transfers", {
  headers: { "x-admin-token": lab1Token },
  body: { sourceLabId: "groomlake", destinationLabId: labTwoId, direction: "request", items: [{ name: "Multimeter", qty: 1 }], note: "lab1-tries-to-request-into-labtwo" },
});
assert(r.status === 403, "lab1admin can't propose a request INTO Lab Two - they don't manage the destination lab");

// lab2 requests two items from groomlake: one they'll actually get (partial
// fulfillment - they ask for more than groomlake wants to give), one
// groomlake doesn't stock at all.
r = await call(transfersMod, "POST", "/transfers", {
  headers: { "x-admin-token": lab2Token },
  body: {
    sourceLabId: "groomlake",
    destinationLabId: labTwoId,
    direction: "request",
    items: [{ name: "Multimeter", qty: 5 }, { name: "Cable Tester", qty: 2 }],
    note: "labtwo-request",
  },
});
assert(r.status === 201, "lab2admin requests items from groomlake, blind to groomlake's real stock");
t = findByNote(r.data, "labtwo-request");

// lab2 (the requester) can't fulfill/accept their own request - only groomlake can.
r = await call(transfersMod, "PATCH", "/transfers", { headers: { "x-admin-token": lab2Token }, body: { id: t.id, action: "accept", fulfillment: [{ itemId: multimeter.id, qty: 5 }] } });
assert(r.status === 403, "lab2admin (the requester) can't fulfill their own request - that would be exactly the 'just take it' case this model forbids");

// groomlake reviews and fulfills only what it actually has - skipping the
// Cable Tester it doesn't stock, rather than denying the whole thing.
r = await call(transfersMod, "PATCH", "/transfers", {
  headers: { "x-admin-token": lab1Token },
  body: { id: t.id, action: "accept", fulfillment: [{ itemId: multimeter.id, qty: 5 }] },
});
assert(r.status === 200, "lab1admin fulfills the request against its own real inventory");
t = r.data.find((x) => x.id === t.id);
assert(t.status === "accepted" && t.fulfilled.length === 1 && t.fulfilled[0].name === "Multimeter" && t.fulfilled[0].qty === 5, "fulfilled with real Multimeter x5 - the Cable Tester line was simply skipped, not denied");

r = await call(inventoryMod, "GET", "/inventory?lab=groomlake", { headers: { "x-admin-token": lab1Token } });
assert(r.data.find((i) => i.id === multimeter.id).qty === 2, "groomlake's Multimeter decremented again (7 -> 2)");

r = await call(inventoryMod, "GET", "/inventory?lab=" + labTwoId, { headers: { "x-admin-token": lab2Token } });
const labTwoMultimeters = r.data.filter((i) => i.name === "Multimeter");
assert(labTwoMultimeters.length === 1 && labTwoMultimeters[0].qty === 8, "Lab Two's existing Multimeter record merged by name (3 + 5 = 8) instead of creating a duplicate");

// === an individually-tracked item (carries a serial number) keeps its attribute + serial, and never merges into an existing same-name record ===
r = await call(inventoryMod, "POST", "/inventory?lab=groomlake", { headers: { "x-admin-token": lab1Token }, body: { name: "Spectrum Analyzer", qty: 1, attribute: "Rev B", serialNumber: "SA-9981" } });
const analyzer = r.data.find((i) => i.name === "Spectrum Analyzer");

r = await call(transfersMod, "POST", "/transfers", {
  headers: { "x-admin-token": lab1Token },
  body: { sourceLabId: "groomlake", destinationLabId: labTwoId, direction: "send", items: [{ itemId: analyzer.id, qty: 1 }], note: "tracked-send" },
});
assert(r.status === 201, "lab1admin sends the individually-tracked analyzer");
t = findByNote(r.data, "tracked-send");

r = await call(transfersMod, "PATCH", "/transfers", { headers: { "x-admin-token": lab2Token }, body: { id: t.id, action: "accept" } });
assert(r.status === 200, "lab2admin accepts it");

r = await call(inventoryMod, "GET", "/inventory?lab=" + labTwoId, { headers: { "x-admin-token": lab2Token } });
const labTwoAnalyzer = r.data.find((i) => i.name === "Spectrum Analyzer");
assert(!!labTwoAnalyzer && labTwoAnalyzer.attribute === "Rev B" && labTwoAnalyzer.serialNumber === "SA-9981" && labTwoAnalyzer.qty === 1, "a fresh record was created at the destination, preserving both attribute and serial number");

// === cancel: only the initiator can withdraw a still-pending proposal ===
r = await call(transfersMod, "POST", "/transfers", {
  headers: { "x-admin-token": lab1Token },
  body: { sourceLabId: "groomlake", destinationLabId: labTwoId, direction: "send", items: [{ itemId: multimeter.id, qty: 1 }], note: "to-cancel" },
});
t = findByNote(r.data, "to-cancel");

r = await call(transfersMod, "PATCH", "/transfers", { headers: { "x-admin-token": lab2Token }, body: { id: t.id, action: "cancel" } });
assert(r.status === 403, "the destination (non-initiator) can't cancel a proposal it didn't make");

r = await call(transfersMod, "PATCH", "/transfers", { headers: { "x-admin-token": lab1Token }, body: { id: t.id, action: "cancel" } });
assert(r.status === 200, "lab1admin (the initiator) cancels its own pending proposal");
t = r.data.find((x) => x.id === t.id);
assert(t.status === "cancelled", "status is cancelled");

r = await call(transfersMod, "PATCH", "/transfers", { headers: { "x-admin-token": lab2Token }, body: { id: t.id, action: "accept" } });
assert(r.status === 400, "a cancelled transfer can no longer be accepted");

console.log("\n" + (failures === 0 ? "ALL TRANSFER TESTS PASSED" : `${failures} TEST(S) FAILED`));
process.exit(failures === 0 ? 0 : 1);
