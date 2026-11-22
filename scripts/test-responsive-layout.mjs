import { chromium } from 'playwright-core';
import path from 'node:path';
import { execSync } from 'node:child_process';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';
const CHROME_PATH = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ARTIFACT_DIR = process.env.ARTIFACT_DIR || 'C:\\Users\\Lenov\\.gemini\\antigravity\\brain\\42ef4afd-5a60-473e-924d-fe16f14a3323';

function getSetupCodeFromDocker() {
  try {
    const logs = execSync('docker logs freellmapi-keys-debug', { encoding: 'utf-8' });
    const match = logs.match(/First-run setup code:\s*([A-Z0-9]+)/);
    if (match) return match[1];
  } catch (e) {}
  return undefined;
}

async function obtainAuthToken(url) {
  try {
    const loginRes = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'password123' }),
    });
    const loginData = await loginRes.json();
    if (loginData?.token) return loginData.token;
  } catch (e) {}

  try {
    const setupCode = getSetupCodeFromDocker();
    const setupRes = await fetch(`${url}/api/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'password123', setupCode }),
    });
    const setupData = await setupRes.json();
    return setupData?.token;
  } catch (e) {}

  return null;
}

const VIEWPORTS = [
  { name: 'desktop-wide-1920', width: 1920, height: 1080 },
  { name: 'desktop-1440', width: 1440, height: 900 },
  { name: 'laptop-1024', width: 1024, height: 768 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'mobile-375', width: 375, height: 812 },
];

async function run() {
  console.log(`[Responsive Test] Launching Chrome...`);
  const token = await obtainAuthToken(BASE_URL);
  console.log(`[Responsive Test] Auth token obtained:`, !!token);

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
      if (token) {
        await page.addInitScript((authToken) => {
          window.localStorage.setItem('freellmapi_dashboard_token', authToken);
        }, token);
      }

      // Test Keys Page
      console.log(`[${vp.name}] Navigating to /keys...`);
      await page.goto(`${BASE_URL}/keys`, { waitUntil: 'networkidle' });
      const keysScrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      const keysClientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      console.log(`[${vp.name}] /keys scrollWidth=${keysScrollWidth}px, clientWidth=${keysClientWidth}px`);
      if (keysScrollWidth > keysClientWidth) {
        throw new Error(`[${vp.name}] Horizontal overflow on /keys: scrollWidth (${keysScrollWidth}) > clientWidth (${keysClientWidth})`);
      }
      const keysScreenshot = path.join(ARTIFACT_DIR, `playwright-responsive-${vp.name}-keys.png`);
      await page.screenshot({ path: keysScreenshot, fullPage: true });

      // Test Benchmarks Page
      console.log(`[${vp.name}] Navigating to /benchmarks...`);
      await page.goto(`${BASE_URL}/benchmarks`, { waitUntil: 'networkidle' });
      const benchScrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      const benchClientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      console.log(`[${vp.name}] /benchmarks scrollWidth=${benchScrollWidth}px, clientWidth=${benchClientWidth}px`);
      if (benchScrollWidth > benchClientWidth) {
        throw new Error(`[${vp.name}] Horizontal overflow on /benchmarks: scrollWidth (${benchScrollWidth}) > clientWidth (${benchClientWidth})`);
      }

      // Measure main container width
      const mainBox = await page.locator('main').boundingBox();
      console.log(`[${vp.name}] <main> dimensions: width=${mainBox?.width}px, height=${mainBox?.height}px`);

      if (vp.width === 1920) {
        // On 1920px, it should be responsive up to max-w-[1600px]
        if (!mainBox || mainBox.width <= 1160) {
          throw new Error(`Expected responsive wide container (>1160px) on 1920px screen, got: ${mainBox?.width}px`);
        }
        console.log(`[${vp.name}] Verified wide container expands beyond legacy 1152px! (Actual: ${mainBox.width}px)`);
      }

      const benchScreenshot = path.join(ARTIFACT_DIR, `playwright-responsive-${vp.name}-benchmarks.png`);
      await page.screenshot({ path: benchScreenshot, fullPage: false });

      // Test Models Chat Page
      console.log(`[${vp.name}] Navigating to /models/chat...`);
      await page.goto(`${BASE_URL}/models/chat`, { waitUntil: 'networkidle' });
      const modelsScrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      const modelsClientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      if (modelsScrollWidth > modelsClientWidth) {
        throw new Error(`[${vp.name}] Horizontal overflow on /models/chat: scrollWidth (${modelsScrollWidth}) > clientWidth (${modelsClientWidth})`);
      }
      const fallbackScreenshot = path.join(ARTIFACT_DIR, `playwright-responsive-${vp.name}-models.png`);
      await page.screenshot({ path: fallbackScreenshot, fullPage: false });

      console.log(`[${vp.name}] All pages passed responsiveness checks!`);
      await context.close();
    }

    console.log(`\n======================================================`);
    console.log(`[Responsive Test] ALL SCREEN SIZES & PAGES TESTED SUCCESSFULLY!`);
    console.log(`======================================================\n`);
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error(`[Responsive Test] Failed:`, err);
  process.exit(1);
});
