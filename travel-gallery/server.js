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

app.post("/api/upload", (req, res) => {
  if (!checkKey(req, res)) return;
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

    // remember browser-supplied location + note for files without GPS EXIF
    const meta = loadMeta();
    const lat = parseFloat(req.query.lat), lon = parseFloat(req.query.lon);
    for (const f of req.files) {
      meta[f.filename] = {
        uploaded: new Date().toISOString(),
        ...(Number.isFinite(lat) && Number.isFinite(lon) ? { coords: [+lat.toFixed(5), +lon.toFixed(5)] } : {}),
        ...(req.query.caption ? { caption: String(req.query.caption).slice(0, 140) } : {}),
      };
    }
    saveMeta(meta);

    const ok = await regenerate();
    res.json({
      saved: req.files.length,
      trip: safeTripFolder(req.query.trip),
      regenerated: ok,
      files: req.files.map((f) => f.filename),
    });
  });
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

// in cloud mode the manifest is served live from Spaces (index.html is unchanged)
if (CLOUD) {
  app.get("/photos.js", async (req, res) => {
    try {
      res.type("application/javascript").set("Cache-Control", "no-cache").send(await spaces.renderPhotosJs());
    } catch (e) {
      console.error("spaces manifest:", e);
      res.status(500).type("application/javascript").send("window.TRIPS=[];window.TOGETHER_SINCE=null;");
    }
  });
}

// ---------- pages ----------
app.get("/upload", (req, res) => res.sendFile(path.join(ROOT, "upload.html")));
app.use(express.static(ROOT, { extensions: ["html"] }));

app.listen(PORT, () => {
  console.log(`🌙 Wanderlight → http://localhost:${PORT}`);
  console.log(`📸 Upload page → http://localhost:${PORT}/upload${UPLOAD_KEY ? "  (protected by secret word)" : ""}`);
});
