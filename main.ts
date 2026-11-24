// Launch Radar (radar-3): the entrypoint.
//
// Reads the sealed snapshot (default /input/snapshot.json, or --input <file|dir> when run
// locally), runs the both-tests term search, scores every rankable pre-token protocol with
// the surviving model, and writes the ranked board, the dashboard's data, the dashboard,
// the screenshots and the dossier:
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|directory>
//
// The program runs twice in grading and both runs must write identical bytes: nothing here
// reads the clock, the environment or a random source; every date comes from the snapshot's
// own as_of. Node 22, standard library only, no network.
//
// The model lives in one plain-JavaScript file, dashboard/fit.js, so the exact same code
// runs here and in the browser (where it refits the surviving model live from the embedded
// snapshot). The term search lives in lib/termsearch.js and runs only at build time; the
// browser never runs it. lib/model.ts from the previous version is gone on purpose: keeping
// a second copy of the model would let the two drift.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { buildDossier } from './vendor/makefun-board.ts';

const require = createRequire(import.meta.url);
const fit = require('./dashboard/fit.js') as {
  boardIssue: (board: unknown, snapshot: unknown) => string | null;
  buildRadar: (snapshot: unknown, search: unknown, settings?: unknown) => { board: unknown[]; radar: Record<string, unknown> };
  dataScript: (radar: unknown) => string;
  parseSnapshot: (text: string) => { protocols: unknown[]; watchlist: unknown[] };
};
const termsearch = require('./lib/termsearch.js') as {
  searchTerms: (snapshot: unknown) => Record<string, unknown>;
};

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps: the text cap shapes the dossier's bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const DASHBOARD_CAPS = { max_files: 400, max_bytes: 4_194_304 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** The value of `--name <value>` or `--name=<value>`, else the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(
    `token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`,
  );
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = fit.parseSnapshot(readFileSync(inputFile, 'utf8'));
const search = termsearch.searchTerms(snapshot);
const { board, radar } = fit.buildRadar(snapshot, search);
const issue = fit.boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), fit.dataScript(radar));

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

const dashFiles = copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3 || shots.length > 4) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} images: hand in 3 or 4, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: DASHBOARD_CAPS }),
);

const counts = radar.counts as { board: number; farm: number; marginal: number; pricedComps: number; oddsRows: number };
process.stdout.write(
  `launch radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ` +
    `${counts.board} rows scored (${counts.farm} FARM, ${counts.marginal} MARGINAL at the default settings)\n` +
    `launch radar: value model keeps [${(search.valueKept as string[]).join(', ') || 'none'}], ` +
    `odds model keeps [${(search.oddsKept as string[]).join(', ') || 'none'}]; ` +
    `${counts.pricedComps} priced comps, ${counts.oddsRows} dated protocols\n` +
    `launch radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (${dashFiles.length} files), ` +
    `${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
