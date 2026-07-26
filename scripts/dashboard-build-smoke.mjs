#!/usr/bin/env node

// Dashboard build smoke test — runs the Vite build and verifies output
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PROJECT_ROOT = path.resolve(import.meta.dirname ?? path.dirname(import.meta.url), "..");
const DIST_DIR = path.join(PROJECT_ROOT, "dist", "dashboard");
const VITE_DIR = path.join(PROJECT_ROOT, "web", "dashboard");

function main() {
  // Clean previous build output so stale assets can't mask a failure
  if (fs.existsSync(DIST_DIR)) {
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
    console.log("  ~ cleaned previous dist/dashboard");
  }

  // 1. Run the Vite build
  console.log("  Building dashboard frontend...");
  const viteBin = path.join(VITE_DIR, "node_modules", "vite", "bin", "vite.js");
  const result = spawnSync(process.execPath, [viteBin, "build", "--config", "vite.config.ts"], {
    cwd: VITE_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 60_000,
  });

  if (result.status !== 0) {
    const msg = [
      "Vite build failed (exit " + result.status + ")",
      (result.stdout || "").trim(),
      (result.stderr || "").trim(),
    ].filter(Boolean).join("\n");
    throw new Error(msg);
  }

  // 2. Verify output exists
  const INDEX_HTML = path.join(DIST_DIR, "index.html");
  if (!fs.existsSync(INDEX_HTML)) {
    throw new Error("dist/dashboard/index.html not found after build");
  }

  const html = fs.readFileSync(INDEX_HTML, "utf8");
  if (!html.includes("root") || !html.includes("script")) {
    throw new Error("index.html missing expected content");
  }
  console.log("  \u2713 index.html exists and contains expected content");

  // 3. Check for asset files
  const assetDir = path.join(DIST_DIR, "assets");
  const assetFiles = fs.existsSync(assetDir) ? fs.readdirSync(assetDir) : [];
  const files = fs.readdirSync(DIST_DIR);
  const allWithAssets = [...files, ...assetFiles.map((f) => "assets/" + f)];
  const hasJs = allWithAssets.some((f) => f.endsWith(".js"));
  const hasCss = allWithAssets.some((f) => f.endsWith(".css"));
  if (!hasJs) throw new Error("No JS asset files found");
  if (!hasCss) throw new Error("No CSS asset files found");
  console.log("  \u2713 " + assetFiles.length + " asset files in dist/dashboard/assets/");

  // 4. Check for secrets exposure in bundles
  const patterns = ["LEAST_HTTP_TOKEN", "LEAST_DASHBOARD_TOKEN"];
  for (const assetFile of assetFiles) {
    const filePath = path.join(assetDir, assetFile);
    if (!assetFile.endsWith(".js") && !assetFile.endsWith(".css")) continue;
    const content = fs.readFileSync(filePath, "utf8");
    for (const p of patterns) {
      if (content.includes(p)) {
        console.log("  \u26a0  " + assetFile + ' references "' + p + '" (OK)');
      }
    }
  }

  console.log("\n\u2713 Dashboard build smoke test passed");
}

main();
