/* ============================================================
   Wanderlight auto-sort 🌌 — the intelligent librarian
   ------------------------------------------------------------
   Give it a pile of photos (each with an optional capture time
   and GPS position) and it figures out the trips by itself:

   • photos are sorted by the moment they were taken
   • a new trip starts when there's a gap of > GAP_DAYS between
     photos, or a jump of > JUMP_KM with at least a day between
     (flying home and flying out again)
   • each cluster is named after where it happened —
     "2024-06 Positano" — via the reverse-geocode callback
   • clusters that overlap an existing trip in time AND space
     merge into it instead of creating a duplicate

   Pure logic, no I/O — used by server.js in both local and
   cloud mode, and easy to test.
   ============================================================ */

const GAP_DAYS = 3;      // quiet days that end a trip
const JUMP_KM = 300;     // teleporting this far = probably a new trip
const MERGE_KM = 150;    // how close an existing trip must be to absorb a cluster
const MERGE_SLACK_DAYS = 2;

const MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY = 86400000;

function haversineKm([lat1, lon1], [lat2, lon2]) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function centroid(items) {
  const gps = items.filter((p) => p.coords);
  if (!gps.length) return null;
  return [
    +(gps.reduce((s, p) => s + p.coords[0], 0) / gps.length).toFixed(4),
    +(gps.reduce((s, p) => s + p.coords[1], 0) / gps.length).toFixed(4),
  ];
}

/* items: [{ taken: ISO string | null, coords: [lat,lon] | null, ...anything }]
   returns [{ items, start, end, centroid }] — dated clusters first (newest last),
   then one undated cluster if any photos had no timestamp. */
function cluster(items) {
  const dated = items.filter((p) => p.taken).sort((a, b) => a.taken.localeCompare(b.taken));
  const undated = items.filter((p) => !p.taken);

  const clusters = [];
  let current = null;
  for (const p of dated) {
    const t = Date.parse(p.taken);
    if (!current) {
      current = { items: [p], start: t, end: t };
      continue;
    }
    const gapDays = (t - current.end) / DAY;
    const lastGps = [...current.items].reverse().find((x) => x.coords);
    const jumped = lastGps && p.coords && haversineKm(lastGps.coords, p.coords) > JUMP_KM;
    if (gapDays > GAP_DAYS || (jumped && gapDays > 1)) {
      clusters.push(current);
      current = { items: [p], start: t, end: t };
    } else {
      current.items.push(p);
      current.end = t;
    }
  }
  if (current) clusters.push(current);
  for (const c of clusters) c.centroid = centroid(c.items);
  if (undated.length) clusters.push({ items: undated, start: null, end: null, centroid: centroid(undated) });
  return clusters;
}

/* Find an existing trip this cluster belongs to.
   trips: [{ id, coords?, photos: [{taken?, coords?}] }] */
function findHome(clusterObj, trips) {
  for (const t of trips) {
    const times = t.photos.map((p) => p.taken && Date.parse(p.taken)).filter(Boolean);
    if (!times.length || clusterObj.start == null) continue;
    const tStart = Math.min(...times) - MERGE_SLACK_DAYS * DAY;
    const tEnd = Math.max(...times) + MERGE_SLACK_DAYS * DAY;
    const overlaps = clusterObj.start <= tEnd && clusterObj.end >= tStart;
    if (!overlaps) continue;
    const tc = t.coords || centroid(t.photos);
    if (tc && clusterObj.centroid && haversineKm(tc, clusterObj.centroid) > MERGE_KM) continue;
    return t;
  }
  return null;
}

/* Suggest "<YYYY-MM> <Place>" for a cluster.
   geocode: async ([lat,lon]) => "City, Country" | null */
async function nameCluster(clusterObj, geocode) {
  let place = null;
  if (clusterObj.centroid && geocode) {
    try { place = await geocode(clusterObj.centroid); } catch {}
  }
  const city = place ? place.split(",")[0].trim() : null;
  if (clusterObj.start == null) {
    return { folder: `0000-00 Unsorted Moments`, title: "Unsorted Moments", location: city || "", place };
  }
  const d = new Date(clusterObj.start);
  const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const title = city || `${MONTHS[d.getMonth() + 1]} Adventure`;
  return { folder: `${ym} ${title}`, title, location: place || title, place };
}

module.exports = { cluster, findHome, nameCluster, haversineKm, centroid, GAP_DAYS, JUMP_KM };
