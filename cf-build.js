/* Stages the static app into public/ for Cloudflare Workers.
   The upload must contain ONLY the browser files, so the assets directory is
   a clean folder we build here instead of pointing wrangler at "." (scanning
   node_modules made `wrangler dev` hang). DATABASE_URL etc. can never leak
   from public/ because nothing but the files below is copied.
   Run:  node cf-build.js   (npm run cf:dev / cf:deploy call it first) */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const OUT = path.join(ROOT, "public");
/* index.html is fully self-contained (inline CSS + one inline script, fonts
   come from Google Fonts) — no other browser files are needed. */
const FILES = ["index.html"];

fs.mkdirSync(OUT, { recursive: true });
for (const f of FILES) {
  const src = path.join(ROOT, f);
  if (!fs.existsSync(src)) { console.error("missing " + f + " — aborting."); process.exit(1); }
  fs.copyFileSync(src, path.join(OUT, f));
  console.log("public/" + f + "  (" + fs.statSync(path.join(OUT, f)).size + " bytes)");
}
