#!/usr/bin/env node
/* ============================================================
   Wanderlight backend 🌙
   ------------------------------------------------------------
   A small server so Liina & Ralf can upload straight from their
   phones — camera, captions, and location included.

     npm install
     npm start                → http://localhost:4747
                                phone upload page at /upload

   What it does
   • Serves the gallery (/) and the upload page (/upload)
   • POST /api/upload — receives photos, files them into
     photos/<YYYY-MM Trip>/, then regenerates photos.js
     (EXIF dates, GPS places, resizing — same pipeline as
     generate-manifest.js)
   • Captions typed at upload become filenames, so the
     generator picks them up naturally; browser location is
     stored in .uploads-meta.json for photos without GPS EXIF
   • Optional protection: set UPLOAD_KEY=yoursecret and the
     upload page asks for the secret word once per device

   Deploy anywhere Node runs (Railway, Fly.io, a Raspberry Pi
   in the living room). Photos land on disk — back them up by
   committing the photos/ folder, or mount a volume.
   ============================================================ */
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { execFile } = require("child_process");

let express, multer;
try {
  express = require("express");
  multer = require("multer");
} catch {
  console.error("Run `npm install` inside travel-gallery/ first (installs express, multer, exifr, sharp).");
  process.exit(1);
}

const ROOT = __dirname;
const PHOTOS_DIR = path.join(ROOT, "photos");
const META = path.join(ROOT, ".uploads-meta.json");
const PORT = process.env.PORT || 4747;
const UPLOAD_KEY = process.env.UPLOAD_KEY || null;
const IMG_TYPES = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/avif": ".avif" };

const app = express();
app.use(express.json());

// ---------- cloud mode: DigitalOcean Spaces ----------
const spaces = require("./spaces");
const CLOUD = spaces.enabled();
if (CLOUD) {
  spaces.init();
  console.log(`☁ Cloud mode: photos live in Spaces bucket "${process.env.SPACES_BUCKET}" (${process.env.SPACES_REGION})`);
}

// ---------- helpers ----------
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9äöüõå]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60);

function safeTripFolder(name) {
  // accept "2024-06 Amalfi Coast" or invent the prefix from today
  const clean = String(name || "").replace(/[\/\\:*?"<>|]/g, "").trim();
  if (!clean) return null;
  if (/^\d{4}-\d{2}\s+.+/.test(clean)) return clean;
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")} ${clean}`;
}

function loadMeta() { try { return JSON.parse(fs.readFileSync(META, "utf8")); } catch { return {}; } }
function saveMeta(m) { fs.writeFileSync(META, JSON.stringify(m, null, 1)); }

// local-mode duplicate guard: same bytes never enter the universe twice
const HASHES = path.join(ROOT, ".hashes.json");
const sha1 = (buf) => crypto.createHash("sha1").update(buf).digest("hex");
function loadHashes() { try { return new Set(JSON.parse(fs.readFileSync(HASHES, "utf8"))); } catch { return new Set(); } }
function saveHashes(s) { fs.writeFileSync(HASHES, JSON.stringify([...s])); }

let regenerating = null;
function regenerate() {
  // serialize runs; the generator preserves hand-written captions
  if (!regenerating) {
    regenerating = new Promise((resolve) => {
      execFile(process.execPath, [path.join(ROOT, "generate-manifest.js")], { cwd: ROOT, timeout: 120000 },
        (err, stdout, stderr) => {
          regenerating = null;
          if (err) console.error("generator:", stderr || err.message);
          else console.log(stdout.trim());
          resolve(!err);
        });
    });
  }
  return regenerating;
}

function checkKey(req, res) {
  if (!UPLOAD_KEY) return true;
  if (req.headers["x-upload-key"] === UPLOAD_KEY) return true;
  res.status(401).json({ error: "wrong secret word 🌙" });
  return false;
}

// ---------- uploads ----------
const storage = multer.diskStorage({
  destination(req, file, cb) {
    const folder = safeTripFolder(req.query.trip);
    if (!folder) return cb(new Error("missing trip name"));
    const dest = path.join(PHOTOS_DIR, folder);
    if (!path.resolve(dest).startsWith(path.resolve(PHOTOS_DIR))) return cb(new Error("bad trip name"));
    fs.mkdirSync(dest, { recursive: true });
    cb(null, dest);
  },
  filename(req, file, cb) {
    const ext = IMG_TYPES[file.mimetype] || path.extname(file.originalname).toLowerCase() || ".jpg";
    const caption = slug(req.query.caption);
    const base = caption || slug(path.basename(file.originalname, path.extname(file.originalname))) || "moment";
    cb(null, `${base}-${Date.now().toString(36)}${ext}`);
  },
});
function imageFilter(req, file, cb) {
  if (IMG_TYPES[file.mimetype]) return cb(null, true);
  if (/heic|heif/i.test(file.mimetype) || /\.heic$/i.test(file.originalname)) {
    return cb(new Error("HEIC isn't supported by browsers — set iPhone camera to 'Most Compatible' or export as JPEG"));
  }
  cb(new Error(`unsupported type: ${file.mimetype}`));
}

const upload = multer({
  storage,
  limits: { fileSize: 40 * 1024 * 1024, files: 60 },
  fileFilter: imageFilter,
});

// cloud uploads: buffer in memory, everything (EXIF, resize, geocode) happens
// in spaces.js and lands directly in the bucket + manifest
const cloudUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024, files: 60 },
  fileFilter: imageFilter,
});

// ---------- auto-sort for local mode: cluster in memory, file to disk ----------
async function localAutoSort({ files, caption, browserCoords }) {
  const autosort = require("./autosort");
  let exifr = null;
  try { exifr = require("exifr"); } catch {}

  // duplicate guard
  const hashes = loadHashes();
  let dupes = 0;
  files = files.filter((f) => {
    const h = sha1(f.buffer);
    if (hashes.has(h)) { dupes++; return false; }
    hashes.add(h);
    return true;
  });
  saveHashes(hashes);
  if (!files.length) return [{ trip: "already in the universe", count: 0, skipped: dupes, isNew: false }];

  const items = [];
  for (const f of files) {
    const item = { file: f, taken: null, coords: null };
    if (exifr) {
      try {
        const ex = await exifr.parse(f.buffer, { pick: ["DateTimeOriginal", "latitude", "longitude"] });
        if (ex) {
          if (ex.DateTimeOriginal) item.taken = new Date(ex.DateTimeOriginal).toISOString();
          if (typeof ex.latitude === "number") item.coords = [+ex.latitude.toFixed(5), +ex.longitude.toFixed(5)];
        }
      } catch {}
    }
    if (!item.coords && browserCoords) item.coords = browserCoords;
    items.push(item);
  }

  // reuse the generator's Nominatim flow via a minimal inline geocoder + shared cache file
  const GEOCACHE = path.join(ROOT, ".geocache.json");
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(GEOCACHE, "utf8")); } catch {}
  const https = require("https");
  const geocode = ([lat, lon]) => new Promise((resolve) => {
    const k = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    if (cache[k] !== undefined) return resolve(cache[k]);
    const r = https.get(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=10&accept-language=en`,
      { headers: { "User-Agent": "wanderlight-gallery/1.0 (personal travel site)" } }, (res) => {
        let b = ""; res.on("data", (c) => (b += c));
        res.on("end", () => {
          try {
            const a = JSON.parse(b).address || {};
            cache[k] = [a.city || a.town || a.village || a.municipality || a.county, a.country].filter(Boolean).join(", ") || null;
          } catch { cache[k] = null; }
          fs.writeFileSync(GEOCACHE, JSON.stringify(cache, null, 1));
          resolve(cache[k]);
        });
      });
    r.on("error", () => resolve(null));
    r.setTimeout(8000, () => { r.destroy(); resolve(null); });
  });

  // existing trips (from photos.js) for merge decisions
  let existing = [];
  try {
    const sandbox = {};
    new Function("window", fs.readFileSync(path.join(ROOT, "photos.js"), "utf8"))(sandbox);
    existing = (sandbox.TRIPS || []).filter((t) => t.photos.some((p) => !p.src.startsWith("demo-photos/")));
    for (const t of existing) {
      const m = (t.photos[0] && (t.photos[0].full || t.photos[0].src).match(/^photos\/([^/]+)\//));
      t.folder = m ? m[1] : null;
    }
  } catch {}

  const meta = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, ".uploads-meta.json"), "utf8")); } catch { return {}; } })();
  const clusters = require("./autosort").cluster(items);
  const summary = [];

  for (const c of clusters) {
    const home = autosort.findHome(c, existing);
    let folder = home && home.folder;
    if (!folder) {
      const named = await autosort.nameCluster(c, geocode);
      folder = named.folder;
      // a name typed by the humans always beats what the machine inferred
      if (caption && caption.trim()) {
        folder = `${named.folder.slice(0, 7)} ${caption.trim().slice(0, 60).replace(/[\/\\:*?"<>|]/g, "")}`;
      }
    }
    const dest = path.join(PHOTOS_DIR, folder);
    fs.mkdirSync(dest, { recursive: true });
    for (const it of c.items) {
      const f = it.file;
      const ext = IMG_TYPES[f.mimetype] || ".jpg";
      // in auto mode typed words name the journey — photo captions stay individual
      const base = slug(path.basename(f.originalname, path.extname(f.originalname))) || "moment";
      const name = `${base}-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}${ext}`;
      fs.writeFileSync(path.join(dest, name), f.buffer);
      meta[name] = {
        uploaded: new Date().toISOString(),
        caption: base.replace(/-/g, " ") || "a moment",
        ...(it.coords ? { coords: it.coords } : {}),
      };
    }
    summary.push({ trip: folder.replace(/^\d{4}-\d{2}\s+/, ""), count: c.items.length, isNew: !home });
  }

  saveMeta(meta);
  await regenerate();
  if (dupes) summary.push({ trip: "already there — skipped", count: 0, skipped: dupes, isNew: false });
  return summary;
}

app.post("/api/upload", (req, res) => {
  if (!checkKey(req, res)) return;

  // ✨ magic mode: no trip chosen — the librarian sorts everything itself
  if (req.query.trip === "__auto__") {
    return cloudUpload.array("photos")(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.files || !req.files.length) return res.status(400).json({ error: "no photos received" });
      const lat = parseFloat(req.query.lat), lon = parseFloat(req.query.lon);
      const args = {
        files: req.files,
        caption: req.query.caption ? String(req.query.caption).slice(0, 140) : "",
        browserCoords: Number.isFinite(lat) && Number.isFinite(lon) ? [+lat.toFixed(5), +lon.toFixed(5)] : null,
      };
      try {
        const summary = CLOUD ? await spaces.autoAddPhotos(args) : await localAutoSort(args);
        res.json({
          saved: summary.reduce((n, s) => n + s.count, 0),
          auto: true, summary, regenerated: true,
          trip: summary.map((s) => `${s.trip} ×${s.count}`).join(", "),
        });
      } catch (e) {
        console.error("auto-sort:", e);
        res.status(500).json({ error: "auto-sort failed — check server logs" });
      }
    });
  }

  if (CLOUD) {
    return cloudUpload.array("photos")(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.files || !req.files.length) return res.status(400).json({ error: "no photos received" });
      const folder = safeTripFolder(req.query.trip);
      if (!folder) return res.status(400).json({ error: "missing trip name" });
      const lat = parseFloat(req.query.lat), lon = parseFloat(req.query.lon);
      try {
        const r = await spaces.addPhotos({
          folder,
          files: req.files,
          caption: req.query.caption ? String(req.query.caption).slice(0, 140) : "",
          browserCoords: Number.isFinite(lat) && Number.isFinite(lon) ? [+lat.toFixed(5), +lon.toFixed(5)] : null,
        });
        res.json({ saved: r.added.length, trip: r.trip, regenerated: true, files: r.added });
      } catch (e) {
        console.error("spaces upload:", e);
        res.status(500).json({ error: "cloud upload failed — check server logs" });
      }
    });
  }
  upload.array("photos")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.files || !req.files.length) return res.status(400).json({ error: "no photos received" });

    // duplicate guard: hash each saved file, drop ones we already have
    const hashes = loadHashes();
    let skipped = 0;
    req.files = req.files.filter((f) => {
      const h = sha1(fs.readFileSync(f.path));
      if (hashes.has(h)) { try { fs.unlinkSync(f.path); } catch {} skipped++; return false; }
      hashes.add(h);
      return true;
    });
    saveHashes(hashes);
    if (!req.files.length) {
      return res.json({ saved: 0, skipped, trip: safeTripFolder(req.query.trip), regenerated: false, files: [] });
    }

    // remember browser-supplied location + note for files without GPS EXIF
    const meta = loadMeta();
    const lat = parseFloat(req.query.lat), lon = parseFloat(req.query.lon);
    for (const f of req.files) {
      const clean = req.query.caption
        ? String(req.query.caption).slice(0, 140)
        : slug(path.basename(f.originalname, path.extname(f.originalname))).replace(/-/g, " ") || "a moment";
      meta[f.filename] = {
        uploaded: new Date().toISOString(),
        caption: clean,
        ...(Number.isFinite(lat) && Number.isFinite(lon) ? { coords: [+lat.toFixed(5), +lon.toFixed(5)] } : {}),
      };
    }
    saveMeta(meta);

    const ok = await regenerate();
    res.json({
      saved: req.files.length,
      skipped,
      trip: safeTripFolder(req.query.trip),
      regenerated: ok,
      files: req.files.map((f) => f.filename),
    });
  });
});

// ---------- edits: rename trips, fix captions, set the anniversary ----------
function loadLocalManifest() {
  const sandbox = {};
  new Function("window", fs.readFileSync(path.join(ROOT, "photos.js"), "utf8"))(sandbox);
  return { since: sandbox.TOGETHER_SINCE || "2023-06-01", trips: sandbox.TRIPS || [] };
}
function saveLocalManifest(m) {
  fs.writeFileSync(path.join(ROOT, "photos.js"),
    `/* Generated by generate-manifest.js — edited via the gallery.
   Your captions, quotes and notes are PRESERVED across re-runs. */

window.TOGETHER_SINCE = ${JSON.stringify(m.since)};

window.TRIPS = ${JSON.stringify(m.trips, null, 2)};
`);
}

app.post("/api/edit", async (req, res) => {
  if (!checkKey(req, res)) return;
  const { type } = req.body || {};
  try {
    // editing a trip's location places its star: geocode the typed place name
    if (type === "trip" && req.body.location && !req.body.coords) {
      try {
        const c = await spaces.forwardGeocode(req.body.location);
        if (c) { req.body.coords = c; req.body.place = req.body.place || req.body.location; }
      } catch {}
    }
    if (CLOUD) {
      let ok = false;
      if (type === "trip") ok = await spaces.editTrip(req.body.id, req.body);
      else if (type === "photo") ok = await spaces.editPhoto(String(req.body.src || ""), String(req.body.caption || ""));
      else if (type === "since") ok = await spaces.setSince(String(req.body.date || ""));
      return ok ? res.json({ ok: true }) : res.status(400).json({ error: "not found" });
    }
    // local mode: edit photos.js directly (the generator preserves these edits)
    const m = loadLocalManifest();
    let ok = false;
    if (type === "trip") {
      const t = m.trips.find((x) => x.id === req.body.id);
      if (t) {
        if (req.body.title !== undefined && String(req.body.title).trim()) t.title = String(req.body.title).trim().slice(0, 80);
        if (req.body.location !== undefined) t.location = String(req.body.location).trim().slice(0, 120);
        if (req.body.note !== undefined) t.note = String(req.body.note).trim().slice(0, 500);
        if (Array.isArray(req.body.coords) && req.body.coords.length === 2 && req.body.coords.every(Number.isFinite)) {
          t.coords = [+req.body.coords[0].toFixed(4), +req.body.coords[1].toFixed(4)];
        }
        if (req.body.place) t.place = String(req.body.place).trim().slice(0, 120);
        ok = true;
      }
    } else if (type === "photo") {
      for (const t of m.trips) {
        const p = t.photos.find((x) => req.body.src && (req.body.src.endsWith(encodeURI(x.src)) || x.src === req.body.src));
        if (p) { p.caption = String(req.body.caption || "").trim().slice(0, 140); ok = true; break; }
      }
    } else if (type === "since" && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date || "")) {
      m.since = req.body.date;
      ok = true;
    }
    if (ok) saveLocalManifest(m);
    return ok ? res.json({ ok: true }) : res.status(400).json({ error: "not found" });
  } catch (e) {
    console.error("edit:", e);
    res.status(500).json({ error: "edit failed" });
  }
});

app.get("/api/trips", async (req, res) => {
  if (CLOUD) {
    try { return res.json({ trips: await spaces.listTrips(), protected: Boolean(UPLOAD_KEY) }); }
    catch (e) { console.error("spaces trips:", e); }
  }
  let dirs = [];
  try {
    dirs = fs.readdirSync(PHOTOS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name).sort().reverse();
  } catch {}
  res.json({ trips: dirs, protected: Boolean(UPLOAD_KEY) });
});

// ---------- the cinema diary 🍿 movies we saw, movies still waiting ----------
const MOVIES_FILE = path.join(ROOT, "movies.json");
const MOVIES_MEDIA = path.join(ROOT, "movies-media");

function readMoviesLocal() { try { return JSON.parse(fs.readFileSync(MOVIES_FILE, "utf8")); } catch { return { movies: [] }; } }
function writeMoviesLocal(d) { fs.writeFileSync(MOVIES_FILE, JSON.stringify(d, null, 1)); }
const readMovies = () => (CLOUD ? spaces.loadMovies() : Promise.resolve(readMoviesLocal()));
const writeMovies = (d) => (CLOUD ? spaces.saveMovies(d) : Promise.resolve(writeMoviesLocal(d)));
const newMovieId = () => "m" + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);

app.get("/api/movies", async (req, res) => {
  try { res.set("Cache-Control", "no-cache").json(await readMovies()); }
  catch (e) { console.error("movies:", e); res.status(500).json({ error: "could not open the cinema" }); }
});

app.post("/api/movies", async (req, res) => {
  if (!checkKey(req, res)) return;
  const b = req.body || {};
  const clean = (s, n) => String(s ?? "").trim().slice(0, n);
  try {
    const data = await readMovies();
    if (!Array.isArray(data.movies)) data.movies = [];
    if (b.op === "add") {
      const title = clean(b.title, 120);
      if (!title) return res.status(400).json({ error: "the film needs a name" });
      data.movies.push({
        id: newMovieId(),
        title,
        status: b.status === "watched" ? "watched" : "wish",
        note: clean(b.note, 500),
        image: "",
        addedAt: new Date().toISOString(),
        watchedAt: b.status === "watched" ? new Date().toISOString() : null,
      });
    } else if (b.op === "edit" || b.op === "remove") {
      const i = data.movies.findIndex((m) => m.id === b.id);
      if (i < 0) return res.status(404).json({ error: "film not found" });
      if (b.op === "remove") {
        data.movies.splice(i, 1);
      } else {
        const m = data.movies[i];
        if (b.title !== undefined && clean(b.title, 120)) m.title = clean(b.title, 120);
        if (b.note !== undefined) m.note = clean(b.note, 500);
        if (b.image === "") m.image = ""; // un-pin the still
        if (b.status === "watched" && m.status !== "watched") { m.status = "watched"; m.watchedAt = new Date().toISOString(); }
        if (b.status === "wish" && m.status !== "wish") { m.status = "wish"; m.watchedAt = null; }
      }
    } else {
      return res.status(400).json({ error: "unknown op" });
    }
    await writeMovies(data);
    res.json(data);
  } catch (e) { console.error("movies:", e); res.status(500).json({ error: "saving failed — try again" }); }
});

// a still from the night we watched it — one picture per film, replace anytime
app.post("/api/movies/still", (req, res) => {
  if (!checkKey(req, res)) return;
  cloudUpload.single("photo")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "no picture received" });
    try {
      const data = await readMovies();
      const m = (data.movies || []).find((x) => x.id === req.query.id);
      if (!m) return res.status(404).json({ error: "film not found" });
      if (CLOUD) {
        m.image = await spaces.putMovieStill(req.file.buffer, req.file.mimetype, m.id);
      } else {
        fs.mkdirSync(MOVIES_MEDIA, { recursive: true });
        let out = req.file.buffer;
        try {
          const sharp = require("sharp");
          out = await sharp(req.file.buffer).rotate().resize(1800, 1800, { fit: "inside" }).jpeg({ quality: 84 }).toBuffer();
        } catch {}
        const name = `${m.id}-${Date.now().toString(36)}.jpg`;
        fs.writeFileSync(path.join(MOVIES_MEDIA, name), out);
        m.image = `movies-media/${name}`;
      }
      await writeMovies(data);
      res.json(data);
    } catch (e) { console.error("movie still:", e); res.status(500).json({ error: "upload failed — try again" }); }
  });
});

// in cloud mode the manifest is served live from Spaces (index.html is unchanged)
if (CLOUD) {
  app.get("/photos.js", async (req, res) => {
    res.type("application/javascript").set("Cache-Control", "no-cache");
    try {
      const js = await spaces.renderPhotosJs();
      // until the first real photo arrives, show the demo postcards instead of an empty sky
      if (/window\.TRIPS = \[\]/.test(js)) {
        return res.send(fs.readFileSync(path.join(ROOT, "photos.js"), "utf8"));
      }
      res.send(js);
    } catch (e) {
      console.error("spaces manifest:", e);
      res.status(500).send("window.TRIPS=[];window.TOGETHER_SINCE=null;");
    }
  });
}

// ---------- pages ----------
app.get("/upload", (req, res) => res.sendFile(path.join(ROOT, "upload.html")));
app.get("/movies", (req, res) => { res.set("Cache-Control", "no-cache"); res.sendFile(path.join(ROOT, "movies.html")); });
app.use(express.static(ROOT, {
  extensions: ["html"],
  setHeaders(res, filePath) {
    // pages and the manifest must never go stale on phones; photos are immutable
    if (/\.(html|js|webmanifest)$/.test(filePath)) res.setHeader("Cache-Control", "no-cache");
  },
}));

app.listen(PORT, () => {
  console.log(`🌙 Wanderlight → http://localhost:${PORT}`);
  console.log(`📸 Upload page → http://localhost:${PORT}/upload${UPLOAD_KEY ? "  (protected by secret word)" : ""}`);
});
