# Ongoing Maintenance & Upstream Rebase Guide

This guide documents how to keep this customized fork (**PiyushDixit96/freellmapi**) synchronized with the official upstream repository (**tashfeenahmed/freellmapi**) without breaking custom features.

It is written for both **developers** and **AI assistants** (e.g. Antigravity, Claude Code, Cursor, Copilot) to execute cleanly and reliably.

---

## 1. Architecture & Remote Configuration

### Repository Roles
* **`upstream`**: The original public repository (`https://github.com/tashfeenahmed/freellmapi.git`)
* **`origin`**: Your personal GitHub fork (`https://github.com/PiyushDixit96/freellmapi.git`)
* **Active Branch**: `main` (contains your production-ready features: model benchmarking system, leaderboard, autopilot micro-benchmarking, benchmark routing strategy, responsive layout, and optimized docker stack)

### Verify Remotes
Run:
```bash
git remote -v
```
Expected output:
```text
origin    https://github.com/PiyushDixit96/freellmapi.git (fetch)
origin    https://github.com/PiyushDixit96/freellmapi.git (push)
upstream  https://github.com/tashfeenahmed/freellmapi.git (fetch)
upstream  https://github.com/tashfeenahmed/freellmapi.git (push)
```

If `upstream` is missing:
```bash
git remote add upstream https://github.com/tashfeenahmed/freellmapi.git
```

---

## 2. Standard Upstream Sync Workflow (Step-by-Step)

Always use **`git rebase`** rather than `git merge`. Rebase replays custom benchmark commits cleanly on top of the newest upstream releases without polluting Git history with merge commits.

### Step 1: Ensure Working Tree is Clean
```bash
git status
# If you have uncommitted work in progress, stash it:
git stash
```

### Step 2: Fetch Latest Upstream Changes
```bash
git fetch upstream main
```

### Step 3: Rebase on Upstream
```bash
git checkout main
git rebase upstream/main
```

### Step 4: Handle Conflicts (if any)
See [Section 4: Resolving Conflicts](#4-resolving-conflicts) below.

### Step 5: Run Verification Suite
Always verify before pushing (see [Section 3](#3-verification-suite)).

### Step 6: Push to Your Fork
Because the Git commit history is rebased on top of new upstream commits, use `--force-with-lease`:
```bash
git push origin main --force-with-lease
```

---

## 3. Verification Suite

After any rebase or dependency change, execute the following validation commands in order:

```powershell
# 1. Install any new dependencies added upstream:
npm install

# 2. Verify database migrations (order & roundtrip safety):
npm run test:migrations -w server

# 3. Run Benchmark Service unit tests:
npm test -w server -- src/__tests__/services/benchmark-service.test.ts

# 4. Verify translation key parity across all 60 languages:
npm run check:i18n -w client

# 5. Typecheck & build the client frontend:
npm run build -w client
```

All 5 steps must pass with `0` errors.

---

## 4. Resolving Conflicts (Known Touchpoints)

The benchmarking feature is highly modular. Most code lives in standalone files:
* `server/src/routes/benchmarks.ts`
* `server/src/services/benchmark-service.ts`
* `server/src/services/benchmark-runner.ts`
* `server/src/db/migrations/20261123_000001_model_benchmarks.ts`
* `client/src/pages/BenchmarksPage.tsx`
* `scripts/test-benchmarks-e2e.mjs`

Only **5 integration touchpoints** exist where merge conflicts could theoretically occur:

### 1. `server/src/app.ts`
* **Custom Code**: Benchmark routes mount:
  ```ts
  import { benchmarkRouter } from './routes/benchmarks.js';
  // ...
  app.use('/api/benchmarks', benchmarkRouter);
  ```
* **Resolution**: Keep all upstream middleware and route imports, and ensure `/api/benchmarks` remains mounted alongside other API routers.

### 2. `server/src/db/migrate/defaults.ts` & `roundtrip.test.ts`
* **Custom Code**: Migration registration:
  ```ts
  import m20261123_000001 from './20261123_000001_model_benchmarks.js';
  // ...
  m20261123_000001,
  ```
* **Resolution**: If upstream added new migrations with earlier timestamps, ensure `m20261123_000001` is placed in chronological order by filename timestamp. Keep both upstream migrations and this benchmark migration registered.

### 3. `client/src/App.tsx`
* **Custom Code**: Navigation item and page route:
  ```tsx
  import BenchmarksPage from '@/pages/BenchmarksPage'
  // analyticsItems array:
  { to: '/benchmarks', labelKey: 'nav.benchmarks' },
  // Routes:
  <Route path="/benchmarks" element={<BenchmarksPage />} />
  ```
* **Resolution**: Retain upstream route changes and keep the `/benchmarks` route and navigation link intact.

### 4. `client/src/pages/ModelDetailPage.tsx`
* **Custom Code**: Query hook and the dedicated "Model Benchmarks & Performance" card section.
* **Resolution**: Keep upstream layout adjustments while retaining the benchmark query and JSX block.

### 5. `client/src/i18n/locales/*.json`
* **Custom Code**: `"nav.benchmarks": "Benchmarks"` across all 60 language locale files.
* **Resolution**: If upstream added new keys or modified translation files, ensure `"nav.benchmarks"` remains present in all 60 files. Run `npm run check:i18n -w client` to identify any missing keys automatically.

### Finishing Conflict Resolution
```bash
# Stage resolved files:
git add <resolved-file-path>

# Continue rebase:
git rebase --continue

# In case of emergency / to abort cleanly without changes:
git rebase --abort
```

---

## 5. Docker Build & Playwright E2E Verification

To verify that the full production container builds and tests cleanly:

### 1. Build the Docker Image
```bash
docker build -t freellmapi:latest .
```

### 2. Run Test Container
```bash
docker run -d --name freellmapi-maint-test -p 3001:3001 \
  -e ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 \
  -e DEV_MODE=true freellmapi:latest
```

### 3. Run Playwright E2E Tests
```bash
node scripts/test-benchmarks-e2e.mjs
```
The script will:
* Check container ping & complete one-time setup code authorization.
* Test `/benchmarks` (table rows, KPI metrics, search filter, modality tabs).
* Test single model detail view `/models/chat/gemini-2.5-flash`.
* Save visual screenshots to artifacts.

### 4. Clean Up Test Container
```bash
docker stop freellmapi-maint-test && docker rm freellmapi-maint-test
```

---

## 6. Prompt Template for AI Assistants

When instructing an AI assistant (Antigravity, Claude, Copilot, etc.) to perform an update, you can paste this exact prompt:

```text
Please read MAINTENANCE.md in this repository and execute an upstream rebase:
1. Fetch latest commits from upstream/main.
2. Rebase feat/model-benchmarks onto upstream/main.
3. Resolve any conflicts in app.ts, App.tsx, defaults.ts, ModelDetailPage.tsx, or i18n locales.
4. Run all verification steps:
   - npm install
   - npm run test:migrations -w server
   - npm test -w server -- src/__tests__/services/benchmark-service.test.ts
   - npm run check:i18n -w client
   - npm run build -w client
5. Push the rebased branch to origin/feat/model-benchmarks using --force-with-lease.
```
