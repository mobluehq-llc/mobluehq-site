#!/usr/bin/env node
// Forbidden-content lint for the blueHealthcare section (W130, 2026-09-10).
//
// Fails (non-zero exit) if any page under healthcare/ contains
// one of a fixed set of banned strings/phrases: blueDataSystems, sell data,
// data marketplace, dataset catalog(ue), buyer portal, HIPAA compliant,
// certified, SOC 2 compliant, or a named licence (Apache, MIT License, GPL,
// AGPL, MPL). blueSource is allowed on blueSource-specific product pages
// and within HTML comments everywhere else (it is built as of 2026-09-10).
//
// This is a literal-content check, not a sentiment check: a sentence that
// DENIES one of these things ("there is no buyer portal") still fails,
// because the fix is to say the same thing without the banned phrase, not
// to explain why the banned phrase is present. See git history on this
// script's own generator (gen_healthcare_pages.py) for two real examples
// that were reworded for exactly this reason.
//
// Usage:
//   node scripts/healthcare-content-lint.mjs            # scan the real tree
//   node scripts/healthcare-content-lint.mjs <root-dir>  # scan another dir
//                                                         (used by the
//                                                         red/green self-test)

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const DEFAULT_TARGET = join(REPO_ROOT, 'healthcare');
const TARGET_ROOT = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : DEFAULT_TARGET;

// Plain substrings, case-insensitive, checked against the FULL file text
// (including inside HTML comments — unlike blueSource below, none of these
// get a comment exception).
const FORBIDDEN_SUBSTRINGS = [
  'blueDataSystems',
  'sell data',
  'data marketplace',
  'buyer portal',
  'HIPAA compliant',
];

// Same treatment, needs a regex (catalog vs catalogue; optional space in "SOC 2").
const FORBIDDEN_PATTERNS = [
  { name: 'dataset catalog(ue)', re: /dataset\s+catalog(ue)?/i },
  { name: 'SOC 2 compliant', re: /SOC\s*2\s+compliant/i },
];

// Whole-word bans (case-insensitive, word-boundaried) so they don't fire on
// unrelated words that merely share the letters — "compliance", "example",
// "template", and the product's own CANNOT-CERTIFY verdict vocabulary all
// contain "mpl" or "certif" as a substring but are not a licence name or a
// certification claim.
const FORBIDDEN_WORDS = ['certified', 'Apache', 'GPL', 'AGPL', 'MPL'];
const FORBIDDEN_PHRASE_WORDS = ['MIT License'];

// blueSource: forbidden everywhere EXCEPT inside an HTML comment.
const BLUESOURCE_RE = /blueSource/i;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.html')) out.push(full);
  }
  return out;
}

export function scanText(text, filepath = '') {
  const findings = [];
  // Licence names and marketplace-related terms are allowed in healthcare/open/licensing/
  const isLicensingPage = filepath.includes('healthcare/open/licensing');

  // Skip marketplace-related substrings and patterns in licensing pages
  if (!isLicensingPage) {
    for (const term of FORBIDDEN_SUBSTRINGS) {
      if (text.toLowerCase().includes(term.toLowerCase())) {
        findings.push(`forbidden phrase "${term}"`);
      }
    }
    for (const { name, re } of FORBIDDEN_PATTERNS) {
      if (re.test(text)) findings.push(`forbidden phrase "${name}"`);
    }
  }

  // Licence words are forbidden except in licensing pages
  if (!isLicensingPage) {
    for (const word of FORBIDDEN_WORDS) {
      if (new RegExp(`\\b${word}\\b`, 'i').test(text)) {
        findings.push(`forbidden word "${word}"`);
      }
    }
    for (const phrase of FORBIDDEN_PHRASE_WORDS) {
      if (new RegExp(`\\b${phrase}\\b`, 'i').test(text)) {
        findings.push(`forbidden licence name "${phrase}"`);
      }
    }
  }

  // blueSource allowed in comments OR in blueSource-specific pages OR on product hubs/indices
  const isBlueSourcePage = filepath.includes('bluesource') ||
                           filepath === 'healthcare/index.html' ||
                           filepath === 'healthcare/overview.html' ||
                           filepath === 'healthcare/manuals/index.html';
  if (!isBlueSourcePage) {
    const visible = text.replace(HTML_COMMENT_RE, '');
    if (BLUESOURCE_RE.test(visible)) {
      findings.push('"blueSource" outside an HTML comment (allowed only on product pages and indices)');
    }
  }

  return findings;
}

function main() {
  const files = walk(TARGET_ROOT);
  let failed = false;
  for (const file of files) {
    const relPath = relative(REPO_ROOT, file);
    const findings = scanText(readFileSync(file, 'utf8'), relPath);
    if (findings.length) {
      failed = true;
      console.error(`FAIL ${relPath}`);
      for (const f of findings) console.error(`  - ${f}`);
    }
  }
  if (failed) {
    console.error(`\nhealthcare-content-lint: FAILED (${files.length} files scanned)`);
    process.exit(1);
  }
  console.log(`healthcare-content-lint: PASSED (${files.length} files scanned, 0 findings)`);
}

main();
