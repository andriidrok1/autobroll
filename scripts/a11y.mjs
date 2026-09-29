// Accessibility audit: runs axe-core against the running editor (npm start)
// on the Start screen and inside an opened project (every Inspector tab).
//
//   npm run a11y                       → docs/a11y/report.json + summary
//   node scripts/a11y.mjs out.json     → custom output path
//   A11Y_URL=http://localhost:5173 …   → custom editor URL
//   A11Y_SHOTS=dir                     → also save a screenshot per screen
//
// Uses playwright-core with the Chromium from ~/.cache/ms-playwright
// (`npx playwright-core install chromium` if missing). --no-sandbox because
// some distros (AppArmor) block Chromium's user namespaces.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {AxeBuilder} from '@axe-core/playwright';

const URL = process.env.A11Y_URL || 'http://localhost:5173';
const OUT = path.resolve(process.argv[2] || 'docs/a11y/report.json');
const SHOTS = process.env.A11Y_SHOTS ? path.resolve(process.env.A11Y_SHOTS) : null;
const IMPACTS = ['critical', 'serious', 'moderate', 'minor'];

const findChromium = () => {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  if (!fs.existsSync(cache)) return null;
  const dirs = fs.readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
  for (const d of dirs) {
    for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(cache, d, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
};

const executablePath = findChromium();
if (!executablePath) {
  console.error('No Chromium found in ~/.cache/ms-playwright — run: npx playwright-core install chromium');
  process.exit(2);
}

const browser = await chromium.launch({executablePath, headless: true, args: ['--no-sandbox', '--disable-gpu']});
const context = await browser.newContext({viewport: {width: 1440, height: 900}});
const page = await context.newPage();
const screens = [];
const seen = new Map(); // rule id + target → violation node (dedupe across screens)

const audit = async (name) => {
  await page.waitForTimeout(400);
  if (SHOTS) {
    fs.mkdirSync(SHOTS, {recursive: true});
    await page.screenshot({path: path.join(SHOTS, `${name}.png`)});
  }
  const res = await new AxeBuilder({page}).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
  const violations = res.violations.map((v) => ({
    id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl,
    nodes: v.nodes.map((n) => ({target: n.target, html: n.html, summary: n.failureSummary})),
  }));
  for (const v of violations) for (const n of v.nodes) {
    const key = `${v.id}|${n.target.join(' ')}`;
    if (!seen.has(key)) seen.set(key, {rule: v.id, impact: v.impact, screen: name, target: n.target.join(' '), html: n.html});
  }
  screens.push({name, url: page.url(), violations, passes: res.passes.length, incomplete: res.incomplete.length});
  console.log(`${name}: ${violations.length} rule(s) violated, ${violations.reduce((n, v) => n + v.nodes.length, 0)} node(s)`);
};

try {
  await page.goto(URL, {waitUntil: 'networkidle'});
  await page.getByRole('heading', {name: 'AutoBroll'}).waitFor();
  await audit('start');

  // open the most recent project, if the library has one
  const first = page.getByRole('button', {name: /clip/}).first();
  if (await first.count()) {
    await first.click();
    await page.getByRole('region', {name: 'Timeline'}).or(page.locator('footer')).first().waitFor();
    await page.waitForTimeout(1500); // player + thumbnails
    await audit('editor');

    // select the first clip → Inspector shows the clip card (speed/volume controls)
    const clip = page.getByRole('option').first();
    if (await clip.count()) await clip.click();
    else await page.locator('aside button img').first().click();
    await audit('editor-clip-selected');

    for (const tab of ['B-roll', 'Styles', 'Settings']) {
      await page.getByRole('tab', {name: tab}).or(page.getByRole('button', {name: tab, exact: true})).first().click();
      await audit(`editor-tab-${tab.toLowerCase()}`);
    }
  } else {
    console.log('(no recent projects — editor screens skipped)');
  }
} finally {
  await browser.close();
}

const byImpact = Object.fromEntries(IMPACTS.map((i) => [i, 0]));
for (const v of seen.values()) byImpact[v.impact ?? 'minor']++;
const byRule = {};
for (const v of seen.values()) byRule[v.rule] = (byRule[v.rule] || 0) + 1;

fs.mkdirSync(path.dirname(OUT), {recursive: true});
fs.writeFileSync(OUT, JSON.stringify({generatedAt: new Date().toISOString(), url: URL, summary: {byImpact, byRule, uniqueNodes: seen.size}, unique: [...seen.values()], screens}, null, 2));
console.log(`\nUnique violating nodes: ${seen.size}`);
console.log(IMPACTS.map((i) => `${i}: ${byImpact[i]}`).join('  '));
for (const [rule, n] of Object.entries(byRule).sort((a, b) => b[1] - a[1])) console.log(`  ${rule}: ${n}`);
console.log(`→ ${OUT}`);
process.exit(byImpact.critical + byImpact.serious > 0 ? 1 : 0);
