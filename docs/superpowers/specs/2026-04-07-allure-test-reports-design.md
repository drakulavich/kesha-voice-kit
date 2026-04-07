# Allure 3 Test Reports

Add Allure 3 test reports to CI, published to GitHub Pages with the last 10 runs preserved as navigable snapshots.

## Problem

No visibility into test results beyond pass/fail in CI logs. No historical trend data to spot flaky tests or regressions across runs.

## Solution

A custom Bun test reporter writes Allure-compatible result JSON files. A GitHub Actions workflow generates Allure 3 reports and deploys them to gh-pages on every push to main.

## Architecture

```
push to main
  |
  +-- CI workflow (.github/workflows/test-reports.yml)
       |
       +-- bun test --reporter=./scripts/allure-reporter.ts
       |     writes allure-results/*.json (one file per test)
       |
       +-- GuitaristForEver/allure-v3-report-action
       |     reads allure-results/ + gh-pages history
       |     generates Allure 3 HTML report
       |     keeps last 10 snapshots
       |
       +-- peaceiris/actions-gh-pages
             deploys to gh-pages branch at /reports/allure/
```

**Report URL:** `https://drakulavich.github.io/parakeet-cli/reports/allure`

## Bun Test Reporter (`scripts/allure-reporter.ts`)

A custom Bun test reporter that hooks into bun:test lifecycle events and writes Allure-compatible result JSON to `allure-results/`.

### Allure result file format

Each test produces one file (`allure-results/{uuid}-result.json`):

```json
{
  "uuid": "a1b2c3d4-...",
  "name": "test name",
  "fullName": "suite > test name",
  "status": "passed",
  "stage": "finished",
  "start": 1712500000000,
  "stop": 1712500001000,
  "labels": [
    {"name": "suite", "value": "suite name"},
    {"name": "parentSuite", "value": "file path"},
    {"name": "framework", "value": "bun:test"}
  ],
  "statusDetails": {}
}
```

For failed tests, `status` is `"failed"` and `statusDetails` includes `message` and `trace`.

### Usage

```bash
bun test --reporter=./scripts/allure-reporter.ts
```

The reporter cleans `allure-results/` before each run to avoid stale data.

## GitHub Actions Workflow

**File:** `.github/workflows/test-reports.yml`

**Trigger:** push to main only (not PRs, not releases).

**Runner:** `macos-latest` — needed for integration tests with CoreML backend.

### Steps

1. Checkout code with LFS
2. Checkout gh-pages branch into `gh-pages/` directory (for history)
3. Setup Bun + install dependencies
4. Cache CoreML backend
5. Install parakeet backend
6. Install ffmpeg (skip if present)
7. Run tests: `bun test --reporter=./scripts/allure-reporter.ts`
8. `GuitaristForEver/allure-v3-report-action` generates report:
   - `allure_results: allure-results`
   - `gh_pages: gh-pages`
   - `allure_history: allure-history`
   - `allure_report: allure-report`
   - `subfolder: reports/allure`
   - `keep_reports: 10`
9. `peaceiris/actions-gh-pages` deploys `allure-history/` to gh-pages branch

### Permissions

```yaml
permissions:
  contents: write
```

### Concurrency

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

## gh-pages Structure

```
gh-pages branch:
└── reports/
    └── allure/
        ├── 1/              # oldest kept snapshot
        ├── 2/
        ├── ...
        ├── 10/             # newest snapshot
        ├── index.html      # latest report
        └── history/        # trend data across runs
```

The action manages snapshot rotation automatically. When the 11th report is generated, the oldest is removed.

## Files to Create

| File | Purpose |
|------|---------|
| `scripts/allure-reporter.ts` | Bun test reporter that writes Allure result JSON |
| `.github/workflows/test-reports.yml` | CI workflow: run tests, generate report, deploy to gh-pages |

## Files to Modify

None. The existing CI workflow (`ci.yml`) is unaffected — this is a separate workflow.

## Prerequisites

GitHub Pages must be enabled on the repo:
- Settings > Pages > Source: "Deploy from a branch"
- Branch: `gh-pages`, folder: `/ (root)`

## .gitignore

Add `allure-results/` and `allure-report/` to `.gitignore` so local runs don't pollute the repo.
