#!/usr/bin/env node
/**
 * Render every quant-viz visual recipe in Chromium at desktop and narrow sizes,
 * run structural and axe checks, and emit reproducible QA evidence.
 *
 * This runner lives outside the Skill package because it depends on the repo's
 * Playwright toolchain. It never connects to ClickHouse.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const moduleRoot = path.resolve(process.env.ZK_TZ_NODE_ROOT || repoRoot);
const requireFromFrontend = createRequire(path.join(moduleRoot, 'packages', 'frontend', 'package.json'));
const { chromium } = requireFromFrontend('playwright');
const AxeModule = requireFromFrontend('@axe-core/playwright');
const AxeBuilder = AxeModule.default || AxeModule;

const skillDir = path.resolve(process.env.QUANT_VIZ_SKILL_DIR || path.join(repoRoot, '.agents', 'skills', 'quant-viz'));
const recipeRoot = path.join(skillDir, 'assets', 'visual-recipes');
const outputRoot = path.resolve(process.env.QUANT_VIZ_RENDER_QA_OUT || path.join(repoRoot, 'artifacts', 'quant-viz-skill-evals', 'rendered-qa'));

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function loadRecipes() {
  const entries = await fs.readdir(recipeRoot, { withFileTypes: true });
  const recipes = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = path.join(recipeRoot, entry.name);
    const figurePath = path.join(dir, 'figure.svg');
    const manifestPath = path.join(dir, 'manifest.json');
    try {
      const [svg, manifestText] = await Promise.all([
        fs.readFile(figurePath, 'utf8'),
        fs.readFile(manifestPath, 'utf8'),
      ]);
      const manifest = JSON.parse(manifestText);
      recipes.push({ name: entry.name, svg, manifest, figurePath, manifestPath });
    } catch (error) {
      throw new Error(`Incomplete or invalid recipe ${entry.name}: ${error.message}`);
    }
  }
  return recipes;
}

function pick(object, paths, fallback = '') {
  for (const candidate of paths) {
    let value = object;
    for (const part of candidate.split('.')) {
      value = value && typeof value === 'object' ? value[part] : undefined;
    }
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return fallback;
}

function buildHtml(recipes) {
  const cards = recipes.map((recipe, index) => {
    const manifest = recipe.manifest;
    const title = pick(manifest, ['title', 'view_contract.reading_path.insight_title', 'view_contract.title'], recipe.name);
    const renderer = pick(manifest, ['renderer', 'view_contract.renderer.name'], 'unspecified');
    const semantic = pick(manifest, ['series.0.semantic', 'data_contract.measures.0.semantic', 'data_contract.measure'], 'see manifest');
    const sources = pick(manifest, ['source_layers', 'data_contract.sources'], []);
    const sourceText = Array.isArray(sources)
      ? sources.map((source) => source.provider || source.source || source.id || source.location || 'source').join(' · ')
      : String(sources);
    return `
      <article class="recipe" data-recipe="${escapeHtml(recipe.name)}" aria-labelledby="recipe-${index}-title">
        <header>
          <p class="index">${String(index + 1).padStart(2, '0')}</p>
          <div>
            <h2 id="recipe-${index}-title">${escapeHtml(title)}</h2>
            <p class="meta">${escapeHtml(recipe.name)} · renderer ${escapeHtml(renderer)} · ${escapeHtml(semantic)}</p>
          </div>
        </header>
        <div class="figure" data-testid="figure-${escapeHtml(recipe.name)}">${recipe.svg}</div>
        <footer>
          <span>Source: ${escapeHtml(sourceText || 'declared in manifest')}</span>
          <span>Manifest: ${escapeHtml(path.basename(recipe.manifestPath))}</span>
        </footer>
      </article>`;
  }).join('\n');

  return `<!doctype html>
  <html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Quant Viz v2 visual recipe QA</title>
    <style>
      :root { color-scheme: light; --bg:#f3f3ef; --paper:#fff; --ink:#17202a; --muted:#5f6b7a; --line:#d9dee5; }
      * { box-sizing:border-box; }
      html, body { margin:0; padding:0; background:var(--bg); color:var(--ink); font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
      main { max-width:1320px; margin:0 auto; padding:36px 24px 72px; }
      .intro { max-width:820px; margin-bottom:24px; }
      h1 { margin:0 0 8px; font-size:34px; letter-spacing:-.035em; }
      .intro p { color:var(--muted); margin:0; }
      .grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:18px; }
      .recipe { min-width:0; background:var(--paper); border:1px solid var(--line); border-radius:10px; padding:18px; overflow:hidden; }
      .recipe header { display:flex; gap:12px; align-items:flex-start; margin-bottom:12px; }
      .recipe h2 { font-size:18px; margin:0 0 3px; letter-spacing:-.015em; }
      .index { margin:1px 0 0; color:var(--muted); font:600 11px/1.2 ui-monospace,monospace; }
      .meta { margin:0; color:var(--muted); font-size:11px; overflow-wrap:anywhere; }
      .figure { width:100%; min-height:220px; display:grid; place-items:center; overflow:hidden; }
      .figure > svg { width:100%; height:auto; max-height:520px; display:block; }
      .recipe footer { display:flex; flex-wrap:wrap; justify-content:space-between; gap:6px 18px; border-top:1px solid var(--line); margin-top:12px; padding-top:10px; color:var(--muted); font-size:10px; overflow-wrap:anywhere; }
      @media (max-width:760px) {
        main { padding:24px 12px 48px; }
        h1 { font-size:27px; }
        .grid { grid-template-columns:1fr; }
        .recipe { padding:14px; }
        .figure { min-height:180px; }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="intro" aria-labelledby="page-title">
        <h1 id="page-title">Quant Viz v2 visual recipes</h1>
        <p>Browser QA surface for the packaged multimodal examples. Each recipe is paired with a semantic manifest and deterministic validators.</p>
      </section>
      <section class="grid" aria-label="Visual recipe gallery">${cards}</section>
    </main>
  </body>
  </html>`;
}

async function evaluateViewport(browser, html, viewport, screenshotName) {
  const page = await browser.newPage({ viewport });
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setContent(html, { waitUntil: 'load' });
  await page.emulateMedia({ reducedMotion: 'reduce' });

  const facts = await page.evaluate(() => {
    const recipes = [...document.querySelectorAll('.recipe')];
    const svgs = [...document.querySelectorAll('.recipe .figure > svg')];
    const invalidNumericText = document.body.innerText.match(/\b(?:NaN|Infinity|-Infinity)\b/g) || [];
    const boxes = svgs.map((svg) => {
      const rect = svg.getBoundingClientRect();
      return {
        recipe: svg.closest('.recipe')?.getAttribute('data-recipe') || 'unknown',
        width: rect.width,
        height: rect.height,
        visible: rect.width > 0 && rect.height > 0,
        marks: svg.querySelectorAll('path,rect,circle,line,polyline,polygon,text').length,
        titleCount: svg.querySelectorAll('title').length,
      };
    });
    return {
      recipeCount: recipes.length,
      svgCount: svgs.length,
      invalidNumericText,
      boxes,
      horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      criticalText: document.querySelector('h1')?.textContent || '',
    };
  });

  const axe = await new AxeBuilder({ page }).analyze();
  const blockingAxe = axe.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact));
  await fs.mkdir(outputRoot, { recursive: true });
  await page.screenshot({ path: path.join(outputRoot, screenshotName), fullPage: true });
  await page.close();

  const failures = [];
  if (facts.recipeCount < 10) failures.push(`expected at least 10 recipes, found ${facts.recipeCount}`);
  if (facts.svgCount !== facts.recipeCount) failures.push(`recipe/svg mismatch: ${facts.recipeCount}/${facts.svgCount}`);
  for (const box of facts.boxes) {
    if (!box.visible || box.width < 80 || box.height < 60) failures.push(`non-visible or undersized SVG: ${box.recipe}`);
    if (box.marks === 0) failures.push(`blank SVG with zero marks: ${box.recipe}`);
  }
  if (facts.invalidNumericText.length) failures.push(`invalid numeric labels: ${facts.invalidNumericText.join(', ')}`);
  if (facts.horizontalOverflow > 2) failures.push(`horizontal overflow ${facts.horizontalOverflow}px`);
  if (!facts.criticalText.trim()) failures.push('missing visible page-level critical heading');
  if (consoleErrors.length) failures.push(`console errors: ${consoleErrors.join(' | ')}`);
  if (pageErrors.length) failures.push(`page errors: ${pageErrors.join(' | ')}`);
  if (blockingAxe.length) failures.push(`serious/critical axe violations: ${blockingAxe.map((v) => v.id).join(', ')}`);

  return {
    viewport,
    screenshot: path.join(outputRoot, screenshotName),
    facts,
    consoleErrors,
    pageErrors,
    axe: {
      violationCount: axe.violations.length,
      seriousOrCritical: blockingAxe.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })),
    },
    failures,
    status: failures.length ? 'fail' : 'pass',
  };
}

async function main() {
  const recipes = await loadRecipes();
  if (recipes.length < 10) throw new Error(`Expected at least 10 complete recipes, found ${recipes.length}`);
  const html = buildHtml(recipes);
  await fs.mkdir(outputRoot, { recursive: true });
  await fs.writeFile(path.join(outputRoot, 'recipe-gallery.html'), html, 'utf8');

  const browser = await chromium.launch({ headless: true });
  try {
    const results = [];
    results.push(await evaluateViewport(browser, html, { width: 1440, height: 900 }, 'recipes-desktop.png'));
    results.push(await evaluateViewport(browser, html, { width: 390, height: 844 }, 'recipes-narrow.png'));
    const failures = results.flatMap((result) => result.failures.map((failure) => `${result.viewport.width}x${result.viewport.height}: ${failure}`));
    const report = {
      status: failures.length ? 'fail' : 'pass',
      generatedAt: new Date().toISOString(),
      skillDir,
      recipeCount: recipes.length,
      recipes: recipes.map((recipe) => recipe.name),
      results,
      failures,
    };
    const reportPath = path.join(outputRoot, 'render-qa-results.json');
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ status: report.status, recipeCount: recipes.length, failures, reportPath }, null, 2));
    process.exitCode = failures.length ? 1 : 0;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 2;
});
