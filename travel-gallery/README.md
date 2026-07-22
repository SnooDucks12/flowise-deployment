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
- **Filter chips** stick to the top and scroll horizontally on phones.
- Honors `prefers-reduced-motion`.
- Everything is one HTML file + one manifest — easy to host anywhere
  (GitHub Pages, Netlify drop, a USB stick).
