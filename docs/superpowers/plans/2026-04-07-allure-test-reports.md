# Allure 3 Test Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish Allure 3 test reports to GitHub Pages with the last 10 runs preserved as navigable snapshots.

**Architecture:** Bun's built-in JUnit reporter (`--reporter=junit`) writes XML results. Allure 3 reads JUnit XML natively. The `GuitaristForEver/allure-v3-report-action` generates the report with history and deploys to gh-pages at `/reports/allure`.

**Tech Stack:** Bun (JUnit reporter), Allure 3, GitHub Actions, GitHub Pages

---

## File Map

### New files

| File | Responsibility |
|------|---------------|
| `.github/workflows/test-reports.yml` | CI: run tests with JUnit output, generate Allure report, deploy to gh-pages |

### Modified files

| File | Changes |
|------|---------|
| `.gitignore` | Add `allure-results/` and `allure-report/` |

---

### Task 1: Update `.gitignore`

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Add allure directories to `.gitignore`**

Add these lines to the end of `.gitignore`:

```
allure-results/
allure-report/
```

- [ ] **Step 2: Commit**

```bash
git add .gitignore
git commit -m "chore: add allure directories to gitignore"
```

---

### Task 2: Create test reports workflow

**Files:**
- Create: `.github/workflows/test-reports.yml`

- [ ] **Step 1: Create `.github/workflows/test-reports.yml`**

```yaml
name: Test Reports

on:
  push:
    branches: [main]

permissions:
  contents: write

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  test-report:
    runs-on: macos-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
        with:
          lfs: true

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Cache bun dependencies
        uses: actions/cache@v4
        with:
          path: ~/.bun/install/cache
          key: ${{ runner.os }}-bun-${{ hashFiles('bun.lock') }}
          restore-keys: ${{ runner.os }}-bun-

      - name: Cache parakeet CoreML backend
        uses: actions/cache@v4
        with:
          path: |
            ~/.cache/parakeet/coreml
            ~/Library/Caches/FluidAudio
          key: ${{ runner.os }}-parakeet-coreml-v3
          restore-keys: ${{ runner.os }}-parakeet-coreml-

      - run: bun install

      - name: Install parakeet backend
        run: bun run src/cli.ts install

      - name: Install ffmpeg
        run: which ffmpeg || brew install ffmpeg

      - name: Run tests with JUnit reporter
        run: bun test --reporter=junit --reporter-outfile=allure-results/junit.xml
        continue-on-error: true

      - name: Load test report history
        uses: actions/checkout@v4
        if: always()
        continue-on-error: true
        with:
          ref: gh-pages
          path: gh-pages

      - name: Build test report
        uses: GuitaristForEver/allure-v3-report-action@v0
        if: always()
        with:
          allure_results: allure-results
          allure_report: allure-report
          allure_history: allure-history
          gh_pages: gh-pages
          subfolder: reports/allure
          keep_reports: 10
          report_name: "Parakeet CLI Tests"

      - name: Publish test report
        uses: peaceiris/actions-gh-pages@v4
        if: always()
        with:
          github_token: ${{ github.token }}
          publish_branch: gh-pages
          publish_dir: allure-history
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/test-reports.yml
git commit -m "ci: add Allure 3 test reports workflow with gh-pages deployment"
```

---

### Task 3: Enable GitHub Pages

This is a manual step — not code.

- [ ] **Step 1: Enable GitHub Pages on the repo**

Go to https://github.com/drakulavich/parakeet-cli/settings/pages:
- Source: "Deploy from a branch"
- Branch: `gh-pages`
- Folder: `/ (root)`
- Click Save

If gh-pages branch doesn't exist yet, the first workflow run will create it.

---

### Task 4: Verify the workflow

- [ ] **Step 1: Push to main and verify the workflow triggers**

```bash
git push origin main
```

Watch the workflow: `gh run list --workflow=test-reports.yml`

- [ ] **Step 2: Verify the report is accessible**

After the workflow completes, check: `https://drakulavich.github.io/parakeet-cli/reports/allure`

- [ ] **Step 3: Verify history works on second run**

Push another commit to main (any docs change). After the second workflow completes, verify the report shows a trend chart with 2 data points, and snapshot `/reports/allure/1` and `/reports/allure/2` are both accessible.
