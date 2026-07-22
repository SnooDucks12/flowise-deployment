#!/usr/bin/env node
/* ============================================================
   Wanderlight ☁ DigitalOcean provisioning — one command
   ------------------------------------------------------------
   Creates everything the gallery needs on DigitalOcean:
     1. A Spaces access key (for the S3 API)
     2. A Spaces bucket ($5/mo — 250 GB storage + 1 TB transfer)
     3. A CDN endpoint in front of it (included, no extra cost)
     4. (optional) An App Platform app running server.js

   Usage — from inside travel-gallery/ with deps installed:
     npm install
     DO_TOKEN=dop_v1_xxx node deploy/setup-digitalocean.js
     DO_TOKEN=dop_v1_xxx SPACES_REGION=fra1 node deploy/setup-digitalocean.js

   NEVER commit the token. It is read from the environment only.
   Default region fra1 (Frankfurt — closest to Estonia).
   ============================================================ */
const https = require("https");
const crypto = require("crypto");

const TOKEN = process.env.DO_TOKEN;
const REGION = process.env.SPACES_REGION || "fra1";
const BUCKET = process.env.SPACES_BUCKET || `wanderlight-${crypto.randomBytes(3).toString("hex")}`;
const CREATE_APP = process.argv.includes("--with-app");

if (!TOKEN) {
  console.error("Set DO_TOKEN=dop_v1_... in the environment first (do not paste it into files).");
  process.exit(1);
}

function api(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: "api.digitalocean.com",
      path: apiPath,
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let out = "";
      res.on("data", (c) => (out += c));
      res.on("end", () => {
        let json = {};
        try { json = JSON.parse(out || "{}"); } catch {}
        if (res.statusCode >= 400) return reject(new Error(`${method} ${apiPath} → ${res.statusCode}: ${json.message || out.slice(0, 200)}`));
        resolve(json);
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  // 1 — verify token
  const acct = await api("GET", "/v2/account");
  console.log(`✓ Token OK — account ${acct.account.email} (${acct.account.status})`);

  // 2 — Spaces access key
  console.log("Creating Spaces access key…");
  const keyRes = await api("POST", "/v2/spaces/keys", { name: `wanderlight-${Date.now().toString(36)}` });
  const accessKey = keyRes.key.access_key;
  const secretKey = keyRes.key.secret_key;
  console.log(`✓ Spaces key created: ${accessKey}`);

  // 3 — bucket via the S3 API
  console.log(`Creating bucket "${BUCKET}" in ${REGION}…`);
  const { S3Client, CreateBucketCommand, HeadBucketCommand } = require("@aws-sdk/client-s3");
  const s3 = new S3Client({
    region: "us-east-1",
    endpoint: `https://${REGION}.digitaloceanspaces.com`,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  });
  // new keys can take a few seconds to propagate
  let made = false;
  for (let i = 0; i < 6 && !made; i++) {
    try {
      await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
      made = true;
    } catch (e) {
      if (e.name === "BucketAlreadyOwnedByYou" || e.name === "BucketAlreadyExists") { made = true; break; }
      await new Promise((r) => setTimeout(r, 5000));
      if (i === 5) throw e;
    }
  }
  await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
  console.log(`✓ Bucket ready: https://${BUCKET}.${REGION}.digitaloceanspaces.com`);

  // 4 — CDN endpoint (free, faster photo loads worldwide)
  let cdn = "";
  try {
    const cdnRes = await api("POST", "/v2/cdn/endpoints", { origin: `${BUCKET}.${REGION}.digitaloceanspaces.com`, ttl: 3600 });
    cdn = `https://${cdnRes.endpoint.endpoint}`;
    console.log(`✓ CDN enabled: ${cdn}`);
  } catch (e) {
    console.log(`ℹ CDN endpoint skipped (${e.message}) — the direct bucket URL works fine too.`);
  }

  // 5 — optional App Platform app
  if (CREATE_APP) {
    console.log("Creating App Platform app…");
    const spec = {
      name: "wanderlight",
      region: REGION.replace(/\d+$/, ""),
      services: [{
        name: "web",
        git: { repo_clone_url: "https://github.com/SnooDucks12/flowise-deployment.git", branch: "main" },
        source_dir: "travel-gallery",
        build_command: "npm install",
        run_command: "npm start",
        http_port: 4747,
        instance_size_slug: "basic-xxs",
        instance_count: 1,
        envs: [
          { key: "SPACES_KEY", value: accessKey, type: "SECRET" },
          { key: "SPACES_SECRET", value: secretKey, type: "SECRET" },
          { key: "SPACES_BUCKET", value: BUCKET },
          { key: "SPACES_REGION", value: REGION },
          ...(cdn ? [{ key: "SPACES_CDN", value: cdn }] : []),
          ...(process.env.UPLOAD_KEY ? [{ key: "UPLOAD_KEY", value: process.env.UPLOAD_KEY, type: "SECRET" }] : []),
        ],
      }],
    };
    try {
      const appRes = await api("POST", "/v2/apps", { spec });
      console.log(`✓ App created: ${appRes.app.id} — it will build and go live in a few minutes.`);
      console.log("  Watch it at https://cloud.digitalocean.com/apps");
    } catch (e) {
      console.log(`ℹ App creation needs the repo to be reachable (${e.message}).`);
      console.log("  If the repo is private: DigitalOcean console → Apps → Create App → connect GitHub,");
      console.log("  pick the repo, set source dir travel-gallery, run command `npm start`, port 4747,");
      console.log("  and paste the env vars printed below.");
    }
  }

  console.log("\n──────────────────────────────────────────────");
  console.log("Environment for the server (save these — the secret is shown only once):\n");
  console.log(`  export SPACES_KEY=${accessKey}`);
  console.log(`  export SPACES_SECRET=${secretKey}`);
  console.log(`  export SPACES_BUCKET=${BUCKET}`);
  console.log(`  export SPACES_REGION=${REGION}`);
  if (cdn) console.log(`  export SPACES_CDN=${cdn}`);
  console.log("\nNext:");
  console.log("  node deploy/sync-to-spaces.js    # push any local photos + manifest to the cloud");
  console.log("  npm start                        # server now runs in ☁ cloud mode");
  if (!CREATE_APP) console.log("  (re-run with --with-app to also create the App Platform app)");
})().catch((e) => { console.error("✗", e.message); process.exit(1); });
