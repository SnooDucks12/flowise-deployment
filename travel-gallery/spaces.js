/* ============================================================
   Wanderlight cloud storage — DigitalOcean Spaces (S3-compatible)
   ------------------------------------------------------------
   Activated when these env vars are set (otherwise the server
   uses the local photos/ folder exactly as before):

     SPACES_KEY      access key        (from deploy/setup-digitalocean.js)
     SPACES_SECRET   secret key
     SPACES_BUCKET   bucket name       e.g. wanderlight-liina-ralf
     SPACES_REGION   region slug       e.g. fra1, ams3, nyc3
     SPACES_CDN      optional CDN base e.g. https://<bucket>.<region>.cdn.digitaloceanspaces.com

   Layout inside the bucket:
     photos/<YYYY-MM Trip>/<file>            originals (public)
     photos/<YYYY-MM Trip>/.web/<file>.jpg   resized copies (public)
     data/manifest.json                      the gallery manifest (private)
   ============================================================ */
const path = require("path");
const https = require("https");

const MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEB_MAX = 1800;

function enabled() {
  return Boolean(process.env.SPACES_KEY && process.env.SPACES_SECRET && process.env.SPACES_BUCKET && process.env.SPACES_REGION);
}

let s3 = null, sharp = null, exifr = null;
function init() {
  const { S3Client } = require("@aws-sdk/client-s3");
  const { s3RequestHandler } = require("./proxy-helper");
  const handler = s3RequestHandler();
  s3 = new S3Client({
    region: "us-east-1", // Spaces ignores this but the SDK requires it
    endpoint: `https://${process.env.SPACES_REGION}.digitaloceanspaces.com`,
    forcePathStyle: false,
    credentials: { accessKeyId: process.env.SPACES_KEY, secretAccessKey: process.env.SPACES_SECRET },
    ...(handler ? { requestHandler: handler } : {}),
  });
  try { sharp = require("sharp"); } catch {}
  try { exifr = require("exifr"); } catch {}
}

const BUCKET = () => process.env.SPACES_BUCKET;
const publicBase = () =>
  process.env.SPACES_CDN ||
  `https://${process.env.SPACES_BUCKET}.${process.env.SPACES_REGION}.digitaloceanspaces.com`;

async function put(Key, Body, ContentType, isPublic = true) {
  const { PutObjectCommand } = require("@aws-sdk/client-s3");
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET(), Key, Body, ContentType,
    ...(isPublic ? { ACL: "public-read" } : {}),
    CacheControl: isPublic ? "public, max-age=31536000, immutable" : "no-cache",
  }));
}

// ---------- manifest ----------
const EMPTY = { since: "2023-06-01", trips: [] };

async function loadManifest() {
  const { GetObjectCommand } = require("@aws-sdk/client-s3");
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET(), Key: "data/manifest.json" }));
    return JSON.parse(await r.Body.transformToString());
  } catch (e) {
    if (e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404) return { ...EMPTY, trips: [] };
    throw e;
  }
}

async function saveManifest(m) {
  await put("data/manifest.json", JSON.stringify(m, null, 1), "application/json", false);
}

// ---------- geocoding (same Nominatim flow as generate-manifest.js) ----------
// Nominatim allows 1 request/second — chain misses through a throttle queue
const geocache = new Map();
let geoQueue = Promise.resolve();
function reverseGeocode(lat, lon) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  if (geocache.has(key)) return Promise.resolve(geocache.get(key));
  const run = geoQueue.then(() => geocodeNow(lat, lon, key));
  geoQueue = run.then(() => new Promise((r) => setTimeout(r, 1100)));
  return run;
}
// name → coordinates, for trips whose photos carry no GPS ("Finland" still gets a star)
function forwardGeocode(name) {
  const q = String(name || "").replace(/[^\p{L}\p{N}\s,.-]/gu, "").trim(); // strip emoji etc.
  if (!q) return Promise.resolve(null);
  const run = geoQueue.then(() => new Promise((resolve) => {
    const { proxyAgent } = require("./proxy-helper");
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=en&q=${encodeURIComponent(q)}`;
    const req = https.get(url, { agent: proxyAgent(), headers: { "User-Agent": "wanderlight-gallery/1.0 (personal travel site)" } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          const j = JSON.parse(body);
          if (j[0] && j[0].lat) resolve([+parseFloat(j[0].lat).toFixed(4), +parseFloat(j[0].lon).toFixed(4)]);
          else resolve(null);
        } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
  }));
  geoQueue = run.then(() => new Promise((r) => setTimeout(r, 1100)));
  return run;
}

function geocodeNow(lat, lon, key) {
  if (geocache.has(key)) return Promise.resolve(geocache.get(key));
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=10&accept-language=en`;
  return new Promise((resolve) => {
    const { proxyAgent } = require("./proxy-helper");
    const req = https.get(url, { agent: proxyAgent(), headers: { "User-Agent": "wanderlight-gallery/1.0 (personal travel site)" } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          const a = (JSON.parse(body).address) || {};
          const place = [a.city || a.town || a.village || a.municipality || a.county, a.country].filter(Boolean).join(", ") || null;
          geocache.set(key, place);
          resolve(place);
        } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
  });
}

// ---------- upload one photo buffer into a trip ----------
const crypto = require("crypto");
const slugify = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9äöüõå]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60);
const sha1 = (buf) => crypto.createHash("sha1").update(buf).digest("hex");

function knownHashes(manifest) {
  const set = new Set();
  for (const t of manifest.trips) for (const p of t.photos) if (p.hash) set.add(p.hash);
  return set;
}

async function addPhotos({ folder, files, caption, browserCoords }) {
  const manifest = await loadManifest();

  // skip photos that are already in the universe (same bytes)
  const seen = knownHashes(manifest);
  const fresh = [];
  let skipped = 0;
  for (const f of files) {
    const h = sha1(f.buffer);
    if (seen.has(h)) { skipped++; continue; }
    seen.add(h);
    f._hash = h;
    fresh.push(f);
  }
  if (!fresh.length) return { added: [], skipped, trip: folder };
  files = fresh;

  const fm = folder.match(/^(\d{4})-(\d{2})\s+(.+)$/);
  const title = fm ? fm[3] : folder;
  const id = slugify(title);
  let trip = manifest.trips.find((t) => t.id === id);
  if (!trip) {
    trip = {
      id, folder, title, location: title,
      date: fm ? `${MONTHS[parseInt(fm[2], 10)]} ${fm[1]}` : "",
      sortKey: fm ? `${fm[1]}-${fm[2]}` : "0000-00",
      note: "", photos: [],
    };
    manifest.trips.push(trip);
  }

  const added = [];
  for (const f of files) {
    const stamp = Date.now().toString(36) + Math.floor(Math.random() * 36).toString(36);
    const base = slugify(caption) || slugify(path.basename(f.originalname, path.extname(f.originalname))) || "moment";
    const ext = { "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/avif": ".avif" }[f.mimetype] || ".jpg";
    const name = `${base}-${stamp}${ext}`;
    const key = `photos/${folder}/${name}`;

    const photo = { key, caption: caption || base.replace(/-/g, " ") };
    if (f._hash) photo.hash = f._hash;

    // EXIF from the buffer
    if (exifr) {
      try {
        const ex = await exifr.parse(f.buffer, { pick: ["DateTimeOriginal", "Model", "latitude", "longitude"] });
        if (ex) {
          if (ex.DateTimeOriginal) {
            const d = new Date(ex.DateTimeOriginal);
            photo.taken = d.toISOString();
            photo.date = `${d.getDate()} ${MONTHS[d.getMonth() + 1]} ${d.getFullYear()}`;
          }
          if (ex.Model) photo.camera = String(ex.Model).trim();
          if (typeof ex.latitude === "number") photo.coords = [+ex.latitude.toFixed(5), +ex.longitude.toFixed(5)];
        }
      } catch {}
    }
    if (!photo.coords && browserCoords) photo.coords = browserCoords;
    if (!photo.taken && fm) {
      // no EXIF date (scans, WhatsApp saves) — the folder's month is truer than upload time
      photo.taken = `${fm[1]}-${fm[2]}-01T00:00:00.000Z`;
      photo.date = `${MONTHS[parseInt(fm[2], 10)]} ${fm[1]}`;
    }
    if (photo.coords) photo.place = (await reverseGeocode(photo.coords[0], photo.coords[1])) || undefined;

    // upload original + web copy
    await put(key, f.buffer, f.mimetype);
    if (sharp) {
      try {
        const meta = await sharp(f.buffer).metadata();
        if (Math.max(meta.width || 0, meta.height || 0) > WEB_MAX) {
          const web = await sharp(f.buffer).rotate().resize(WEB_MAX, WEB_MAX, { fit: "inside" }).jpeg({ quality: 84 }).toBuffer();
          const webKey = `photos/${folder}/.web/${base}-${stamp}.jpg`;
          await put(webKey, web, "image/jpeg");
          photo.webKey = webKey;
        }
      } catch {}
    }

    trip.photos.push(photo);
    added.push(name);
  }

  trip.photos.sort((a, b) => (a.taken || "9999").localeCompare(b.taken || "9999"));
  const gps = trip.photos.filter((p) => p.coords);
  if (gps.length) {
    trip.coords = require("./autosort").centroid(gps); // circular-mean longitude
    trip.place = (await reverseGeocode(trip.coords[0], trip.coords[1])) || trip.place;
  } else if (!trip.coords) {
    // machine-made names ("Jul Adventure", "Unsorted Moments") are not places — do not geocode them
    const nameForGeo = trip.location || trip.title;
    const generic = /\badventure\b|\bunsorted\b|\bmoments\b/i.test(nameForGeo);
    trip.coords = generic ? undefined : (await forwardGeocode(nameForGeo)) || undefined;
    if (!trip.coords) delete trip.coords;
  }
  // newest-first by the moment each trip actually began (first photo), not by upload order
  const anchor = (t) => {
    const ts = t.photos.map((p) => p.taken).filter(Boolean).sort();
    return ts[0] || ((t.sortKey || "0000-00") + "-15");
  };
  manifest.trips.sort((a, b) => anchor(b).localeCompare(anchor(a)));

  await saveManifest(manifest);
  return { added, skipped, trip: folder };
}

// ---------- auto-sort: dump a pile of photos, trips organize themselves ----------
async function autoAddPhotos({ files, caption, browserCoords }) {
  const autosort = require("./autosort");
  const manifest = await loadManifest();

  // 0. dedup — same bytes never enter the universe twice
  const seen = knownHashes(manifest);
  let skipped = 0;
  files = files.filter((f) => {
    const h = sha1(f.buffer);
    if (seen.has(h)) { skipped++; return false; }
    seen.add(h);
    f._hash = h;
    return true;
  });
  if (!files.length) return [{ trip: "already in the universe", count: 0, skipped, isNew: false }];

  // 1. read EXIF from every buffer first
  const items = [];
  for (const f of files) {
    const item = { file: f, taken: null, coords: null, camera: null };
    if (exifr) {
      try {
        const ex = await exifr.parse(f.buffer, { pick: ["DateTimeOriginal", "Model", "latitude", "longitude"] });
        if (ex) {
          if (ex.DateTimeOriginal) item.taken = new Date(ex.DateTimeOriginal).toISOString();
          if (typeof ex.latitude === "number") item.coords = [+ex.latitude.toFixed(5), +ex.longitude.toFixed(5)];
          if (ex.Model) item.camera = String(ex.Model).trim();
        }
      } catch {}
    }
    if (!item.coords && browserCoords) item.coords = browserCoords;
    items.push(item);
  }

  // 2. cluster into trips, merge into existing ones where they belong
  const clusters = autosort.cluster(items);
  // an undated batch that the humans named is "now": file it under the
  // current month and stamp upload time, so it sits truly in the story
  for (const c of clusters) {
    if (c.start == null && caption && caption.trim()) {
      const now = new Date();
      c.start = c.end = now.getTime();
      for (const it of c.items) if (!it.taken) it.taken = now.toISOString();
    }
  }
  const summary = [];
  if (skipped) summary.push({ trip: "already there — skipped", count: 0, skipped, isNew: false });

  for (const c of clusters) {
    const home = autosort.findHome(c, manifest.trips);
    let folder, tripMeta;
    if (home) {
      folder = home.folder || `${home.date} ${home.title}`;
      tripMeta = null;
    } else {
      tripMeta = await autosort.nameCluster(c, (coords) => reverseGeocode(coords[0], coords[1]));
      // a name typed by the humans always beats what the machine inferred
      if (caption && caption.trim()) {
        const name = caption.trim().slice(0, 60);
        const ym = tripMeta.folder.slice(0, 7); // keep the YYYY-MM prefix
        tripMeta = { ...tripMeta, title: name, folder: `${ym} ${name.replace(/[\/\\:*?"<>|]/g, "")}`, location: tripMeta.place || name };
      }
      folder = tripMeta.folder;
    }
    const r = await addPhotosToFolder({
      manifest, folder, tripMeta,
      files: c.items.map((i) => i.file),
      exif: c.items,
      caption: "", // in auto mode the typed words name the journey; photo captions stay individual
    });
    summary.push({ trip: r.tripLabel, count: c.items.length, isNew: !home });
  }

  await saveManifest(manifest);
  return summary;
}

// core filing logic shared by manual + auto paths (mutates manifest, no save)
async function addPhotosToFolder({ manifest, folder, tripMeta, files, exif, caption }) {
  const fm = folder.match(/^(\d{4})-(\d{2})\s+(.+)$/);
  const title = (tripMeta && tripMeta.title) || (fm ? fm[3] : folder);
  const id = slugify(title);
  let trip = manifest.trips.find((t) => t.id === id);
  if (!trip) {
    trip = {
      id, folder, title,
      location: (tripMeta && tripMeta.location) || title,
      date: fm ? `${MONTHS[parseInt(fm[2], 10)]} ${fm[1]}` : "",
      sortKey: fm ? `${fm[1]}-${fm[2]}` : "0000-00",
      note: "", photos: [],
    };
    if (tripMeta && tripMeta.place) trip.place = tripMeta.place;
    manifest.trips.push(trip);
  }

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const ex = exif ? exif[i] : null;
    const stamp = Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
    const base = slugify(caption) || slugify(path.basename(f.originalname, path.extname(f.originalname))) || "moment";
    const ext = { "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/avif": ".avif" }[f.mimetype] || ".jpg";
    const key = `photos/${folder}/${base}-${stamp}${ext}`;

    const photo = { key, caption: caption || base.replace(/-/g, " ") };
    if (f._hash) photo.hash = f._hash;
    if (ex) {
      if (ex.taken) {
        photo.taken = ex.taken;
        const d = new Date(ex.taken);
        photo.date = `${d.getDate()} ${MONTHS[d.getMonth() + 1]} ${d.getFullYear()}`;
      }
      if (ex.coords) {
        photo.coords = ex.coords;
        photo.place = (await reverseGeocode(ex.coords[0], ex.coords[1])) || undefined;
      }
      if (ex.camera) photo.camera = ex.camera;
    }

    await put(key, f.buffer, f.mimetype);
    if (sharp) {
      try {
        const meta = await sharp(f.buffer).metadata();
        if (Math.max(meta.width || 0, meta.height || 0) > WEB_MAX) {
          const web = await sharp(f.buffer).rotate().resize(WEB_MAX, WEB_MAX, { fit: "inside" }).jpeg({ quality: 84 }).toBuffer();
          photo.webKey = `photos/${folder}/.web/${base}-${stamp}.jpg`;
          await put(photo.webKey, web, "image/jpeg");
        }
      } catch {}
    }
    trip.photos.push(photo);
  }

  trip.photos.sort((a, b) => (a.taken || "9999").localeCompare(b.taken || "9999"));
  const gps = trip.photos.filter((p) => p.coords);
  if (gps.length) {
    trip.coords = require("./autosort").centroid(gps); // circular-mean longitude
    if (!trip.place) trip.place = (await reverseGeocode(trip.coords[0], trip.coords[1])) || undefined;
  } else if (!trip.coords) {
    // no GPS anywhere — place the star by the journey's name so it still joins the map
    // machine-made names ("Jul Adventure", "Unsorted Moments") are not places — do not geocode them
    const nameForGeo = trip.location || trip.title;
    const generic = /\badventure\b|\bunsorted\b|\bmoments\b/i.test(nameForGeo);
    trip.coords = generic ? undefined : (await forwardGeocode(nameForGeo)) || undefined;
    if (!trip.coords) delete trip.coords;
  }
  // newest-first by the moment each trip actually began (first photo), not by upload order
  const anchor = (t) => {
    const ts = t.photos.map((p) => p.taken).filter(Boolean).sort();
    return ts[0] || ((t.sortKey || "0000-00") + "-15");
  };
  manifest.trips.sort((a, b) => anchor(b).localeCompare(anchor(a)));
  return { tripLabel: trip.title + (trip.date ? ` (${trip.date})` : "") };
}

// ---------- render photos.js for the gallery ----------
async function renderPhotosJs() {
  const m = await loadManifest();
  const base = publicBase();
  const trips = m.trips.map((t) => ({
    id: t.id, title: t.title, location: t.location, date: t.date, note: t.note || "",
    ...(t.coords ? { coords: t.coords } : {}), ...(t.place ? { place: t.place } : {}),
    photos: t.photos.map((p) => ({
      src: `${base}/${encodeURI(p.webKey || p.key)}`,
      ...(p.webKey ? { full: `${base}/${encodeURI(p.key)}` } : {}),
      caption: p.caption || "",
      ...(p.coords ? { coords: p.coords } : {}), ...(p.place ? { place: p.place } : {}),
      ...(p.taken ? { taken: p.taken } : {}), ...(p.date ? { date: p.date } : {}),
      ...(p.camera ? { camera: p.camera } : {}),
    })),
  })).filter((t) => t.photos.length);
  return `/* Served live from DigitalOcean Spaces */\nwindow.TOGETHER_SINCE = ${JSON.stringify(m.since || "2023-06-01")};\nwindow.TRIPS = ${JSON.stringify(trips, null, 1)};\n`;
}

async function listTrips() {
  const m = await loadManifest();
  return m.trips.map((t) => t.folder || `${t.date} ${t.title}`);
}

// ---------- edits: fix the magic's mistakes ----------
async function editTrip(id, { title, location, note, coords, place, date, sortKey }) {
  const m = await loadManifest();
  const t = m.trips.find((x) => x.id === id);
  if (!t) return false;
  if (title !== undefined && String(title).trim()) t.title = String(title).trim().slice(0, 80);
  if (location !== undefined) t.location = String(location).trim().slice(0, 120);
  if (note !== undefined) t.note = String(note).trim().slice(0, 500);
  if (Array.isArray(coords) && coords.length === 2 && coords.every((n) => Number.isFinite(n))) {
    t.coords = [+coords[0].toFixed(4), +coords[1].toFixed(4)]; // puts the trip on the star map
  }
  if (place !== undefined) t.place = String(place).trim().slice(0, 120) || undefined;
  if (date !== undefined) t.date = String(date).trim().slice(0, 20);
  if (sortKey && /^\d{4}-\d{2}$/.test(sortKey)) t.sortKey = sortKey;
  await saveManifest(m);
  return true;
}

async function editPhoto(srcOrKey, caption) {
  const m = await loadManifest();
  for (const t of m.trips) {
    const p = t.photos.find((x) => x.key === srcOrKey || srcOrKey.endsWith(encodeURI(x.webKey || x.key)) || srcOrKey.endsWith(encodeURI(x.key)));
    if (p) {
      p.caption = String(caption).trim().slice(0, 140);
      await saveManifest(m);
      return true;
    }
  }
  return false;
}

async function setSince(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const m = await loadManifest();
  m.since = date;
  await saveManifest(m);
  return true;
}

module.exports = { enabled, init, addPhotos, autoAddPhotos, renderPhotosJs, listTrips, loadManifest, saveManifest, put, publicBase, editTrip, editPhoto, setSince, forwardGeocode };
