#!/usr/bin/env node
// Headless smoke test: loads the game in Chromium (SwiftShader), drives it through the menu and a few missions
// with the window.__bh debug API, fails on console errors and saves screenshots to artifacts/.
//
// Usage: npm run dev (or preview) in another terminal, then
//   BASE_URL=http://localhost:5173/ npm run smoke
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const BASE = process.env.BASE_URL || 'http://localhost:5173/';
const OUT = process.env.OUT_DIR || 'artifacts';
const W = Number(process.env.WIDTH || 1280);
const H = Number(process.env.HEIGHT || 720);
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
process.env.PLAYWRIGHT_BROWSERS_PATH ||= '/opt/pw-browsers';

const IGNORE = [/ERR_CERT_AUTHORITY_INVALID/, /KHR_parallel_shader_compile/, /GPU stall due to ReadPixels/, /Automatic fallback to software WebGL/, /WebGL: too many errors/, /fonts\.g/];

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
  });
  const errors = [];
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  page.on('console', (msg) => {
    const t = msg.text();
    if ((msg.type() === 'error' || msg.type() === 'warning') && !IGNORE.some((r) => r.test(t))) errors.push(`[${msg.type()}] ${t}`);
  });
  page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}\n${err.stack}`));
  page.on('requestfailed', (req) => {
    if (!/fonts\.g/.test(req.url())) errors.push(`[requestfailed] ${req.url()}`);
  });

  const shot = async (name) => {
    await page.evaluate(() => window.__bh.renderOnce());
    await page.screenshot({ path: `${OUT}/${name}.png`, timeout: 120000 });
    console.log('screenshot', `${OUT}/${name}.png`);
  };
  const want = (name) => !ONLY || ONLY.includes(name);

  await page.goto(`${BASE}?nolock&norender&mute&seed=1&quality=${process.env.QUALITY || 'low'}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__bh && window.__bh.ready, null, { timeout: 180000 });
  if (want('menu')) {
    await shot('01-click');
    await page.click('button[data-action="main"]');
    await page.waitForTimeout(500);
    await shot('02-menu');
    await page.click('button[data-action="help"]');
    await shot('03-help-controls');
    await page.click('button[data-action="help"][data-page="1"]');
    await shot('04-help-interface');
    await page.click('button[data-action="help"][data-page="2"]');
    await shot('05-help-overview');
    await page.click('button[data-action="main"]');
    await page.click('button[data-action="scores"]');
    await shot('06-scores');
    await page.click('button[data-action="main"]');
    await page.click('button[data-action="options"]');
    await shot('07-options');
    await page.click('button[data-action="back"]');
  }

  if (want('level1')) {
    await page.evaluate(async () => {
      await window.__bh.game.startCampaign(1, false);
    });
    await page.waitForTimeout(300);
    await shot('10-briefing');
    await page.evaluate(() => {
      const b = window.__bh;
      b.game.beginLevel();
      b.game.enterPlaying();
      b.advance(24);
      const lct = b.game.entities.list.find((e) => e.type === 'lct');
      if (lct) b.aimAt({ pos: { x: lct.pos.x, y: lct.pos.y + 2, z: lct.pos.z } });
    });
    await page.waitForTimeout(400);
    await shot('11-level1-approach');
    await page.evaluate(() => {
      const b = window.__bh;
      b.fire(0.5);
    });
    await page.waitForTimeout(300);
    await shot('12-level1-firing');
    await page.evaluate(() => {
      const b = window.__bh;
      b.advance(14);
      b.aim(0, -6);
    });
    await page.waitForTimeout(300);
    await shot('13-level1-beach');
    console.log('level1 stats', await page.evaluate(() => window.__bh.stats()));
  }

  if (want('weapons')) {
    for (const w of ['at', 'missile', 'pistol', 'howitzer']) {
      await page.evaluate((w) => {
        const b = window.__bh;
        b.game.weapons.ammo.howitzer = Math.max(1, b.game.weapons.ammo.howitzer);
        b.select(w);
        b.advance(0.5);
      }, w);
      await page.waitForTimeout(200);
      await shot(`20-weapon-${w}`);
    }
  }

  if (want('level30')) {
    await page.evaluate(async () => {
      const b = window.__bh;
      await b.start(30);
      b.setInvulnerable(true);
      b.advance(70);
      b.aim(20, 4);
    });
    await page.waitForTimeout(400);
    await shot('30-level30-dusk');
    console.log('level30 stats', await page.evaluate(() => window.__bh.stats()));
  }

  if (want('night')) {
    await page.evaluate(async () => {
      const b = window.__bh;
      await b.start(17);
      b.setInvulnerable(true);
      b.advance(50);
      b.aim(-10, 3);
    });
    await page.waitForTimeout(400);
    await shot('40-night');
  }

  if (want('complete')) {
    await page.evaluate(async () => {
      const b = window.__bh;
      await b.start(3);
      b.advance(5);
      b.killAll();
      b.advance(4);
    });
    await page.waitForTimeout(400);
    await shot('50-complete');
    await page.evaluate(async () => {
      const b = window.__bh;
      await b.start(2);
      b.advance(2);
      b.game.bunker.damage(1000, { x: 0, y: 0, z: -50 });
      b.advance(4);
    });
    await page.waitForTimeout(400);
    await shot('51-gameover');
  }

  await browser.close();
  if (errors.length) {
    console.error(`\n${errors.length} console problem(s):`);
    for (const e of errors.slice(0, 40)) console.error(e);
    process.exit(1);
  }
  console.log('\nsmoke OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
