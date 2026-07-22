# ☁ Deploying Wanderlight to DigitalOcean

Total cost: **~$10/month** — Spaces $5 (250 GB photos + 1 TB transfer + CDN
included) + App Platform basic-xxs $5 (the always-on upload server).
That 250 GB is roughly 50,000–80,000 phone photos.

## 1. Provision (one command, ~1 minute)

Run on any machine with Node and internet (your laptop is fine):

```bash
cd travel-gallery
npm install
DO_TOKEN=dop_v1_yourtoken node deploy/setup-digitalocean.js
```

This creates a Spaces access key, the bucket, and a CDN endpoint, then prints
the four `SPACES_*` env vars. **Save them — the secret is shown once.**

Add `--with-app` to also create the App Platform app automatically (works if
the GitHub repo is public / connected; otherwise the script prints the
3-click manual path).

Options: `SPACES_REGION=fra1` (default, Frankfurt — good for Estonia),
`SPACES_BUCKET=your-name`, `UPLOAD_KEY=secretword`.

## 2. Move existing photos to the cloud

```bash
SPACES_KEY=... SPACES_SECRET=... SPACES_BUCKET=... SPACES_REGION=... \
  node deploy/sync-to-spaces.js
```

## 3. Run

With the `SPACES_*` env vars set, `npm start` switches the server into
**cloud mode** automatically: uploads go straight to the bucket, the gallery
manifest is served live from Spaces, and photos come off the CDN. Without
them, everything keeps working from the local `photos/` folder — nothing
breaks either way.

## 4. Your domain (later)

Once the App Platform app is live: DigitalOcean console → your app →
Settings → Domains → add `yourdomain.com`, then point the DNS records it
shows you. HTTPS certificates are automatic. (Ask Claude when ready —
this is a 2-minute job.)

## Security notes

- Never commit `DO_TOKEN` or the `SPACES_*` secrets. They live in env vars
  (App Platform stores them encrypted as SECRET-type envs).
- Set `UPLOAD_KEY` in production so only the two of you can upload.
- Rotate any token that has ever been pasted into a chat or document.
