import { resolveAdmin, isSuperadmin, canAccessLab, hasClearance, isValidClassification } from "./lib/auth.mjs";
import { labRegistryStore } from "./lib/stores.mjs";
import { updateJSON, ConcurrentWriteError } from "./lib/occ.mjs";
import { json, withErrorBoundary } from "./lib/http.mjs";
import {
  loadLabsForRead,
  mutateLabs,
  resolveLab,
  labsVisibleTo,
  publicLab,
  adminLab,
  slugify,
  generateAccessToken,
} from "./lib/lab-registry.mjs";

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export default withErrorBoundary(async (req) => {
  const url = new URL(req.url);
  const store = labRegistryStore();
  const method = req.method;
  const admin = await resolveAdmin(req);

  if (method === "GET") {
    const token = url.searchParams.get("token");

    if (token) {
      // The only anonymous-accessible lookup: resolve exactly one lab by
      // its unguessable access token. This is what a vendor's private
      // share link points at - it reveals nothing about any other lab,
      // unlike the old "list every lab" picker this replaces.
      const lab = await resolveLab(token, admin);
      if (!lab) return json({ error: "lab not found" }, 404);
      return json(publicLab(lab));
    }

    // No token: this is now an admin-management request, not a public
    // listing. Anyone without a valid session gets nothing - not even an
    // empty confirmation that the endpoint exists in a useful way.
    if (!admin) return json({ error: "unauthorized" }, 401);
    const labs = await loadLabsForRead(store);
    return json(labsVisibleTo(labs, admin).map(adminLab));
  }

  try {
    if (method === "POST") {
      // Creating a brand new lab is a registry-level action - superadmin only.
      if (!isSuperadmin(admin)) return json({ error: "superadmin access required" }, 403);
      const body = await req.json();
      const name = (body.name || "").trim();
      if (!name) return json({ error: "lab name required" }, 400);
      const classification =
        typeof body.classification === "string" && body.classification ? body.classification : "standard";
      if (!isValidClassification(classification)) {
        return json({ error: "invalid classification tier" }, 400);
      }
      // A superadmin creating a classified lab still needs their own
      // clearance for it, same rule as classified items - creating one
      // doesn't require having been previously cleared for it by someone
      // else, since they're the one bringing it into existence, but they
      // won't be able to see it again afterward without a clearance grant
      // (avoids a superadmin accidentally locking a lab away from
      // themselves; this is a deliberate warning surface rather than a
      // silent trap).

      let createdLab = null; // set fresh inside the mutator on whichever attempt actually wins
      const labs = await mutateLabs(store, (labs) => {
        let id = slugify(name);
        // avoid id collisions - re-checked fresh every attempt
        if (labs.some((l) => l.id === id)) {
          let n = 2;
          while (labs.some((l) => l.id === `${id}-${n}`)) n++;
          id = `${id}-${n}`;
        }
        const lab = {
          id,
          name,
          accessToken: generateAccessToken(),
          classification,
          createdAt: new Date().toISOString(),
        };
        if (body.entryPasscode) lab.entryPasscode = String(body.entryPasscode);
        createdLab = lab;
        return [...labs, lab];
      });
      return json(
        {
          labs: labsVisibleTo(labs, admin).map(adminLab),
          created: adminLab(createdLab),
          warning:
            classification !== "standard" && !hasClearance(admin, createdLab.id, classification)
              ? "This lab was created at a classification tier you don't currently hold clearance for - grant yourself clearance from Admin Accounts or you won't be able to see it again."
              : undefined,
        },
        201
      );
    }

    if (method === "PATCH") {
      // Renaming / setting a lab's own passcode / (re)issuing its access
      // token is allowed for a superadmin or for the lab-admin(s) assigned
      // to that specific lab.
      const body = await req.json(); // { id, name?, entryPasscode?, classifiedReleaseCode?, regenerateToken?, classification? } - entryPasscode/classifiedReleaseCode: "" clears it
      // 401 = no valid session at all; 403 = valid session, wrong lab scope.
      if (!canAccessLab(admin, body.id)) {
        return json({ error: admin ? "you don't have access to this lab" : "unauthorized" }, admin ? 403 : 401);
      }
      const labs = await mutateLabs(store, (labs) => {
        const idx = labs.findIndex((l) => l.id === body.id);
        if (idx === -1) throw new ApiError("lab not found", 404);
        const updated = { ...labs[idx] };
        if (typeof body.name === "string" && body.name.trim()) updated.name = body.name.trim();
        if (typeof body.entryPasscode === "string") {
          if (body.entryPasscode) updated.entryPasscode = body.entryPasscode;
          else delete updated.entryPasscode;
        }
        if (typeof body.classifiedReleaseCode === "string") {
          // This is the checkout-time "yes, you can take this restricted
          // device" code (see checkouts.mjs's POST handler) - a completely
          // separate secret from entryPasscode (which just gates *viewing*
          // the lab) and from admin clearance (which is what lets an admin
          // check one out with no code at all). Same permission level as
          // every other lab setting here: any admin already scoped to this
          // lab can set/change/clear it, no clearance grant required -
          // this is an operational front-desk setting, not a confidentiality
          // credential in itself.
          if (body.classifiedReleaseCode) updated.classifiedReleaseCode = body.classifiedReleaseCode;
          else delete updated.classifiedReleaseCode;
        }
        if (body.regenerateToken) {
          // Invalidates the previously shared link immediately - anyone
          // still holding the old link loses access. Use when a link may
          // have leaked outside its intended vendor.
          updated.accessToken = generateAccessToken();
        }
        if (body.classification !== undefined) {
          if (!isValidClassification(body.classification)) {
            throw new ApiError("invalid classification tier", 400);
          }
          if (body.classification !== "standard" && !hasClearance(admin, body.id, body.classification)) {
            throw new ApiError(`insufficient clearance to set this lab to "${body.classification}"`, 403);
          }
          updated.classification = body.classification;
        }
        const next = [...labs];
        next[idx] = updated;
        return next;
      });
      const updatedLab = labs.find((l) => l.id === body.id);
      return json({
        labs: labsVisibleTo(labs, admin).map(adminLab),
        updated: updatedLab ? adminLab(updatedLab) : undefined,
      });
    }

    if (method === "DELETE") {
      // Removing a lab from the registry entirely is superadmin-only.
      if (!isSuperadmin(admin)) return json({ error: "superadmin access required" }, 403);
      const { id } = await req.json();
      const labs = await mutateLabs(store, (labs) => labs.filter((l) => l.id !== id));
      return json(labsVisibleTo(labs, admin).map(adminLab));
    }
  } catch (err) {
    if (err instanceof ApiError) return json({ error: err.message }, err.status);
    if (err instanceof ConcurrentWriteError) {
      return json({ error: "too much contention updating the labs list - please retry" }, 409);
    }
    throw err;
  }

  return json({ error: "method not allowed" }, 405);
});
