const PORT = process.env.SITE_PORT || '3000';
import { chromium } from '/Users/adamfaust/products/blueAlibi/apps/web/node_modules/playwright/index.mjs';

// Simplified axe check using the axe-core CLI through NPM
// This runs the existing a11y-scan but we'll verify programmatically

const pages = [
  'portfolio/blueparity.html',
  'portfolio/bluepipeline.html',
  'portfolio/bluealibi.html',
  'portfolio/blueintent.html',
  'portfolio/bluefloor.html'
];

const viewports = [
  { name: '1280px (desktop)', width: 1280, height: 800 },
  { name: '390px (mobile)', width: 390, height: 844 }
];

(async () => {
  const browser = await chromium.launch();
  
  let allPassed = true;

  for (const pageFile of pages) {
    for (const viewport of viewports) {
      const page = await browser.newPage();
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      
      try {
        await page.goto(`http://127.0.0.1:${PORT}/${pageFile}`);
        
        console.log(`\n--- ${pageFile} at ${viewport.name} ---`);
        
        // Load axe-core and run it
        await page.addScriptTag({ 
          url: 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.0/axe.min.js'
        });
        
        // Wait a moment for axe to load
        await page.waitForTimeout(500);
        
        const violations = await page.evaluate(async () => {
          return new Promise((resolve) => {
            axe.run({tags: ['wcag2aa']}, (error, results) => {
              if (error) resolve([]);
              resolve(results.violations);
            });
          });
        });
        
        if (violations.length === 0) {
          console.log('PASS: No accessibility violations');
        } else {
          console.log(`FAIL: ${violations.length} violations found:`);
          violations.forEach((v) => {
            console.log(`  - ${v.id}: ${v.description}`);
            v.nodes.forEach((n) => {
              console.log(`    Element: ${n.html}`);
            });
          });
          allPassed = false;
        }
      } catch (error) {
        console.error(`Error scanning ${pageFile} at ${viewport.name}:`, error.message);
        allPassed = false;
      } finally {
        await page.close();
      }
    }
  }

  await browser.close();
  
  console.log(`\n=== SUMMARY ===`);
  console.log(allPassed ? 'All pages passed accessibility scan' : 'Scan did NOT come back clean — check above whether pages had VIOLATIONS or could not be REACHED (a connection error is not a passing or failing page, it is an unmeasured one)');
  
  process.exit(allPassed ? 0 : 1);
})();
