# 📸 Drop your photos here

Each **trip = one folder**, named like this:

```
2024-06 Amalfi Coast/
2025-01 Lapland/
2026-07 Somewhere New/
```

The `YYYY-MM` prefix becomes the chapter date, the rest becomes the chapter
title. Photo filenames become captions (`boat-day.jpg` → *"boat day"*), and
you can rewrite any caption later in `photos.js` — your edits are preserved.

**Uploading from the GitHub website:** open a trip folder → *Add file →
Upload files* → drag photos in → commit. Then tell Claude "I uploaded" and
the gallery regenerates itself (EXIF dates, places, the constellation map,
resizing — all automatic).

**Or run the backend** (`npm start` in `travel-gallery/`) and upload from
your phone at `/upload` — camera, captions, and location included.

JPEG / PNG / WebP work everywhere. iPhone HEIC files need converting first
(export as "Most Compatible").
