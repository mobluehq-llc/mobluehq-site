#!/usr/bin/env node
/**
 * axe-core WCAG 2 AA scan for static pages.
 * Usage: npm run a11y
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const port = 3459;
const pages = [
  '/',
  '/about',
  '/portfolio',
  '/portfolio-mockup',
  '/contact',
  '/investors',
  '/trust',
  '/pricing',
  '/terms',
  '/privacy'
];

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.xml': 'application/xml'
};

function resolvePath(urlPath) {
  let path = urlPath.split('?')[0];
  if (path.endsWith('/')) path += 'index.html';
  if (path === '/') path = '/index.html';
  if (!extname(path)) {
    const withHtml = path + '.html';
    return join(root, withHtml);
  }
  return join(root, path);
}

const server = createServer(async (req, res) => {
  try {
    const filePath = resolvePath(req.url || '/');
    const body = await readFile(filePath);
    const type = mime[extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
});

function runAxe(url) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'npx',
      ['@axe-core/cli', url, '--tags', 'wcag2aa', '--exit'],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], shell: true }
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      resolve({ url, code, out, err });
    });
    child.on('error', reject);
  });
}

server.listen(port, async () => {
  console.log(`Serving ${root} on http://127.0.0.1:${port}`);
  let failed = false;
  for (const page of pages) {
    const url = `http://127.0.0.1:${port}${page}`;
    console.log(`\n--- Scanning ${page} ---`);
    const result = await runAxe(url);
    process.stdout.write(result.out);
    if (result.err) process.stderr.write(result.err);
    if (result.code !== 0) {
      failed = true;
      console.error(`FAIL: ${page} (exit ${result.code})`);
    } else {
      console.log(`PASS: ${page}`);
    }
  }
  server.close();
  process.exit(failed ? 1 : 0);
});
