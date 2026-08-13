/* ============================================================
   Wanderlight — photo manifest
   ------------------------------------------------------------
   HOW TO ADD YOUR OWN PHOTOS
   1. Drop your images into folders like:
        photos/2024-06 Paris/IMG_001.jpg
        photos/2025-01 Lapland/IMG_002.jpg
      (folder name = "YYYY-MM Trip name")
   2. Run:  node generate-manifest.js
      → this file is rewritten automatically from those folders.
   3. Open index.html. Done.

   Or edit this file by hand — each trip is:
     { id, title, location, date, note, photos: [{ src, caption }] }

   TOGETHER_SINCE powers the "days of us" counter on the hero.
   Set it to your real anniversary date! 💗
   ============================================================ */

window.TOGETHER_SINCE = "2023-06-01"; // ← change to your date, Liina & Ralf!

/* Demo "postcards" below (hand-drawn SVG art in demo-photos/) so the
   site looks alive out of the box, fully offline. They are replaced
   the moment you run generate-manifest.js with your own photos. */
window.TRIPS = [
  {
    id: "lapland",
    coords: [67.9222, 26.5046],
    title: "Chasing the Aurora",
    location: "Lapland, Finland",
    date: "Jan 2025",
    note: "Liina swore the sky was dancing just for us. Ralf swore his toes fell off. Both were right.",
    photos: [
      { src: "demo-photos/lapland-1.svg", caption: "the night the sky turned green" },
      { src: "demo-photos/lapland-2.svg", caption: "cabin lights & cocoa" },
      { src: "demo-photos/lapland-3.svg", caption: "snow up to our knees" },
      { src: "demo-photos/lapland-4.svg", caption: "husky kisses" },
      { src: "demo-photos/lapland-5.svg", caption: "frozen lake, warm hands" },
    ],
  },
  {
    id: "amalfi",
    coords: [40.6281, 14.4850],
    title: "Lemon Summer",
    location: "Amalfi Coast, Italy",
    date: "Jun 2024",
    note: "We said 'just one more gelato' eleven times. Zero regrets.",
    photos: [
      { src: "demo-photos/amalfi-1.svg", caption: "positano stairs, worth every step" },
      { src: "demo-photos/amalfi-2.svg", caption: "the bluest blue" },
      { src: "demo-photos/amalfi-3.svg", caption: "lemons bigger than our plans" },
      { src: "demo-photos/amalfi-4.svg", caption: "sunset from the boat" },
      { src: "demo-photos/amalfi-5.svg", caption: "pasta with a view" },
      { src: "demo-photos/amalfi-6.svg", caption: "golden hour, golden us" },
    ],
  },
  {
    id: "tokyo",
    coords: [35.6762, 139.6503],
    title: "Neon Dreams",
    location: "Tokyo, Japan",
    date: "Oct 2024",
    note: "10,000 vending machines, one shared umbrella, infinite ramen.",
    photos: [
      { src: "demo-photos/tokyo-1.svg", caption: "shibuya glow" },
      { src: "demo-photos/tokyo-2.svg", caption: "quiet shrine morning" },
      { src: "demo-photos/tokyo-3.svg", caption: "midnight ramen run" },
      { src: "demo-photos/tokyo-4.svg", caption: "cherry trees out of season, still magic" },
      { src: "demo-photos/tokyo-5.svg", caption: "rainy day, neon reflections" },
    ],
  },
  {
    id: "iceland",
    coords: [63.9850, -19.0208],
    title: "Edge of the World",
    location: "Iceland",
    date: "Apr 2025",
    note: "Waterfalls, black sand, and Ralf's drone almost flying to Greenland.",
    photos: [
      { src: "demo-photos/iceland-1.svg", caption: "the road to nowhere & everywhere" },
      { src: "demo-photos/iceland-2.svg", caption: "skógafoss soaked us completely" },
      { src: "demo-photos/iceland-3.svg", caption: "black sand, white waves" },
      { src: "demo-photos/iceland-4.svg", caption: "glacier lagoon blues" },
      { src: "demo-photos/iceland-5.svg", caption: "hot spring hair, don't care" },
    ],
  },
];
