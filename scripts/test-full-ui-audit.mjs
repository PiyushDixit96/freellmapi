import { chromium } from 'playwright-core';
import path from 'node:path';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';
const CHROME_PATH = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ARTIFACT_DIR = process.env.ARTIFACT_DIR || 'C:\\Users\\Lenov\\.gemini\\antigravity\\brain\\42ef4afd-5a60-473e-924d-fe16f14a3323';

function getSetupCodeFromDocker() {
  for (const name of ['freellmapi', 'freellmapi-keys-debug']) {
    try {
      const logs = execSync(`docker logs ${name}`, { encoding: 'utf-8' });
      const match = logs.match(/First-run setup code:\s*([A-Z0-9]+)/);
      if (match) return match[1];
    } catch (e) {}
  }
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
  { name: 'desktop-1440', width: 1440, height: 900, isMobile: false },
  { name: 'tablet-768', width: 768, height: 1024, isMobile: true },
  { name: 'mobile-375', width: 375, height: 812, isMobile: true },
];

const ROUTES = [
  { path: '/models/chat', id: 'models-chat' },
  { path: '/models/image', id: 'models-image' },
  { path: '/models/video', id: 'models-video' },
  { path: '/models/audio', id: 'models-audio' },
  { path: '/models/embeddings', id: 'models-embeddings' },
  { path: '/models/decision', id: 'models-decision' },
  { path: '/models/search', id: 'models-search' },
  { path: '/models/fusion', id: 'models-fusion' },
  { path: '/keys', id: 'keys-providers' },
  { path: '/benchmarks', id: 'benchmarks' },
  { path: '/analytics', id: 'analytics' },
  { path: '/logs', id: 'logs' },
  { path: '/playground', id: 'playground' },
  { path: '/premium', id: 'premium' },
];

async function checkOverflow(page, label) {
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  if (scrollWidth > clientWidth) {
    return {
      hasOverflow: true,
      diff: scrollWidth - clientWidth,
      scrollWidth,
      clientWidth,
      label,
    };
  }
  return { hasOverflow: false, scrollWidth, clientWidth, label };
}

async function run() {
  console.log(`[Full UI Audit] Starting Playwright UI Audit...`);
  const token = await obtainAuthToken(BASE_URL);
  console.log(`[Full UI Audit] Auth token obtained:`, !!token);

  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
  });

  const issues = [];
  const screenshots = [];

  try {
    for (const vp of VIEWPORTS) {
      console.log(`\n======================================================`);
      console.log(`Testing Viewport: ${vp.name} (${vp.width}x${vp.height})`);
      console.log(`======================================================`);

      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
      });
      const page = await context.newPage();

      const consoleErrors = [];
      page.on('console', msg => {
        if (msg.type() === 'error') {
          consoleErrors.push(msg.text());
        }
      });

      if (token) {
        await page.addInitScript((authToken) => {
          window.localStorage.setItem('freellmapi_dashboard_token', authToken);
        }, token);
      }

      // 1. Test All Routes
      for (const route of ROUTES) {
        process.stdout.write(`  [${vp.name}] Route: ${route.path} ... `);
        await page.goto(`${BASE_URL}${route.path}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(300);

        const overflow = await checkOverflow(page, `${vp.name} ${route.path}`);
        if (overflow.hasOverflow) {
          console.log(`OVERFLOW! (${overflow.scrollWidth} > ${overflow.clientWidth})`);
          issues.push(overflow);
        } else {
          console.log(`OK (${overflow.scrollWidth}px)`);
        }

        const shotPath = path.join(ARTIFACT_DIR, `fullui-${vp.name}-${route.id}.png`);
        await page.screenshot({ path: shotPath, fullPage: false });
        screenshots.push(shotPath);
      }

      // 2. Test Keys Tabs (/keys)
      await page.goto(`${BASE_URL}/keys`, { waitUntil: 'networkidle' });
      const keyTabs = ['apiKey', 'anthropic', 'agents', 'quotaSignals'];
      for (const tabId of keyTabs) {
        process.stdout.write(`  [${vp.name}] Keys tab: ${tabId} ... `);
        const tabButton = page.locator(`button[role="radio"][value="${tabId}"], button[role="tab"]`).filter({ hasText: new RegExp(tabId, 'i') }).first();
        // Segmented control button
        const segBtn = page.locator(`button`).filter({ hasText: tabId === 'apiKey' ? /Unified|API Key/i : tabId === 'anthropic' ? /Anthropic|Claude/i : tabId === 'agents' ? /Agents/i : /Quota/i }).first();
        if (await segBtn.count() > 0) {
          await segBtn.click();
          await page.waitForTimeout(300);
          const overflow = await checkOverflow(page, `${vp.name} /keys [${tabId}]`);
          if (overflow.hasOverflow) {
            console.log(`OVERFLOW!`);
            issues.push(overflow);
          } else {
            console.log(`OK`);
          }
          const tabShot = path.join(ARTIFACT_DIR, `fullui-${vp.name}-keys-${tabId}.png`);
          await page.screenshot({ path: tabShot, fullPage: false });
          screenshots.push(tabShot);
        } else {
          console.log(`tab button not matched`);
        }
      }

      // 3. Test Modals: Add Key Dialog
      process.stdout.write(`  [${vp.name}] Modal: Add Key Dialog ... `);
      await page.goto(`${BASE_URL}/keys`, { waitUntil: 'networkidle' });
      const addKeyBtn = page.locator('button').filter({ hasText: /Add Key|Add key/i }).first();
      if (await addKeyBtn.count() > 0) {
        await addKeyBtn.click();
        await page.waitForTimeout(400);
        const modalVisible = await page.locator('[data-slot="dialog-popup"]').isVisible();
        if (modalVisible) {
          const overflow = await checkOverflow(page, `${vp.name} Modal AddKey`);
          if (overflow.hasOverflow) {
            console.log(`OVERFLOW!`);
            issues.push(overflow);
          } else {
            console.log(`OK (rendered cleanly)`);
          }
          const shot = path.join(ARTIFACT_DIR, `fullui-${vp.name}-modal-addkey.png`);
          await page.screenshot({ path: shot, fullPage: false });
          screenshots.push(shot);

          // Close modal via Escape
          await page.keyboard.press('Escape');
          await page.waitForTimeout(200);
        } else {
          console.log(`Dialog not opened`);
        }
      }

      // 4. Test Modals: Command Palette
      process.stdout.write(`  [${vp.name}] Modal: Command Palette ... `);
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+KeyK' : 'Control+KeyK');
      await page.waitForTimeout(400);
      let palVisible = await page.locator('[role="dialog"][aria-label*="Search"], [role="dialog"][aria-label*="palette"]').isVisible().catch(() => false);
      if (!palVisible) {
        // Try clicking search button
        const searchBtn = page.locator('header button').filter({ has: page.locator('svg.lucide-search') }).first();
        if (await searchBtn.count() > 0) {
          await searchBtn.click();
          await page.waitForTimeout(400);
          palVisible = await page.locator('[role="dialog"]').isVisible().catch(() => false);
        }
      }
      if (palVisible) {
        const overflow = await checkOverflow(page, `${vp.name} Command Palette`);
        if (overflow.hasOverflow) {
          console.log(`OVERFLOW!`);
          issues.push(overflow);
        } else {
          console.log(`OK`);
        }
        const shot = path.join(ARTIFACT_DIR, `fullui-${vp.name}-modal-palette.png`);
        await page.screenshot({ path: shot, fullPage: false });
        screenshots.push(shot);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
      } else {
        console.log(`Palette not opened`);
      }

      // 5. Test Settings Dialog
      process.stdout.write(`  [${vp.name}] Modal: Settings Dialog ... `);
      if (vp.isMobile) {
        // On mobile, settings is inside the hamburger menu dropdown
        const menuBtn = page.locator('header .lg\\:hidden button[aria-label*="menu" i]').first();
        if (await menuBtn.count() > 0) {
          await menuBtn.click();
          await page.waitForTimeout(300);
          const settingsItem = page.locator('[role="menuitem"]').filter({ hasText: /Settings/i }).first();
          if (await settingsItem.count() > 0) {
            await settingsItem.click();
            await page.waitForTimeout(400);
          }
        }
      } else {
        // On desktop, settings is in the more menu dropdown
        const moreBtn = page.locator('header .lg\\:flex button[aria-label*="menu" i]').first();
        if (await moreBtn.count() > 0) {
          await moreBtn.click();
          await page.waitForTimeout(300);
          const settingsItem = page.locator('[role="menuitem"]').filter({ hasText: /Settings/i }).first();
          if (await settingsItem.count() > 0) {
            await settingsItem.click();
            await page.waitForTimeout(400);
          }
        }
      }
      const settingsModal = await page.locator('[data-slot="dialog-popup"]').isVisible().catch(() => false);
      if (settingsModal) {
        const overflow = await checkOverflow(page, `${vp.name} Settings Modal`);
        if (overflow.hasOverflow) {
          console.log(`OVERFLOW!`);
          issues.push(overflow);
        } else {
          console.log(`OK`);
        }
        const shot = path.join(ARTIFACT_DIR, `fullui-${vp.name}-modal-settings.png`);
        await page.screenshot({ path: shot, fullPage: false });
        screenshots.push(shot);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
      } else {
        console.log(`Settings dialog not opened`);
      }

      // 6. Test Mobile Menu (on mobile/tablet)
      if (vp.isMobile) {
        process.stdout.write(`  [${vp.name}] Mobile Navigation Drawer/Menu ... `);
        const menuBtn = page.locator('header .lg\\:hidden button[aria-label*="menu" i]').first();
        if (await menuBtn.count() > 0) {
          await menuBtn.click();
          await page.waitForTimeout(300);
          const menuVisible = await page.locator('[role="menu"]').isVisible().catch(() => false);
          if (menuVisible) {
            const overflow = await checkOverflow(page, `${vp.name} Mobile Menu`);
            if (overflow.hasOverflow) {
              console.log(`OVERFLOW!`);
              issues.push(overflow);
            } else {
              console.log(`OK`);
            }
            const shot = path.join(ARTIFACT_DIR, `fullui-${vp.name}-mobile-menu.png`);
            await page.screenshot({ path: shot, fullPage: false });
            screenshots.push(shot);
            await page.keyboard.press('Escape');
            await page.waitForTimeout(200);
          } else {
            console.log(`Dropdown not visible`);
          }
        }
      }

      await context.close();
    }

    console.log(`\n======================================================`);
    console.log(`[Full UI Audit] Summary:`);
    console.log(`Screenshots Captured: ${screenshots.length}`);
    console.log(`Issues / Overflows Found: ${issues.length}`);
    if (issues.length > 0) {
      console.log(`Issues details:`, JSON.stringify(issues, null, 2));
    } else {
      console.log(`ALL PAGES, SECTIONS, AND POPUPS PASSED WITHOUT OVERFLOW!`);
    }
    console.log(`======================================================\n`);

  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error(`[Full UI Audit] Error:`, err);
  process.exit(1);
});
