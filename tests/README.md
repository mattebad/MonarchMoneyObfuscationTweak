# Developer docs: tests + CI

The root `README.md` is intended for end-user installation/usage. This document covers **developer-facing** testing and CI.

## Snapshot-based DOM regression tests (fast, no secrets)
These tests load the committed HTML snapshots under `../Route DOMs/` using JSDOM, execute the userscript in a deterministic **test mode**, and assert:
- At least one value is wrapped/masked per route snapshot
- Masking can be toggled back to original
- SVG/chart text is not modified
- Sidebar toggle injection still works on the captured sidebar DOM

### Run locally

```bash
cd MonarchMoneyObfuscationTweak
npm install
npm test
```

## Catching upstream Monarch DOM changes
CI can only detect upstream Monarch DOM changes if CI can either:
- run against **fresh snapshots**, or
- run against **live Monarch**.

This repo ships two optional CI jobs (see `../.gitlab-ci.yml`):
- `live_smoke`: logs into Monarch and verifies the userscript masks/unmasks on real pages.
- `snapshot_refresh`: logs into Monarch, refreshes `Route DOMs/*.html`, and fails if the refreshed HTML differs from what’s committed.

### Verifying storageState vs the GraphQL Authorization header
Playwright `storageState` does **not** store HTTP request headers. The app typically derives the GraphQL `Authorization` header at runtime using cookies/localStorage.

To validate that your `storageState` is sufficient, you can run the live smoke test and require that at least one GraphQL request includes an `Authorization` header (it only reports presence/scheme, not the token value):

```bash
cd MonarchMoneyObfuscationTweak
MONARCH_STORAGE_STATE_PATH=monarch.storageState.json MONARCH_VERIFY_GRAPHQL_AUTH=1 npm run live:smoke
```

## Auth for CI (Sign in with Apple)
Even if you use “Sign in with Apple”, the most reliable automation input is a **Playwright storageState** (cookies + localStorage) captured after you log in once.

### 1) Generate a storageState locally

```bash
cd MonarchMoneyObfuscationTweak
npm install
npm run auth:export
```

This opens a browser window. Log in to `https://app.monarch.com/`, then press Enter in the terminal. It writes `monarch.storageState.json` (ignored by git).

### 2) Add it to GitLab as a CI variable
- **Variable name**: `MONARCH_STORAGE_STATE_B64`
- **Value**: base64 of `monarch.storageState.json`

Example (macOS):

```bash
base64 -i monarch.storageState.json | pbcopy
```

### 3) Create GitLab schedules
Create a scheduled pipeline on `main` that runs:
- `live_smoke` (detects functional breakage on live pages)
- `snapshot_refresh` (detects DOM drift by comparing refreshed snapshots to committed snapshots)

## Troubleshooting Playwright on new macOS versions
If Playwright’s bundled Chromium crashes immediately:
- Upgrade Playwright (newer versions bundle newer browser builds):

```bash
cd MonarchMoneyObfuscationTweak
npm install -D playwright@latest
npx playwright install chromium
```


