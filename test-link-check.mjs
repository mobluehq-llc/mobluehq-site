import { chromium } from '/Users/adamfaust/products/blueAlibi/apps/web/node_modules/playwright/index.mjs';

const pages = [
  'portfolio/blueparity.html',
  'portfolio/bluepipeline.html',
  'portfolio/bluealibi.html',
  'portfolio/blueintent.html',
  'portfolio/bluefloor.html'
];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  let allPassed = true;
  const brokenLinks = [];

  for (const pageFile of pages) {
    console.log(`\nChecking links on: ${pageFile}`);
    
    try {
      await page.goto(`http://localhost:3000/${pageFile}`);
      
      // Get all links on the page
      const links = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a[href]'))
          .map(a => ({ text: a.textContent.trim(), href: a.getAttribute('href') }))
          .filter(l => l.href); // Filter out empty hrefs
      });
      
      // Check each link
      for (const link of links) {
        const href = link.href;
        
        // Skip external links and mailto/tel/hash only
        if (href.startsWith('http') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('#')) {
          continue;
        }
        
        // Check if internal link exists
        try {
          const response = await page.goto(`http://localhost:3000${href}`, { waitUntil: 'domcontentloaded', timeout: 3000 });
          if (!response.ok()) {
            console.log(`  FAIL: ${href} (${response.status()})`);
            brokenLinks.push({ page: pageFile, link: href, status: response.status() });
            allPassed = false;
          } else {
            console.log(`  OK: ${href}`);
          }
        } catch (error) {
          console.log(`  ERROR: ${href} - ${error.message}`);
          brokenLinks.push({ page: pageFile, link: href, error: error.message });
          allPassed = false;
        }
      }
    } catch (error) {
      console.error(`Error loading ${pageFile}:`, error.message);
      allPassed = false;
    }
  }

  await browser.close();
  
  console.log(`\n=== SUMMARY ===`);
  if (allPassed) {
    console.log('All links are valid');
  } else {
    console.log(`Found ${brokenLinks.length} broken links`);
    brokenLinks.forEach(l => {
      console.log(`  - ${l.link} on ${l.page}: ${l.status || l.error}`);
    });
  }
  
  process.exit(allPassed ? 0 : 1);
})();
