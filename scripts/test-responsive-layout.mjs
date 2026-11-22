import { chromium } from 'playwright-core';
import path from 'node:path';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';
const CHROME_PATH = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ARTIFACT_DIR = process.env.ARTIFACT_DIR || 'C:\\Users\\Lenov\\.gemini\\antigravity\\brain\\42ef4afd-5a60-473e-924d-fe16f14a3323';

const VIEWPORTS = [
  { name: 'desktop-wide-1920', width: 1920, height: 1080 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'mobile-375', width: 375, height: 812 },
];

async function run() {
  console.log(`[Responsive Test] Launching Chrome...`);
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
  });

  try {
    for (const vp of VIEWPORTS) {
      console.log(`\n--- Testing Viewport: ${vp.name} (${vp.width}x${vp.height}) ---`);
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
      });
      const page = await context.newPage();

      // Test Benchmarks Page
      console.log(`[${vp.name}] Navigating to /benchmarks...`);
      await page.goto(`${BASE_URL}/benchmarks`, { waitUntil: 'networkidle' });

      // Measure main container width
      const mainBox = await page.locator('main').boundingBox();
      console.log(`[${vp.name}] <main> dimensions: width=${mainBox?.width}px, height=${mainBox?.height}px`);

      if (vp.width === 1920) {
        // On 1920px, it should be significantly wider than the old 1152px fixed limit
        if (!mainBox || mainBox.width <= 1160) {
          throw new Error(`Expected responsive wide container (>1160px) on 1920px screen, got: ${mainBox?.width}px`);
        }
        console.log(`[${vp.name}] Verified wide container expands beyond legacy 1152px! (Actual: ${mainBox.width}px)`);
      }

      // Check for horizontal document scrollbar on mobile
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      console.log(`[${vp.name}] Document scrollWidth=${scrollWidth}px, clientWidth=${clientWidth}px`);
      if (scrollWidth > clientWidth + 5) {
        console.warn(`[${vp.name}] Warning: Potential page horizontal overflow: scrollWidth (${scrollWidth}) > clientWidth (${clientWidth})`);
      } else {
        console.log(`[${vp.name}] Clean responsiveness: No page-level horizontal overflow!`);
      }

      const screenshotFile = path.join(ARTIFACT_DIR, `playwright-responsive-${vp.name}-benchmarks.png`);
      await page.screenshot({ path: screenshotFile, fullPage: false });
      console.log(`[${vp.name}] Saved screenshot: ${screenshotFile}`);

      // Test Fallback / Models page
      console.log(`[${vp.name}] Navigating to /models/chat...`);
      await page.goto(`${BASE_URL}/models/chat`, { waitUntil: 'networkidle' });
      const fallbackScreenshot = path.join(ARTIFACT_DIR, `playwright-responsive-${vp.name}-models.png`);
      await page.screenshot({ path: fallbackScreenshot, fullPage: false });
      console.log(`[${vp.name}] Saved screenshot: ${fallbackScreenshot}`);

      await context.close();
    }

    console.log(`\n======================================================`);
    console.log(`[Responsive Test] ALL SCREEN SIZES TESTED SUCCESSFULLY!`);
    console.log(`======================================================\n`);
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error(`[Responsive Test] Failed:`, err);
  process.exit(1);
});
