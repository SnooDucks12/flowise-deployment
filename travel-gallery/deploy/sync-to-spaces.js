#!/usr/bin/env node
/* ============================================================
   Push the local photos/ folder + photos.js manifest into the
   Spaces bucket, so everything you uploaded via GitHub or disk
   appears in the cloud gallery too.

   Usage (after deploy/setup-digitalocean.js printed the env):
     SPACES_KEY=... SPACES_SECRET=... SPACES_BUCKET=... SPACES_REGION=... \
       node deploy/sync-to-spaces.js
   ============================================================ */
const fs = require("fs");
const path = require("path");

process.chdir(path.join(__dirname, ".."));
const spaces = require("../spaces");
if (!spaces.enabled()) {
  console.error("Set SPACES_KEY / SPACES_SECRET / SPACES_BUCKET / SPACES_REGION first.");
  process.exit(1);
}
spaces.init();

const ROOT = path.join(__dirname, "..");
const PHOTOS_DIR = path.join(ROOT, "photos");
const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif" };

(async () => {
  // read the local manifest for captions/notes/coords
  let local = { TRIPS: [], TOGETHER_SINCE: "2023-06-01" };
  try { new Function("window", fs.readFileSync(path.join(ROOT, "photos.js"), "utf8"))(local); } catch {}
  const localTrips = (local.TRIPS || []).filter((t) => t.photos.some((p) => !p.src.startsWith("demo-photos/")));

  const manifest = await spaces.loadManifest();
  manifest.since = local.TOGETHER_SINCE || manifest.since;

  let uploaded = 0;
  for (const t of localTrips) {
    // find the on-disk folder for this trip
    const folder = fs.readdirSync(PHOTOS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .find((n) => n.toLowerCase().includes(t.title.toLowerCase()) || n.endsWith(t.title));
    if (!folder) { console.log(`skip trip (no folder found): ${t.title}`); continue; }

    let trip = manifest.trips.find((x) => x.id === t.id);
    if (!trip) {
      trip = { id: t.id, folder, title: t.title, location: t.location, date: t.date,
               sortKey: folder.slice(0, 7), note: t.note || "", photos: [] };
      if (t.coords) trip.coords = t.coords;
      if (t.place) trip.place = t.place;
      manifest.trips.push(trip);
    } else {
      trip.note = t.note || trip.note; // hand-written notes win
    }

    for (const p of t.photos) {
      const rel = p.full || p.src;                       // original file
      const abs = path.join(ROOT, decodeURI(rel));
      if (!fs.existsSync(abs)) { console.log(`  skip (missing): ${rel}`); continue; }
      const name = path.basename(abs);
      const key = `photos/${folder}/${name}`;
      if (trip.photos.some((x) => x.key === key)) continue; // already synced

      await spaces.put(key, fs.readFileSync(abs), MIME[path.extname(abs).toLowerCase()] || "image/jpeg");
      const entry = { key, caption: p.caption || "" };
      if (p.src !== rel) { // there is a resized web copy on disk
        const webAbs = path.join(ROOT, decodeURI(p.src));
        if (fs.existsSync(webAbs)) {
          entry.webKey = `photos/${folder}/.web/${path.basename(webAbs)}`;
          await spaces.put(entry.webKey, fs.readFileSync(webAbs), "image/jpeg");
        }
      }
      for (const k of ["coords", "place", "taken", "date", "camera"]) if (p[k]) entry[k] = p[k];
      trip.photos.push(entry);
      uploaded++;
      console.log(`  ↑ ${key}`);
    }
    trip.photos.sort((a, b) => (a.taken || "9999").localeCompare(b.taken || "9999"));
  }

  manifest.trips.sort((a, b) => (b.sortKey || "").localeCompare(a.sortKey || ""));
  await spaces.saveManifest(manifest);
  console.log(`✨ Synced ${uploaded} photo(s). The cloud gallery is up to date.`);
})().catch((e) => { console.error("✗", e.message); process.exit(1); });
