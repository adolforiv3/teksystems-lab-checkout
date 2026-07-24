// Coverage for the company-wide inventory view: GET /inventory?all=1
// aggregates every lab a superadmin can see into one list, each item tagged
// with which lab it came from. Superadmin-only.
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

let r = await call(adminAuthMod, "POST", "/admin-auth", { body: { action: "bootstrap", masterPasscode: "masterpass123", username: "root", password: "supersecret" } });
const rootToken = r.data.token;

r = await call(labsMod, "GET", "/labs", { headers: { "x-admin-token": rootToken } });
const groomlakeName = r.data.find((l) => l.id === "groomlake").name;

r = await call(labsMod, "POST", "/labs", { headers: { "x-admin-token": rootToken }, body: { name: "Lab Two" } });
assert(r.status === 201, "root creates Lab Two");
const labTwoId = r.data.created.id;

r = await call(inventoryMod, "POST", `/inventory?lab=groomlake`, { headers: { "x-admin-token": rootToken }, body: { name: "Widget", qty: 20 } });
const widget = r.data.find((i) => i.name === "Widget");
r = await call(inventoryMod, "POST", `/inventory?lab=${labTwoId}`, { headers: { "x-admin-token": rootToken }, body: { name: "Gizmo", qty: 10 } });
const gizmo = r.data.find((i) => i.name === "Gizmo");

// Admin-attributed checkout (root is scoped to every lab as superadmin) so
// there's a real checked-out/available split to verify in the aggregate.
r = await call(checkoutsMod, "POST", "/checkouts?lab=groomlake", {
  headers: { "x-admin-token": rootToken },
  body: { name: "Erin", email: "erin@example.com", indefinite: true, items: [{ itemId: widget.id, name: "Widget", qty: 5 }] },
});
assert(r.status === 201, "root assigns 5 widgets to Erin");

// --- happy path: superadmin sees both labs' items, tagged and totalled correctly ---
r = await call(inventoryMod, "GET", "/inventory?all=1", { headers: { "x-admin-token": rootToken } });
assert(r.status === 200, "superadmin can load the company-wide view");
let widgetRow = r.data.find((row) => row.id === widget.id);
let gizmoRow = r.data.find((row) => row.id === gizmo.id);
assert(!!widgetRow && !!gizmoRow, "both labs' items show up in the aggregate");
assert(widgetRow.labId === "groomlake" && widgetRow.labName === groomlakeName, "the widget row is tagged with groomlake's id and name");
assert(gizmoRow.labId === labTwoId && gizmoRow.labName === "Lab Two", "the gizmo row is tagged with Lab Two's id and name");
assert(widgetRow.qty === 20 && widgetRow.available === 15, "widget: 20 on hand, 15 available after the 5-unit checkout");
assert(gizmoRow.qty === 10 && gizmoRow.available === 10, "gizmo: untouched, still fully available");

assert(
  r.data.every((row, i) => i === 0 || (r.data[i - 1].labName <= row.labName) || r.data[i - 1].labId === row.labId),
  "rows arrive grouped by lab (sorted by lab name)"
);

// --- access control: not reachable by anyone but a superadmin ---
r = await call(inventoryMod, "GET", "/inventory?all=1", {});
assert(r.status === 401, "anonymous caller is rejected with 401, not a partial/empty list");

r = await call(adminsMod, "POST", "/admins", { headers: { "x-admin-token": rootToken }, body: { username: "labtech", password: "labtechpw1", role: "labadmin", labs: ["groomlake", labTwoId] } });
r = await call(adminAuthMod, "POST", "/admin-auth", { body: { action: "login", username: "labtech", password: "labtechpw1" } });
const labtechToken = r.data.token;
r = await call(inventoryMod, "GET", "/inventory?all=1", { headers: { "x-admin-token": labtechToken } });
assert(r.status === 403, "a regular lab-admin gets 403, even though they're scoped to both labs - this view is superadmin-only");

console.log("\n" + (failures === 0 ? "ALL COMPANY-INVENTORY TESTS PASSED" : `${failures} TEST(S) FAILED`));
process.exit(failures === 0 ? 0 : 1);
