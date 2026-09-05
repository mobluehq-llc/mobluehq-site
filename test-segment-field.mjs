import { chromium } from '/Users/adamfaust/products/blueAlibi/apps/web/node_modules/playwright/index.mjs';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    // Load the contact page with segment=blueparity
    await page.goto('http://localhost:3000/contact.html?segment=blueparity');
    
    // Wait for the form to load (wait for visible form element)
    await page.waitForSelector('#contactForm');
    
    // Get the value of the hidden field
    const segmentValue = await page.inputValue('#leadSegment');
    
    console.log(`Test: Contact page with segment=blueparity`);
    console.log(`Expected: blueparity`);
    console.log(`Actual: "${segmentValue}"`);
    
    if (segmentValue === 'blueparity') {
      console.log('PASS: Segment value correctly set');
      process.exit(0);
    } else {
      console.log('FAIL: Segment value not set correctly');
      process.exit(1);
    }
  } catch (error) {
    console.error('Test error:', error.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
