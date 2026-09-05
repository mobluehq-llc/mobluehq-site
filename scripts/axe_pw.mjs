#!/usr/bin/env node

import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const baseUrl = 'http://127.0.0.1:8210';
const pages = [
  '/portfolio.html',
  '/portfolio/bluealibi.html',
  '/portfolio/bluefloor.html',
  '/portfolio/blueintent.html',
  '/portfolio/blueparity.html',
  '/portfolio/bluepipeline.html'
];

const axeCorePath = path.resolve(import.meta.url.replace('file://', ''), '../../node_modules/axe-core/axe.min.js');
const axeCore = fs.readFileSync(axeCorePath, 'utf-8');

async function runAxeCheck() {
  const browser = await chromium.launch();
  let totalViolations = 0;
  const results = [];

  for (const page of pages) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const pageHandle = await context.newPage();

    try {
      await pageHandle.goto(`${baseUrl}${page}`);
      await pageHandle.addInitScript(axeCore);

      const violations = await pageHandle.evaluate(async () => {
        return new Promise((resolve) => {
          window.axe.run(
            {
              runOnly: {
                type: 'tag',
                values: ['wcag2a', 'wcag2aa']
              }
            },
            (error, results) => {
              if (error) {
                resolve({ page: window.location.pathname, error: error.message });
              } else {
                resolve({
                  page: window.location.pathname,
                  violations: results.violations.length,
                  details: results.violations
                });
              }
            }
          );
        });
      });

      results.push(violations);
      totalViolations += violations.violations || 0;
      console.log(`${page}: ${violations.violations || 0} violations`);
    } catch (error) {
      console.error(`Error checking ${page}: ${error.message}`);
      results.push({ page, error: error.message });
    } finally {
      await context.close();
    }
  }

  await browser.close();

  console.log(`\n=== Summary ===`);
  console.log(`Total violations across all pages: ${totalViolations}`);

  if (totalViolations > 0) {
    console.log('\n=== Violation Details ===');
    results.forEach(result => {
      if (result.violations > 0) {
        console.log(`\n${result.page}:`);
        result.details.forEach(violation => {
          console.log(`  - ${violation.id}: ${violation.impact} (${violation.nodes.length} nodes)`);
        });
      }
    });
    process.exit(1);
  } else {
    console.log('✓ All pages pass accessibility checks');
    process.exit(0);
  }
}

runAxeCheck().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
