import { getStore } from "@netlify/blobs";

// The original lab keeps the legacy store name so its existing data never
// needs to be migrated; every other lab gets its own dedicated store.
export function storeNameForLab(labId) {
  const safe = (labId || "").toLowerCase().replace(/[^a-z0-9-]/g, "") || "groomlake";
  return safe === "groomlake" ? "lab-checkout" : `lab-checkout-${safe}`;
}

// Every store this app uses is small and low-QPS (one inventory/checkout
// log per lab, one lab registry, one admin registry) - there is no
// throughput reason to accept Netlify Blobs' default *eventual*
// consistency, which only guarantees writes are visible everywhere within
// 60 seconds. That default is meant for high-traffic, cache-heavy
// workloads; here it just means an admin's edit or a shopper's checkout
// could silently appear to not have happened for up to a minute depending
// on which edge location serves the next read. `strong` consistency trades
// a little extra read latency (still fast - this isn't a high-QPS app) for
// "every read sees every prior write," which combined with the optimistic
// -concurrency helper in lib/occ.mjs is what makes read-modify-write
// operations on these stores actually safe.
export function labStore(labId) {
  return getStore({ name: storeNameForLab(labId), consistency: "strong" });
}
export function labRegistryStore() {
  return getStore({ name: "lab-registry", consistency: "strong" });
}
export function adminRegistryStore() {
  return getStore({ name: "admin-registry", consistency: "strong" });
}
