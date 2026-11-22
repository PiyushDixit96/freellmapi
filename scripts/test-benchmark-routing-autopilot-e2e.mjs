import { chromium } from 'playwright-core';
import path from 'node:path';
import { execSync } from 'node:child_process';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';
const CHROME_PATH = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ARTIFACT_DIR = process.env.ARTIFACT_DIR || 'C:\\Users\\Lenov\\.gemini\\antigravity\\brain\\42ef4afd-5a60-473e-924d-fe16f14a3323';

function getSetupCodeFromDocker() {
  try {
    const logs = execSync('docker logs freellmapi-e2e-deep', { encoding: 'utf-8' });
    const match = logs.match(/First-run setup code:\s*([A-Z0-9]+)/);
    if (match) {
      console.log(`[E2E] Found setup code from docker logs: ${match[1]}`);
      return match[1];
    }
  } catch (e) {
    // If running outside docker, ignore
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
      // retry
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
    console.log(`[E2E] Performing initial setup...`);
    const setupCode = getSetupCodeFromDocker();
    const setupRes = await fetch(`${url}/api/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'password123', setupCode }),
    });
    const setupData = await setupRes.json();
    if (!setupRes.ok) {
      throw new Error(`Setup failed: ${JSON.stringify(setupData)}`);
    }
    console.log(`[E2E] Setup completed!`);
    return setupData.token;
  }

  // Login
  console.log(`[E2E] Logging in...`);
  const loginRes = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'password123' }),
  });
  const loginData = await loginRes.json();
  if (loginRes.ok && loginData.token) {
    console.log(`[E2E] Login successful!`);
    return loginData.token;
  }
  return null;
}

async function ensureProviderKey(url, token) {
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
        key: 'AIzaSyTestKeyForBenchmarkAutopilotDeepVerification123',
        label: 'E2E Google Key',
      }),
    });
    console.log(`[E2E] Key creation response status: ${res.status}`);
  } catch (err) {
    console.warn(`[E2E] Key warning:`, err.message);
  }
}

async function run() {
  await waitForServer(BASE_URL);
  const token = await obtainAuthToken(BASE_URL);
  if (token) {
    await ensureProviderKey(BASE_URL, token);
  }

  // 1. Verify Autopilot REST Endpoints
  console.log(`\n--- [E2E Step 1] Verifying Autopilot REST Endpoints ---`);
  const autopilotStatusRes = await fetch(`${BASE_URL}/api/benchmarks/autopilot/status`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const autopilotStatus = await autopilotStatusRes.json();
  console.log(`[E2E] Autopilot Status:`, autopilotStatus);
  if (typeof autopilotStatus.enabled !== 'boolean') {
    throw new Error('Invalid autopilot status response');
  }

  console.log(`[E2E] Triggering manual autopilot pass...`);
  const triggerRes = await fetch(`${BASE_URL}/api/benchmarks/autopilot/trigger`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const triggerData = await triggerRes.json();
  console.log(`[E2E] Autopilot Trigger Result:`, triggerData);

  // 2. Verify Benchmark-Driven Routing Strategy REST Endpoints
  console.log(`\n--- [E2E Step 2] Verifying Benchmark-Driven Routing REST Endpoint ---`);
  const putRoutingRes = await fetch(`${BASE_URL}/api/fallback/routing`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ strategy: 'benchmark' }),
  });
  const putRoutingData = await putRoutingRes.json();
  console.log(`[E2E] PUT /api/fallback/routing:`, putRoutingData);
  if (putRoutingData.strategy !== 'benchmark') {
    throw new Error(`Expected strategy 'benchmark', received: ${putRoutingData.strategy}`);
  }

  const getRoutingRes = await fetch(`${BASE_URL}/api/fallback/routing`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const getRoutingData = await getRoutingRes.json();
  console.log(`[E2E] GET /api/fallback/routing active strategy:`, getRoutingData.strategy);
  console.log(`[E2E] Active weights:`, getRoutingData.weights);
  if (getRoutingData.strategy !== 'benchmark') {
    throw new Error('GET /api/fallback/routing did not return benchmark strategy');
  }

  // 3. Playwright Deep Browser Journeys
  console.log(`\n--- [E2E Step 3] Launching Chrome via Playwright ---`);
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1366, height: 850 },
    });
    const page = await context.newPage();

    if (token) {
      await page.addInitScript((authToken) => {
        window.localStorage.setItem('freellmapi_dashboard_token', authToken);
      }, token);
    }

    // A. Verify Models Page with "Benchmark-Driven" Strategy Pill
    console.log(`[E2E Browser] Navigating to ${BASE_URL}/models/chat...`);
    await page.goto(`${BASE_URL}/models/chat`, { waitUntil: 'networkidle' });

    // Look for the "Benchmark-Driven" strategy pill
    const benchmarkPill = page.locator('button:has-text("Benchmark-Driven")');
    await benchmarkPill.waitFor({ state: 'visible', timeout: 10000 });
    console.log(`[E2E Browser] "Benchmark-Driven" strategy pill is visible!`);

    // Click the pill to activate benchmark strategy
    await benchmarkPill.click();
    await page.waitForTimeout(1000);

    const isPillActive = await benchmarkPill.evaluate(el => el.classList.contains('bg-foreground'));
    console.log(`[E2E Browser] Benchmark-Driven pill active state: ${isPillActive}`);
    if (!isPillActive) {
      throw new Error(`Expected benchmark pill to have 'bg-foreground' active class`);
    }

    const fallbackScreenshot = path.join(ARTIFACT_DIR, 'playwright-benchmark-routing-strategy.png');
    await page.screenshot({ path: fallbackScreenshot, fullPage: true });
    console.log(`[E2E Browser] Saved screenshot: ${fallbackScreenshot}`);

    // B. Verify Benchmarks Leaderboard with Autopilot Banner and Trigger
    console.log(`[E2E Browser] Navigating to ${BASE_URL}/benchmarks...`);
    await page.goto(`${BASE_URL}/benchmarks`, { waitUntil: 'networkidle' });

    const h1 = await page.textContent('h1');
    console.log(`[E2E Browser] Leaderboard Heading: "${h1?.trim()}"`);

    // Verify Autopilot banner is rendered
    await page.waitForSelector('text=Autopilot Micro-Benchmarking', { timeout: 10000 });
    console.log(`[E2E Browser] Autopilot Micro-Benchmarking banner is visible!`);

    // Verify Autopilot button in header
    const autopilotBtn = page.locator('button:has-text("Autopilot")');
    await autopilotBtn.waitFor({ state: 'visible', timeout: 5000 });
    console.log(`[E2E Browser] Autopilot header button is visible! Clicking it...`);
    await autopilotBtn.click();
    await page.waitForTimeout(1500);

    const benchmarksScreenshot = path.join(ARTIFACT_DIR, 'playwright-autopilot-leaderboard.png');
    await page.screenshot({ path: benchmarksScreenshot, fullPage: true });
    console.log(`[E2E Browser] Saved screenshot: ${benchmarksScreenshot}`);

    // C. Verify Single Model Benchmark Card
    console.log(`[E2E Browser] Navigating to single model page (/models/chat/gemini-2.5-flash)...`);
    await page.goto(`${BASE_URL}/models/chat/gemini-2.5-flash`, { waitUntil: 'networkidle' });

    await page.waitForSelector('text=Model Benchmarks & Performance', { timeout: 10000 });
    console.log(`[E2E Browser] Model Benchmarks & Performance section is visible!`);

    const detailScreenshot = path.join(ARTIFACT_DIR, 'playwright-model-detail-deep.png');
    await page.screenshot({ path: detailScreenshot, fullPage: true });
    console.log(`[E2E Browser] Saved screenshot: ${detailScreenshot}`);

    console.log(`\n======================================================`);
    console.log(`[E2E DEEP] ALL TESTS (BENCHMARK ROUTING & AUTOPILOT) PASSED!`);
    console.log(`======================================================\n`);
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error(`[E2E DEEP] Test execution failed:`, err);
  process.exit(1);
});
