#!/usr/bin/env node
/* ============================================================
   Wanderlight manifest generator — with metadata magic ✨
   ------------------------------------------------------------
   Scans ./photos/<YYYY-MM Trip Name>/ folders and rewrites
   photos.js. On top of the basics it can now:

   • Read EXIF from your photos — date taken, GPS position,
    camera model. (optional: npm install exifr)
   • Reverse-geocode GPS into real place names — "Positano,
    Italy" instead of coordinates. Uses the free OpenStreetMap
    Nominatim API at generation time; results are cached in
    .geocache.json so each place is only looked up once.
   • Auto-resize huge photos for fast loading. (optional:
    npm install sharp) Web copies go to photos/<trip>/.web/
    (max 1800px). Originals are never touched.
   • Sort photos inside a trip by the moment they were taken.
   • PRESERVE your hand-written captions, quotes and trip notes
    across re-runs — edit photos.js freely, then re-run safely.

   Usage:
     node generate-manifest.js            # basic
     npm install exifr sharp && node generate-manifest.js   # full magic

   Folder layout:
     photos/
       2024-06 Amalfi Coast/
         boat-day.jpg        ← filename becomes the caption
       2025-01 Lapland/
         aurora.heic         ← note: browsers can't show HEIC;
                              export iPhone photos as JPEG
                              ("Most Compatible") first.
   ============================================================ */
const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = __dirname;
const PHOTOS_DIR = path.join(ROOT, "photos");
const OUT = path.join(ROOT, "photos.js");
const GEOCACHE = path.join(ROOT, ".geocache.json");
const UPLOADS_META = path.join(ROOT, ".uploads-meta.json"); // written by server.js /upload
const IMG_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"]);
const MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEB_MAX = 1800; // px, long edge for resized web copies

// ---------- optional dependencies, degrade gracefully ----------
let exifr = null, sharp = null;
try { exifr = require("exifr"); } catch { console.log("ℹ exifr not installed — skipping EXIF magic (npm install exifr)"); }
try { sharp = require("sharp"); } catch { console.log("ℹ sharp not installed — skipping auto-resize (npm install sharp)"); }

// ---------- preserve what humans wrote ----------
let since = "2023-06-01";
const keepCaption = new Map(); // src basename -> caption
const keepNote = new Map();    // trip id -> note
const keepTitle = new Map();   // trip id -> {title, location}
try {
  const prevSrc = fs.readFileSync(OUT, "utf8");
  const m = prevSrc.match(/TOGETHER_SINCE\s*=\s*"([^"]+)"/);
  if (m) since = m[1];
  // Evaluate the old manifest in a sandbox-ish way to harvest edits
  const sandbox = { window: {} };
  new Function("window", prevSrc)(sandbox.window);
  for (const t of sandbox.window.TRIPS || []) {
    if (t.note) keepNote.set(t.id, t.note);
    keepTitle.set(t.id, { title: t.title, location: t.location });
    for (const p of t.photos || []) {
      if (p.caption) keepCaption.set(path.basename(p.src), p.caption);
    }
  }
} catch { /* first run, nothing to preserve */ }

// ---------- phone-upload sidecar (browser location, upload time) ----------
let uploadsMeta = {};
try { uploadsMeta = JSON.parse(fs.readFileSync(UPLOADS_META, "utf8")); } catch {}

// ---------- geocode cache ----------
let geocache = {};
try { geocache = JSON.parse(fs.readFileSync(GEOCACHE, "utf8")); } catch {}

function geoKey(lat, lon) { return `${lat.toFixed(2)},${lon.toFixed(2)}`; }

function reverseGeocode(lat, lon) {
  const key = geoKey(lat, lon);
  if (geocache[key] !== undefined) return Promise.resolve(geocache[key]);
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=10&accept-language=en`;
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { "User-Agent": "wanderlight-gallery/1.0 (personal travel site)" } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          const j = JSON.parse(body);
          const a = j.address || {};
          const place = [a.city || a.town || a.village || a.municipality || a.county, a.country]
            .filter(Boolean).join(", ") || null;
          geocache[key] = place;
          resolve(place);
        } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- main ----------
(async () => {
  if (!fs.existsSync(PHOTOS_DIR)) {
    console.error("No ./photos folder found. Create it, add trip folders, and re-run.");
    process.exit(1);
  }

  const tripDirs = fs.readdirSync(PHOTOS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."));

  const trips = [];
  for (const dir of tripDirs) {
    const m = dir.name.match(/^(\d{4})-(\d{2})\s+(.+)$/);
    const title = m ? m[3] : dir.name;
    const date = m ? `${MONTHS[parseInt(m[2], 10)] || m[2]} ${m[1]}` : "";
    const sortKey = m ? `${m[1]}-${m[2]}` : "0000-00";
    const id = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const tripPath = path.join(PHOTOS_DIR, dir.name);
    const files = fs.readdirSync(tripPath).filter((f) => IMG_EXT.has(path.extname(f).toLowerCase())).sort();

    const photos = [];
    for (const f of files) {
      const abs = path.join(tripPath, f);
      // caption priority: human edit in photos.js > caption typed at upload > cleaned filename
      const derived = path.basename(f, path.extname(f))
        .replace(/[-_]+/g, " ")
        .replace(/\b(img|dsc|pxl|screenshot)\s*\d*\b/gi, "")
        .replace(/\s[a-z0-9]{8}$/i, "") // strip the upload timestamp suffix
        .trim();
      const prev = keepCaption.get(f);
      const humanEdited = prev && prev !== derived && prev !== (uploadsMeta[f] && uploadsMeta[f].caption);
      const photo = {
        src: `photos/${dir.name}/${f}`,
        caption: humanEdited ? prev : ((uploadsMeta[f] && uploadsMeta[f].caption) || derived),
      };

      // --- EXIF: date taken, GPS, camera ---
      if (exifr) {
        try {
          const ex = await exifr.parse(abs, { pick: ["DateTimeOriginal", "Model", "latitude", "longitude"] });
          if (ex) {
            if (ex.DateTimeOriginal) {
              const d = new Date(ex.DateTimeOriginal);
              photo.taken = d.toISOString();
              photo.date = `${d.getDate()} ${MONTHS[d.getMonth() + 1]} ${d.getFullYear()}`;
            }
            if (ex.Model) photo.camera = String(ex.Model).trim();
            if (typeof ex.latitude === "number" && typeof ex.longitude === "number") {
              photo.coords = [+ex.latitude.toFixed(5), +ex.longitude.toFixed(5)];
            }
          }
        } catch { /* unreadable EXIF is fine */ }
      }

      // --- phone-upload sidecar fills gaps EXIF couldn't ---
      const um = uploadsMeta[f];
      if (um) {
        if (um.coords && !photo.coords) photo.coords = um.coords;
        if (um.uploaded && !photo.taken) {
          const d = new Date(um.uploaded);
          photo.taken = d.toISOString();
          photo.date = `${d.getDate()} ${MONTHS[d.getMonth() + 1]} ${d.getFullYear()}`;
        }
      }

      // --- resize for the web ---
      if (sharp) {
        try {
          const meta = await sharp(abs).metadata();
          if (Math.max(meta.width || 0, meta.height || 0) > WEB_MAX) {
            const webDir = path.join(tripPath, ".web");
            fs.mkdirSync(webDir, { recursive: true });
            const webName = path.basename(f, path.extname(f)) + ".jpg";
            const webAbs = path.join(webDir, webName);
            if (!fs.existsSync(webAbs) || fs.statSync(webAbs).mtimeMs < fs.statSync(abs).mtimeMs) {
              await sharp(abs).rotate().resize(WEB_MAX, WEB_MAX, { fit: "inside" }).jpeg({ quality: 84 }).toFile(webAbs);
            }
            photo.full = photo.src;                       // original, for the lightbox
            photo.src = `photos/${dir.name}/.web/${webName}`; // fast copy, for the grid
          }
        } catch { /* not resizable (e.g. HEIC without codec) — use original */ }
      }

      photos.push(photo);
    }

    if (photos.length === 0) continue;

    // sort by moment taken when we know it
    photos.sort((a, b) => (a.taken || "9999").localeCompare(b.taken || "9999"));

    // trip position = average of photo GPS points
    const gps = photos.filter((p) => p.coords);
    let coords = null;
    if (gps.length) {
      coords = [
        +(gps.reduce((s, p) => s + p.coords[0], 0) / gps.length).toFixed(4),
        +(gps.reduce((s, p) => s + p.coords[1], 0) / gps.length).toFixed(4),
      ];
    }

    const kept = keepTitle.get(id) || {};
    trips.push({
      id,
      title: kept.title || title,
      location: kept.location || title,
      date,
      sortKey,
      note: keepNote.get(id) || "",
      ...(coords ? { coords } : {}),
      photos,
    });
  }

  if (trips.length === 0) {
    console.error("Found ./photos but no images inside trip folders. Nothing written.");
    process.exit(1);
  }

  trips.sort((a, b) => b.sortKey.localeCompare(a.sortKey)); // newest first
  trips.forEach((t) => delete t.sortKey);

  // --- reverse-geocode places (photo-level + trip-level) ---
  const toGeo = [];
  for (const t of trips) {
    if (t.coords) toGeo.push({ set: (v) => { if (v) t.place = v; }, c: t.coords });
    for (const p of t.photos) if (p.coords) toGeo.push({ set: (v) => { if (v) p.place = v; }, c: p.coords });
  }
  const uniq = new Set(toGeo.map((g) => geoKey(g.c[0], g.c[1])));
  const uncached = [...uniq].filter((k) => geocache[k] === undefined);
  if (toGeo.length) {
    console.log(`🌍 ${uniq.size} unique places (${uncached.length} to look up via OpenStreetMap)…`);
    for (const g of toGeo) {
      const wasCached = geocache[geoKey(g.c[0], g.c[1])] !== undefined;
      g.set(await reverseGeocode(g.c[0], g.c[1]));
      if (!wasCached) await sleep(1100); // Nominatim rate limit: 1 req/s
    }
    fs.writeFileSync(GEOCACHE, JSON.stringify(geocache, null, 1));
  }

  const body = `/* Generated by generate-manifest.js — ${trips.length} trip(s).
   Your captions, quotes and notes are PRESERVED across re-runs:
   edit them right here, then re-run the script safely. */

window.TOGETHER_SINCE = ${JSON.stringify(since)};

window.TRIPS = ${JSON.stringify(trips, null, 2)};
`;
  fs.writeFileSync(OUT, body);

  const nPhotos = trips.reduce((n, t) => n + t.photos.length, 0);
  const nGps = trips.reduce((n, t) => n + t.photos.filter((p) => p.coords).length, 0);
  const nDated = trips.reduce((n, t) => n + t.photos.filter((p) => p.taken).length, 0);
  console.log(`✨ Wrote photos.js — ${trips.length} trips, ${nPhotos} photos (${nDated} dated, ${nGps} with GPS).`);
  if (!exifr) console.log("   Tip: `npm install exifr` unlocks dates, GPS places & the constellation map.");
  if (!sharp) console.log("   Tip: `npm install sharp` auto-resizes big photos so the site stays fast.");
})();
