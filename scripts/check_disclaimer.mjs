#!/usr/bin/env node
/**
 * FALSIFIER: the approved AI / user-responsibility disclaimer must appear in
 * the footer of EVERY served page, and must link to a legal page that exists.
 *
 * Approved text: canon/BUILD_CONTROL/GTM_MASTER/LEGAL/DRAFT_AI_USER_DISCLAIMER_090926.md
 * SHORT FORM ONLY. Adam approved it 2026-09-09. The LONG FORM must NOT ship —
 * its section 8 still contains a literal "[COUNSEL: ...]" placeholder and its
 * governing-law clause is undrafted.
 *
 * Also enforces the recorded entity-name trap: the entity is "MOBLUEHQ, Inc." —
 * never "MOBLUEHQ LLC", and never the "Inc.." double period a prior blanket
 * sweep introduced into 582 files. (The GitHub org slug `mobluehq-llc` is a
 * name, not a claim, and is not checked here.)
 *
 * Verifies by the ARTIFACT: it reads the bytes that Vercel serves (this site
 * has no build step — outputDirectory is "." — so the tracked .html file IS
 * the served page), and resolves every disclaimer link against the filesystem
 * under Vercel's `cleanUrls: true` rule.
 *
 * Usage:  node scripts/check_disclaimer.mjs [siteRoot]
 * Exit 0 = all pages pass. Exit 1 = at least one page fails (details printed).
 */
import { readFile, readdir, access } from 'node:fs/promises';
import { join, relative, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root =
  process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..');

// Untracked/local-only trees are never deployed; a stale mockup under one of
// these must not be able to turn this gate red (or green).
const EXCLUDE_DIRS = new Set([
  'node_modules',
  '.git',
  '.worktrees',
  '.vercel',
  'mobluehq-site-design-intake'
]);

// Partials are fragments included at author time, not served pages.
const EXCLUDE_FILES = new Set(['partials/_head_meta.html']);

/** The link every footer disclaimer must point at. */
const LEGAL_HREF = '/disclaimers';

/**
 * Load-bearing sentences of the APPROVED SHORT FORM, verbatim. Checked as
 * separate substrings so markup may wrap them, but the substance may not be
 * reworded. Text is compared against the page with tags stripped.
 */
const REQUIRED_SENTENCES = [
  'AI-generated. Verify before you rely on it.',
  'blueMonster produces machine-generated hypotheses using large language models.',
  'LLMs make mistakes, including confident ones',
  'they can state figures, sources, mechanisms and institutions that do not exist.',
  'MOBLUEHQ, Inc. designs this system to disclose how each result was produced and to refuse rather than guess where it can, but',
  'no such system is free of error',
  'This output is not a prior-art search, a patentability opinion, or professional advice of any kind.',
  'You are responsible for independently verifying the accuracy, novelty, and legal status of any mechanism, claim, or product before relying on it, publishing it, filing on it, or commercialising it.'
];

/**
 * Adam's original phrasing, deliberately NOT shipped: it is an unfalsifiable
 * claim about our own effort and a plaintiff reads it as a promise. The
 * approved text states what the system does and refuses to do instead.
 */
const FORBIDDEN_PHRASES = [
  'as honest as it can be',
  'MOBLUEHQ LLC',
  'MOBLUEHQ, LLC',
  'Inc..'
];

/** Fragments unique to the LONG FORM, which must never reach a served page. */
const LONG_FORM_MARKERS = ['[COUNSEL:', 'COUNSEL: cap amount'];

async function collectPages(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (EXCLUDE_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collectPages(full)));
    else if (entry.isFile() && extname(entry.name) === '.html') out.push(full);
  }
  return out;
}

/** Strip tags and decode the few entities this site actually uses. */
function textOf(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&mdash;/g, '—')
    .replace(/&#8212;/g, '—')
    .replace(/\s+/g, ' ')
    .trim();
}

function footerOf(html) {
  const start = html.lastIndexOf('<footer');
  if (start === -1) return null;
  const end = html.indexOf('</footer>', start);
  if (end === -1) return null;
  return html.slice(start, end + '</footer>'.length);
}

/** Vercel cleanUrls: /disclaimers is served from ./disclaimers.html */
async function linkResolves(href) {
  const clean = href.split('#')[0].split('?')[0].replace(/^\//, '');
  const candidates = [
    join(root, `${clean}.html`),
    join(root, clean, 'index.html'),
    join(root, clean)
  ];
  for (const c of candidates) {
    try {
      await access(c);
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

const failures = [];
const pages = (await collectPages(root))
  .map((p) => relative(root, p))
  .filter((p) => !EXCLUDE_FILES.has(p))
  .sort();

if (pages.length === 0) {
  console.error(`FAIL: no .html pages found under ${root} — the gate cannot measure.`);
  process.exit(1);
}

for (const page of pages) {
  const html = await readFile(join(root, page), 'utf8');
  const fail = (msg) => failures.push(`${page}: ${msg}`);

  const footer = footerOf(html);
  if (!footer) {
    fail('no <footer> element — cannot carry the site-wide disclaimer');
    continue;
  }
  const footerText = textOf(footer);

  for (const sentence of REQUIRED_SENTENCES) {
    if (!footerText.includes(sentence)) {
      fail(`footer is missing approved short-form text: "${sentence.slice(0, 60)}..."`);
    }
  }

  if (!new RegExp(`href="${LEGAL_HREF}(?:[#?][^"]*)?"`).test(footer)) {
    fail(`footer disclaimer does not link to ${LEGAL_HREF}`);
  } else if (!(await linkResolves(LEGAL_HREF))) {
    fail(`footer links to ${LEGAL_HREF} but no file serves that path`);
  }

  const wholeText = textOf(html);
  for (const phrase of FORBIDDEN_PHRASES) {
    if (wholeText.includes(phrase) || html.includes(phrase)) {
      fail(`forbidden phrase present on the page: "${phrase}"`);
    }
  }
  for (const marker of LONG_FORM_MARKERS) {
    if (html.includes(marker)) {
      fail(`LONG FORM placeholder leaked onto a served page: "${marker}"`);
    }
  }
}

console.log(`Checked ${pages.length} served pages under ${root}`);
for (const page of pages) console.log(`  - ${page}`);

if (failures.length) {
  console.error(`\nFAIL: ${failures.length} problem(s):`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('\nPASS: every served page carries the approved disclaimer and a resolving legal link.');
