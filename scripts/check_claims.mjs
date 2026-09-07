#!/usr/bin/env node
/**
 * Claims gate: scan every .html file and data/products.json for banned marketing
 * vocabulary (case-insensitive, word-boundary aware). Any hit must be listed in
 * scripts/claims_allowlist.json, and every allowlist entry must name the
 * CLAIMS_REGISTER row that proves the claim is safe to make.
 *
 * See ~/dev/canon/BUILD_CONTROL/GTM_MASTER/CLAIMS_REGISTER.md for the register.
 *
 * Usage: node scripts/check_claims.mjs
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');

const EXCLUDE_DIRS = new Set(['node_modules', '.git', '.worktrees', '.vercel']);

// Banned vocabulary, case-insensitive. Each entry is either a plain string
// (word-boundary matched on BOTH sides — an exact word or phrase) or a
// `{ term, prefix: true }` object (word-boundary anchored at the START of
// the word only, so it catches the whole word family: donat -> donate,
// donates, donation, donating, donator).
//
// Stemming, not enumeration: rather than listing every inflected form of a
// word one at a time (which silently misses forms nobody thought to add —
// e.g. "donate" itself was missing while "donates"/"donation" were listed),
// a `prefix` entry matches the shared stem and everything built on it.
const BANNED_TERMS = [
  { term: 'novel', prefix: true }, // novel, novels, novelty, novelties
  'undiscovered',
  'patentable',
  'verified finding',
  { term: 'verbatim', prefix: true },
  { term: 'donat', prefix: true }, // donate, donates, donation, donating, donator
  { term: 'automatically escalat', prefix: true }, // escalate/escalates/escalating/escalation
  { term: 'provab', prefix: true }, // provable, provably, provability
  { term: 'guarante', prefix: true }, // guarantee, guarantees, guaranteed, guarantor
  'council',
  'consensus',
  'dissent',
  'unanimous',
  'panel of',
  'independently verified',
  'anchored'
];

function termToRegex(entry) {
  const term = typeof entry === 'string' ? entry : entry.term;
  const isPrefix = typeof entry === 'object' && entry.prefix === true;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rightBoundary = isPrefix ? '' : '\\b';
  return new RegExp(`\\b${escaped}${rightBoundary}`, 'i');
}

const TERM_PATTERNS = BANNED_TERMS.map((entry) => ({
  term: typeof entry === 'string' ? entry : entry.term,
  re: termToRegex(entry)
}));

async function collectTargetFiles(dir) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (EXCLUDE_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectTargetFiles(full)));
    } else if (entry.isFile() && extname(entry.name) === '.html') {
      out.push(full);
    }
  }
  return out;
}

async function loadAllowlist() {
  const path = join(root, 'scripts', 'claims_allowlist.json');
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error('claims_allowlist.json must be a JSON array');
    }
    for (const entry of parsed) {
      for (const field of ['file', 'line_contains', 'reason', 'register_row']) {
        if (typeof entry[field] !== 'string' || entry[field].length === 0) {
          throw new Error(
            `claims_allowlist.json entry missing required non-empty string field "${field}": ${JSON.stringify(entry)}`
          );
        }
      }
    }
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

function isAllowlisted(allowlist, relPath, lineText) {
  return allowlist.find(
    (entry) => entry.file === relPath && lineText.includes(entry.line_contains)
  );
}

async function scanFile(absPath) {
  const relPath = relative(root, absPath).split('\\').join('/');
  const text = await readFile(absPath, 'utf8');
  const lines = text.split('\n');
  const hits = [];
  lines.forEach((lineText, idx) => {
    for (const { term, re } of TERM_PATTERNS) {
      if (re.test(lineText)) {
        hits.push({ file: relPath, line: idx + 1, term, lineText: lineText.trim() });
      }
    }
  });
  return hits;
}

async function main() {
  const htmlFiles = await collectTargetFiles(root);
  const productsJson = join(root, 'data', 'products.json');
  const targets = [...htmlFiles];
  try {
    await readFile(productsJson, 'utf8');
    targets.push(productsJson);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const allowlist = await loadAllowlist();

  let allHits = [];
  for (const file of targets) {
    allHits = allHits.concat(await scanFile(file));
  }

  if (allHits.length === 0) {
    console.log('Claims gate: scanned', targets.length, 'files (.html + data/products.json). No banned terms found.');
    process.exit(0);
  }

  let unallowed = 0;
  console.log(`Claims gate: scanned ${targets.length} files, found ${allHits.length} hit(s).\n`);
  for (const hit of allHits) {
    const allow = isAllowlisted(allowlist, hit.file, hit.lineText);
    const tag = allow ? 'ALLOWED' : 'VIOLATION';
    if (!allow) unallowed += 1;
    console.log(`[${tag}] ${hit.file}:${hit.line}  term="${hit.term}"`);
    console.log(`    ${hit.lineText}`);
    if (allow) {
      console.log(`    allowlisted: ${allow.reason} (register row ${allow.register_row})`);
    }
    console.log('');
  }

  if (unallowed > 0) {
    console.error(
      `FAIL: ${unallowed} banned-term hit(s) are not in scripts/claims_allowlist.json.\n` +
      `Either remove the claim, or add an allowlist entry that names the CLAIMS_REGISTER row proving it.`
    );
    process.exit(1);
  }

  console.log(`PASS: all ${allHits.length} hit(s) are allowlisted with a register row.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Claims gate crashed:', err);
  process.exit(2);
});
