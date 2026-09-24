#!/usr/bin/env node
// Downloads the CC0 assets used by the remake from Poly Haven (plus the MIT water normal map from three.js)
// into public/assets, verifies md5 checksums and writes public/assets/CREDITS.md.
// Idempotent: files that already exist with the right checksum are skipped.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'assets');
const API = 'https://api.polyhaven.com';
const UA = 'beachhead-2000-remake-asset-fetcher (+https://github.com/themaxaboy/beachhead-2000-remake)';
const BUDGET_MB = 25;

const MANIFEST = [
  { id: 'kloofendal_48d_partly_cloudy_puresky', kind: 'hdri', res: '2k', as: 'day' },
  { id: 'qwantani_dusk_2_puresky', kind: 'hdri', res: '2k', as: 'dusk' },
  { id: 'qwantani_moonrise_puresky', kind: 'hdri', res: '1k', as: 'night' },
  { id: 'coast_sand_01', kind: 'texture', res: '1k', maps: ['Diffuse', 'nor_gl'] },
  { id: 'damp_beach_sand', kind: 'texture', res: '1k', maps: ['Diffuse', 'nor_gl'] },
  { id: 'concrete', kind: 'texture', res: '1k', maps: ['Diffuse', 'nor_gl', 'Rough'] },
  { id: 'green_metal_rust', kind: 'texture', res: '1k', maps: ['Diffuse', 'nor_gl', 'Rough'] },
  { id: 'rusty_metal', kind: 'texture', res: '1k', maps: ['Diffuse', 'nor_gl', 'Rough'] },
  { id: 'old_military_crate', kind: 'model', res: '1k' },
  { id: 'rock_07', kind: 'model', res: '1k' },
  { id: 'barrel_03', kind: 'model', res: '1k' },
];

const EXTRA = [
  {
    url: 'https://raw.githubusercontent.com/mrdoob/three.js/r186/examples/textures/waternormals.jpg',
    path: 'textures/waternormals.jpg',
  },
];

const MAP_SUFFIX = { Diffuse: 'diff', nor_gl: 'nor_gl', Rough: 'rough' };

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function md5File(path) {
  try {
    const buf = await readFile(path);
    return createHash('md5').update(buf).digest('hex');
  } catch {
    return null;
  }
}

async function download(url, dest, md5) {
  if (md5 && (await md5File(dest)) === md5) return { skipped: true, size: (await stat(dest)).size };
  if (!md5) {
    try {
      const s = await stat(dest);
      if (s.size > 0) return { skipped: true, size: s.size };
    } catch { /* not there yet */ }
  }
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (md5) {
        const got = createHash('md5').update(buf).digest('hex');
        if (got !== md5) throw new Error(`md5 mismatch for ${url}: ${got} != ${md5}`);
      }
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, buf);
      return { skipped: false, size: buf.length };
    } catch (err) {
      if (attempt === 4) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

async function jobsFor(entry) {
  const files = await getJSON(`${API}/files/${entry.id}`);
  const jobs = [];
  if (entry.kind === 'hdri') {
    const f = files.hdri[entry.res].hdr;
    jobs.push({ url: f.url, md5: f.md5, dest: join(OUT, 'hdri', `${entry.as}_${entry.res}.hdr`) });
  } else if (entry.kind === 'texture') {
    for (const map of entry.maps) {
      const f = files[map][entry.res].jpg;
      jobs.push({
        url: f.url,
        md5: f.md5,
        dest: join(OUT, 'textures', entry.id, `${entry.id}_${MAP_SUFFIX[map]}_${entry.res}.jpg`),
      });
    }
  } else if (entry.kind === 'model') {
    const g = files.gltf[entry.res].gltf;
    jobs.push({ url: g.url, md5: g.md5, dest: join(OUT, 'models', entry.id, `${entry.id}_${entry.res}.gltf`) });
    for (const [rel, f] of Object.entries(g.include || {})) {
      jobs.push({ url: f.url, md5: f.md5, dest: join(OUT, 'models', entry.id, rel) });
    }
  }
  return jobs;
}

async function runPool(items, n, fn) {
  const results = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const idx = i++;
        results[idx] = await fn(items[idx]);
      }
    }),
  );
  return results;
}

async function main() {
  const jobs = [];
  const credits = [];
  for (const entry of MANIFEST) {
    jobs.push(...(await jobsFor(entry)));
    const info = await getJSON(`${API}/info/${entry.id}`);
    credits.push({ id: entry.id, name: info.name, kind: entry.kind, authors: Object.keys(info.authors || {}) });
  }
  for (const e of EXTRA) jobs.push({ url: e.url, md5: null, dest: join(OUT, e.path) });

  let total = 0;
  await runPool(jobs, 4, async (job) => {
    const r = await download(job.url, job.dest, job.md5);
    total += r.size;
    console.log(`${r.skipped ? 'ok  ' : 'get '} ${(r.size / 1e6).toFixed(2).padStart(6)} MB  ${job.dest.replace(ROOT + '/', '')}`);
  });

  const lines = [
    '# Asset credits',
    '',
    'All textures, HDRIs and models below come from [Poly Haven](https://polyhaven.com) and are released under',
    '[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). Thank you to the authors!',
    '',
    '| Asset | Type | Author(s) | Link |',
    '|---|---|---|---|',
    ...credits.map(
      (c) => `| ${c.name} | ${c.kind} | ${c.authors.join(', ')} | https://polyhaven.com/a/${c.id} |`,
    ),
    '',
    '`textures/waternormals.jpg` comes from the [three.js](https://github.com/mrdoob/three.js) examples (MIT License).',
    '',
    'Vehicles, aircraft, soldiers, particles and all sound effects are generated procedurally in code.',
    '',
  ];
  await writeFile(join(OUT, 'CREDITS.md'), lines.join('\n'));

  const mb = total / 1e6;
  console.log(`\nTotal: ${mb.toFixed(2)} MB (budget ${BUDGET_MB} MB)`);
  if (mb > BUDGET_MB) {
    console.error('Asset budget exceeded');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
