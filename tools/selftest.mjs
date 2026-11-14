// Launch Radar self-test: restates the sealed gate's rows and this entry's
// own stricter contract, then checks a real double run against all of them.
//
//   node tools/selftest.mjs --input <snapshot.json|input-dir>
//
// With no --input it tries /input/snapshot.json and ../input/snapshot.json.
// Prints one PASS line per check and exits 1 on the first failure list.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from '../vendor/makefun-board.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
let failures = 0;
function check(name, ok, detail) {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name} — ${detail}`);
  if (!ok) failures++;
}

function arg(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : null;
}
let input = arg('input');
if (input === null) {
  for (const cand of ['/input/snapshot.json', join(root, '..', 'input', 'snapshot.json'), join(root, 'input', 'snapshot.json')]) {
    if (existsSync(cand)) { input = cand; break; }
  }
}
if (input === null) {
  process.stderr.write('selftest: no snapshot found: pass --input <snapshot.json|input-dir>\n');
  process.exit(2);
}
const inputFile = input.endsWith('.json') ? input : join(input, 'snapshot.json');
const snapshot = JSON.parse(readFileSync(inputFile, 'utf8'));
const snapSlugs = new Set(snapshot.protocols.map((p) => p.slug));

// ---- run the program twice, into two fresh output directories -------------
function runOnce() {
  const out = mkdtempSync(join(tmpdir(), 'radar-out-'));
  execFileSync(process.execPath, [join(root, 'main.ts'), '--input', inputFile], {
    env: { ...process.env, MAKEFUN_OUTPUT_DIR: out },
    stdio: 'pipe',
  });
  return out;
}
const outA = runOnce();
const outB = runOnce();
const readOut = (out, name) => readFileSync(join(out, name));

// ---- board rows -------------------------------------------------------------
const board = JSON.parse(readOut(outA, 'board.json').toString('utf8'));
const rows = board.rows;
check('board row count', rows.length === 198 && rows.length >= 100 && rows.length <= 4000, `${rows.length} rows (entry contract 198, gate range 100..4000)`);

const ranks = rows.map((r) => r.rank).sort((a, b) => a - b);
check('ranks 1..N', ranks.every((v, i) => v === i + 1), `ranks are exactly 1..${rows.length}, once each`);

const slugOk = rows.every((r) => typeof r.slug === 'string' && r.slug.length >= 1 && r.slug.length <= 128 && !/\s/.test(r.slug) && snapSlugs.has(r.slug)) &&
  new Set(rows.map((r) => r.slug)).size === rows.length;
check('slugs valid', slugOk, 'every slug is a snapshot protocol, unique, 1..128 chars, no whitespace');

const covered = snapshot.watchlist.filter((s) => rows.some((r) => r.slug === s)).length;
check('watchlist coverage', covered === snapshot.watchlist.length, `${covered}/${snapshot.watchlist.length} watchlist slugs on the board`);

const sorted = rows.every((r, i) => i === 0 || rows[i - 1].implied_value_usd >= r.implied_value_usd) &&
  rows[0].implied_value_usd !== rows[rows.length - 1].implied_value_usd;
check('sorted by value', sorted, 'implied_value_usd never rises as rank ascends, and the board is not flat');

const TAIL = /\[cost \$(\d+) \| (\d+) min\]\s*$/;
let stepsOk = true;
let plansOk = true;
for (const r of rows) {
  if (!Array.isArray(r.farm_steps) || r.farm_steps.length < 3 || r.farm_steps.length > 12) stepsOk = false;
  if (r.farm_steps.length !== 8) stepsOk = false;
  let gas = 0;
  let mins = 0;
  for (const s of r.farm_steps) {
    const t = s.trim();
    if (t.length < 20 || t.length > 600) stepsOk = false;
    const m = TAIL.exec(t);
    if (m === null) stepsOk = false;
    else { gas += Number(m[1]); mins += Number(m[2]); }
  }
  if (r.plan.gas_usd !== gas || r.plan.minutes_total !== mins) plansOk = false;
  if (r.plan.weeks !== Math.ceil(r.plan.hold_days / 7) || r.plan.minutes_per_week !== Math.round(r.plan.minutes_total / r.plan.weeks)) plansOk = false;
}
check('farm steps', stepsOk, 'every row carries exactly 8 steps (gate range 3..12), each 20..600 chars with the [cost $X | Y min] tail');
check('plan totals', plansOk, 'each plan\'s gas_usd and minutes_total equal the sums of its 8 step tails');

// ---- no network anywhere in program or dashboard ----------------------------
const NET_PATTERNS = ['http://', 'https://', 'fetch(', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'node:http', 'node:https', 'net.connect'];
function scanDir(dir, acc) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) scanDir(p, acc);
    else acc.push(p);
  }
  return acc;
}
const programFiles = [join(root, 'main.ts'), ...scanDir(join(root, 'lib'), []), ...scanDir(join(root, 'dashboard'), [])];
const offenders = [];
for (const f of programFiles) {
  const text = readFileSync(f, 'utf8');
  for (const pat of NET_PATTERNS) if (text.includes(pat)) offenders.push(`${f}: ${pat}`);
}
check('no network', offenders.length === 0, offenders.length === 0 ? `no network pattern in ${programFiles.length} program + dashboard files` : offenders.join('; '));

// ---- dashboard files ----------------------------------------------------------
const dashDir = join(root, 'dashboard');
const dashFiles = readdirSync(dashDir).filter((n) => statSync(join(dashDir, n)).isFile()).sort();
const dashBytes = dashFiles.reduce((sum, n) => sum + statSync(join(dashDir, n)).size, 0);
check(
  'dashboard files',
  dashFiles.length === 3 && dashFiles.includes('index.html') && dashFiles.some((n) => n.endsWith('.css')) && dashFiles.some((n) => n.endsWith('.js')) && dashBytes <= 4_194_304,
  `${dashFiles.length} files (${dashFiles.join(', ')}), ${dashBytes} bytes total (gate cap 400 files / 4 MiB)`,
);

// ---- screenshots ----------------------------------------------------------------
const shotDir = join(root, 'screenshots');
const shotNames = readdirSync(shotDir).filter((n) => !n.startsWith('.')).sort();
let shotsOk = shotNames.length === 3;
let shotDetail = '';
for (const n of shotNames) {
  const bytes = readFileSync(join(shotDir, n));
  const isPng = bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50;
  const w = isPng ? bytes.readUInt32BE(16) : 0;
  const h = isPng ? bytes.readUInt32BE(20) : 0;
  if (!isPng || w !== 1440 || h !== 900 || bytes.length > 524_288) shotsOk = false;
  shotDetail += `${n} ${w}x${h} ${bytes.length}B; `;
}
check('screenshots', shotsOk, `3 images, each a 1440x900 PNG of at most 512 KiB — ${shotDetail.trim()}`);

// ---- dossier ----------------------------------------------------------------------
const dossierBytes = readOut(outA, 'dossier.json');
const dossier = JSON.parse(dossierBytes.toString('utf8'));
const textBytes = Buffer.byteLength(dossier.text, 'utf8');
check('dossier size', dossierBytes.length <= 1_572_864 && textBytes <= 65_536, `dossier ${dossierBytes.length} bytes (cap 1.5 MiB), text ${textBytes} bytes / ${dossier.text.length} chars (cap 65,536)`);

const rebuilt = buildDossier(outA, { text_max_bytes: 65_536, screenshots: { max: 4, max_bytes: 524_288 }, dashboard: { max_files: 400, max_bytes: 4_194_304 } });
check('dossier rebuild', Buffer.from(rebuilt).equals(dossierBytes), 'buildDossier(output) reproduces dossier.json byte for byte');

// ---- determinism --------------------------------------------------------------------
const sameBoard = readOut(outA, 'board.json').equals(readOut(outB, 'board.json'));
const sameData = readOut(outA, 'data.js').equals(readOut(outB, 'data.js'));
const sameDossier = readOut(outA, 'dossier.json').equals(readOut(outB, 'dossier.json'));
check('determinism', sameBoard && sameData && sameDossier, `two consecutive runs byte-identical (board.json ${sameBoard}, data.js ${sameData}, dossier.json ${sameDossier})`);

// ---- report ---------------------------------------------------------------------------
for (const line of results) process.stdout.write(`${line}\n`);
if (failures > 0) {
  process.stdout.write(`selftest: ${failures} check(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`selftest: all ${results.length} checks passed\n`);
