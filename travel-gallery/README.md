# ✦ Wanderlight — Liina & Ralf's travel universe

A dark, space-kissed photo gallery for two. Twinkling starfield, aurora glows in
rose & violet, handwritten notes, a cinematic lightbox, and a mobile experience
that feels like an app. No build step, no framework — just open it.

## Open it

Double-click `travel-gallery/index.html`, or serve it:

```bash
cd travel-gallery
python3 -m http.server 8000
# → http://localhost:8000
```

It ships with demo photos (loaded from the internet) so you can feel the vibe
immediately.

## Add your own photos

1. Create trip folders under `photos/`, named `YYYY-MM Trip name`:

   ```
   travel-gallery/photos/
     2024-06 Amalfi Coast/
       boat-day.jpg        ← filename becomes the caption ("boat day")
       gelato-eleven.jpg
     2025-01 Lapland/
       aurora-night.jpg
   ```

2. Regenerate the manifest:

   ```bash
   node generate-manifest.js
   ```

3. Refresh the page. That's it.

### Unlock the metadata magic (recommended)

```bash
npm install exifr sharp     # one time, inside travel-gallery/
node generate-manifest.js
```

With those two packages installed the generator also:

- reads **EXIF** from every photo — the exact **date taken**, **GPS position**,
  and **camera model** (shown in the lightbox: *Positano, Italy · 14 Jun 2024 ·
  iPhone 15 Pro*)
- **reverse-geocodes** GPS into real place names via OpenStreetMap (cached in
  `.geocache.json`, so each place is looked up only once)
- lights up **"The map of us"** — a constellation of your trips plotted by
  their real coordinates, connected chronologically; tap a star to jump to
  that chapter
- **auto-resizes** big photos (web copies in `photos/<trip>/.web/`, max
  1800 px) so even a huge batch loads fast — the lightbox still opens the
  full-resolution original
- sorts photos inside each trip by the moment they were taken

Your hand-written captions, quotes, and trip notes in `photos.js` are
**preserved across re-runs** — edit freely, regenerate safely.

> iPhone tip: HEIC files can't be shown by browsers. Export as JPEG
> ("Most Compatible") or let macOS Photos convert on export.

### AI captions (optional)

Let Claude look at each photo and write a short, warm caption plus a
mood/theme tag — only for photos you haven't captioned yourself:

```bash
npm install @anthropic-ai/sdk sharp
export ANTHROPIC_API_KEY=sk-ant-...
node enrich-captions.js          # or --all to redo everything
```

Afterwards you can open `photos.js` and hand-edit captions, add a handwritten
`note` for each trip (they show in gold, slightly tilted — give them soul), and
set your anniversary:

```js
window.TOGETHER_SINCE = "2023-06-01"; // powers the "days of us" counter
```

## Little details worth knowing

- **🌙 in the top-right corner** (bottom-right on phones) — tap it.
- **Lightbox** — arrow keys / click arrows on desktop; **swipe left-right** on
  mobile, **swipe down** to close.
- **Filter chips** stick to the top and scroll horizontally on phones; the
  gold **newest ↓ / oldest ↑** toggle flips the journey order.
- **The map of us** appears automatically once any trip has GPS coordinates
  (from EXIF, or add `coords: [lat, lon]` by hand in `photos.js`).
- Honors `prefers-reduced-motion`.
- Everything is one HTML file + one manifest — easy to host anywhere
  (GitHub Pages, Netlify drop, a USB stick).
