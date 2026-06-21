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

### GitHub Actions PR permission (snapshot refresh)
If you use the GitHub Actions workflow `../.github/workflows/snapshot-refresh.yml`, the job can open a PR with refreshed snapshots.

If the run fails with **“GitHub Actions is not permitted to create or approve pull requests”**, enable it in:
- Repo **Settings** → **Actions** → **General**
  - **Workflow permissions**: set **Read and write permissions**
  - Enable **Allow GitHub Actions to create and approve pull requests**

If you can’t enable that setting, set a fine-grained PAT as the Actions secret **`SNAPSHOT_REFRESH_PAT`** and the workflow will use that token for PR creation.

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

## Local visual review capture (privacy-safe)
Use this when you want screenshots for manual/agent visual inspection without committing images.

- Output folder (git-ignored): `../playwright-artifacts/visual-review/<timestamp>/`
- Includes `manifest.json` plus screenshots named:
  - `route__navMode__state__viewport__checkpoint.png`

### Run locally

```bash
cd MonarchMoneyObfuscationTweak
MONARCH_STORAGE_STATE_PATH=monarch.storageState.json npm run live:visual:capture
```

By default this runs **fast profile**:
- states: `on`
- nav modes: `direct,reload`
- checkpoints: `top,bottom`
- viewport screenshots (not full-page)

Use full profile when you need exhaustive capture:

```bash
MONARCH_STORAGE_STATE_PATH=monarch.storageState.json \
MONARCH_VISUAL_PROFILE=full \
npm run live:visual:capture
```

### Optional filters (faster iteration)

```bash
# Single route + viewport
MONARCH_STORAGE_STATE_PATH=monarch.storageState.json \
MONARCH_VISUAL_ROUTES=dashboard \
MONARCH_VISUAL_VIEWPORTS=desktop \
npm run live:visual:capture

# States: on,off (fast default is on)
MONARCH_STORAGE_STATE_PATH=monarch.storageState.json \
MONARCH_VISUAL_STATES=on \
npm run live:visual:capture
```

```bash
# Optional advanced tuning
MONARCH_STORAGE_STATE_PATH=monarch.storageState.json \
MONARCH_VISUAL_NAV_MODES=direct,spa,reload \
MONARCH_VISUAL_CHECKPOINTS=top,mid,bottom \
MONARCH_VISUAL_CONTENT_READY_TIMEOUT_MS=9000 \
MONARCH_VISUAL_FULL_PAGE=1 \
npm run live:visual:capture
```

### Privacy guardrails
- Do not commit files from `playwright-artifacts/`.
- ON-state captures are obfuscated; OFF-state captures can expose real account data.
- Prefer reviewing OFF-state screenshots locally only.

### Visual review checklist
- Obfuscation ON masks values across each supported route.
- Obfuscation OFF restores original values.
- Scroll updates still mask/unmask newly visible rows/cards.
- Hard reload and sidebar nav transitions keep behavior consistent.
- Sidebar toggle stays visible and positioned correctly at each viewport.


