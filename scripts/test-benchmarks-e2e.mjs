import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';
const CHROME_PATH = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ARTIFACT_DIR = process.env.ARTIFACT_DIR || 'C:\\Users\\Lenov\\.gemini\\antigravity\\brain\\42ef4afd-5a60-473e-924d-fe16f14a3323';

function getSetupCodeFromDocker() {
  try {
    const logs = execSync('docker logs freellmapi-e2e-test', { encoding: 'utf-8' });
    const match = logs.match(/First-run setup code:\s*([A-Z0-9]+)/);
    if (match) {
      console.log(`[E2E] Found setup code from docker logs: ${match[1]}`);
      return match[1];
    }
  } catch (e) {
    console.warn(`[E2E] Could not read setup code from docker logs:`, e.message);
  }
  return undefined;
}

async function waitForServer(url, timeoutMs = 60000) {
  const start = Date.now();
  console.log(`[E2E] Waiting for server at ${url}...`);
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/api/ping`);
      if (res.ok) {
        console.log(`[E2E] Server is healthy!`);
        return true;
      }
    } catch {
      // wait and retry
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Server did not respond within ${timeoutMs}ms`);
}

async function obtainAuthToken(url) {
  console.log(`[E2E] Checking auth status...`);
  const statusRes = await fetch(`${url}/api/auth/status`);
  const status = await statusRes.json();

  if (status.needsSetup) {
    console.log(`[E2E] First run detected, performing initial setup...`);
    const setupCode = getSetupCodeFromDocker();
    const setupRes = await fetch(`${url}/api/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com', password: 'password123', setupCode }),
    });
    const setupData = await setupRes.json();
    if (!setupRes.ok) {
      throw new Error(`Setup failed: ${JSON.stringify(setupData)}`);
    }
    console.log(`[E2E] Setup completed!`);
    return setupData.token;
  }

  // Already setup, login
  console.log(`[E2E] Logging in...`);
  const loginRes = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'test@example.com', password: 'password123' }),
  });
  const loginData = await loginRes.json();
  if (loginRes.ok && loginData.token) {
    console.log(`[E2E] Login successful!`);
    return loginData.token;
  }
  return null;
}

async function ensureTestKey(url, token) {
  console.log(`[E2E] Ensuring test provider key exists...`);
  try {
    const res = await fetch(`${url}/api/keys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        platform: 'google',
        key: 'AIzaSyFakeTestKeyForE2EBenchmarkVerification123',
        label: 'E2E Google Key',
      }),
    });
    console.log(`[E2E] Key creation response status: ${res.status}`);
  } catch (err) {
    console.warn(`[E2E] Key creation warning:`, err.message);
  }
}

async function run() {
  await waitForServer(BASE_URL);
  const token = await obtainAuthToken(BASE_URL);
  if (token) {
    await ensureTestKey(BASE_URL, token);
  }

  console.log(`[E2E] Launching Chrome via Playwright...`);
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });

    const page = await context.newPage();

    // Inject token if authenticated
    if (token) {
      await page.addInitScript((authToken) => {
        window.localStorage.setItem('freellmapi_dashboard_token', authToken);
      }, token);
    }

    // 1. Test All-Models Benchmark Leaderboard Page (/benchmarks)
    console.log(`[E2E] Navigating to ${BASE_URL}/benchmarks...`);
    await page.goto(`${BASE_URL}/benchmarks`, { waitUntil: 'networkidle' });

    // Assert Page Header
    const heading = await page.textContent('h1');
    console.log(`[E2E] Page Header: "${heading?.trim()}"`);
    if (!heading?.includes('Model Benchmarks & Performance Leaderboard')) {
      throw new Error(`Unexpected page heading: ${heading}`);
    }

    // Assert Top Metric Cards
    const pageText = await page.textContent('body');
    const hasTopIntel = pageText.includes('Top Intelligence Index');
    const hasPeakSpeed = pageText.includes('Peak Output Speed');
    const hasTtfb = pageText.includes('Fastest First Token (TTFB)');
    const hasToolAccuracy = pageText.includes('Tool Calling Verified');

    console.log(`[E2E] KPI Cards Present:`, { hasTopIntel, hasPeakSpeed, hasTtfb, hasToolAccuracy });
    if (!hasTopIntel || !hasPeakSpeed || !hasTtfb || !hasToolAccuracy) {
      throw new Error('One or more KPI cards are missing on /benchmarks');
    }

    // Wait for table to load
    await page.waitForSelector('table tbody tr', { timeout: 10000 });
    const rowCount = await page.locator('table tbody tr').count();
    console.log(`[E2E] Found ${rowCount} model benchmark rows in table.`);

    // Test Search input
    const searchInput = page.locator('input[placeholder*="Search model"]');
    if (await searchInput.isVisible()) {
      console.log(`[E2E] Testing search filter for "Gemini"...`);
      await searchInput.fill('Gemini');
      await page.waitForTimeout(500);
      const filteredCount = await page.locator('table tbody tr').count();
      console.log(`[E2E] Filtered table rows: ${filteredCount}`);
      await searchInput.fill(''); // clear search
      await page.waitForTimeout(300);
    }

    // Test Tool Callers Tab
    const toolCallersTab = page.locator('button:has-text("Tool Callers")');
    if (await toolCallersTab.isVisible()) {
      console.log(`[E2E] Testing Tool Callers tab filter...`);
      await toolCallersTab.click();
      await page.waitForTimeout(500);
      const toolRows = await page.locator('table tbody tr').count();
      console.log(`[E2E] Tool callers row count: ${toolRows}`);
      await page.locator('button:has-text("All Modalities")').click();
      await page.waitForTimeout(300);
    }

    // Save screenshot of /benchmarks
    const benchmarksScreenshotPath = path.join(ARTIFACT_DIR, 'playwright-benchmarks-page.png');
    await page.screenshot({ path: benchmarksScreenshotPath, fullPage: true });
    console.log(`[E2E] Saved screenshot to ${benchmarksScreenshotPath}`);

    // 2. Test Single Model Detail Page with Benchmarks Section
    console.log(`[E2E] Navigating to single model detail page (/models/chat/gemini-2.5-flash)...`);
    await page.goto(`${BASE_URL}/models/chat/gemini-2.5-flash`, { waitUntil: 'networkidle' });

    // Verify Model Benchmarks card on single model page
    await page.waitForSelector('text=Model Benchmarks & Performance', { timeout: 10000 });
    console.log(`[E2E] Model Benchmarks & Performance card is visible!`);

    const detailText = await page.textContent('body');
    const hasQualityIndex = detailText.includes('Quality Index');
    const hasMedianTtfb = detailText.includes('Median TTFB');
    const hasThroughput = detailText.includes('Throughput');

    console.log(`[E2E] Model Detail Benchmark metrics present:`, { hasQualityIndex, hasMedianTtfb, hasThroughput });
    if (!hasQualityIndex || !hasMedianTtfb || !hasThroughput) {
      throw new Error('Key benchmark metrics missing on single model detail page');
    }

    // Save screenshot of Model Detail page
    const detailScreenshotPath = path.join(ARTIFACT_DIR, 'playwright-model-detail-benchmarks.png');
    await page.screenshot({ path: detailScreenshotPath, fullPage: true });
    console.log(`[E2E] Saved screenshot to ${detailScreenshotPath}`);

    console.log(`\n========================================`);
    console.log(`[E2E] ALL PLAYWRIGHT TESTS PASSED SUCCESSFULLY!`);
    console.log(`========================================\n`);
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error(`[E2E] Test failed:`, err);
  process.exit(1);
});
