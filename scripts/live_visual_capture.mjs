import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const USERSCRIPT_PATH = path.join(repoRoot, 'MonarchMoneyObfuscate.user.js');

const ROUTES = [
  { key: 'dashboard', path: '/dashboard', navHref: '/dashboard' },
  { key: 'accounts', path: '/accounts', navHref: '/accounts' },
  { key: 'transactions', path: '/transactions', navHref: '/transactions' },
  { key: 'goals_savings', path: '/goals/savings', navHref: '/goals' },
  { key: 'plan', path: '/plan', navHref: '/plan' },
  { key: 'investments_holdings', path: '/investments/holdings/market', navHref: '/investments' },
];

const VIEWPORTS = [
  { key: 'desktop', width: 1440, height: 900 },
  { key: 'narrow', width: 1180, height: 760 },
];

const SCROLL_CHECKPOINTS = [
  { key: 'top', ratio: 0 },
  { key: 'mid', ratio: 0.5 },
  { key: 'bottom', ratio: 1 },
];
const NAV_MODES = ['direct', 'spa', 'reload'];
const CHECKPOINT_MAP = Object.fromEntries(SCROLL_CHECKPOINTS.map((c) => [c.key, c]));

function parseListEnv(name) {
  const raw = process.env[name];
  if (!raw) return null;
  return raw
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseProfile() {
  const raw = (process.env.MONARCH_VISUAL_PROFILE || 'fast').toLowerCase().trim();
  return raw === 'full' ? 'full' : 'fast';
}

function parseStates(profile) {
  const states = parseListEnv('MONARCH_VISUAL_STATES');
  if (!states || states.length === 0) return profile === 'full' ? ['on', 'off'] : ['on'];
  return states.filter((s) => s === 'on' || s === 'off');
}

function parseNavModes(profile) {
  const modes = parseListEnv('MONARCH_VISUAL_NAV_MODES');
  if (!modes || modes.length === 0) return profile === 'full' ? NAV_MODES : ['direct', 'reload'];
  return modes.filter((m) => NAV_MODES.includes(m));
}

function parseCheckpoints(profile) {
  const keys = parseListEnv('MONARCH_VISUAL_CHECKPOINTS');
  if (!keys || keys.length === 0) return profile === 'full' ? SCROLL_CHECKPOINTS : [CHECKPOINT_MAP.top, CHECKPOINT_MAP.bottom];
  const out = keys.map((k) => CHECKPOINT_MAP[k]).filter(Boolean);
  return out.length > 0 ? out : [CHECKPOINT_MAP.top];
}

function parseIntEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function loadStorageState() {
  const b64 = process.env.MONARCH_STORAGE_STATE_B64;
  const p = process.env.MONARCH_STORAGE_STATE_PATH;
  if (b64) {
    const json = Buffer.from(b64, 'base64').toString('utf8');
    return JSON.parse(json);
  }
  if (p) return p;
  throw new Error('Missing auth. Set MONARCH_STORAGE_STATE_B64 or MONARCH_STORAGE_STATE_PATH.');
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function tsForPath() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function toRouteUrl(routePath) {
  return `https://app.monarch.com${routePath}`;
}

async function waitForPageReady(page, expectedPath, options) {
  if (page.url().includes('/login')) {
    throw new Error(`Auth failed or expired (redirected to /login) while loading ${expectedPath || page.url()}`);
  }
  await page.waitForSelector('#root', { timeout: 35_000, state: 'attached' });
  if (options.requireNetworkIdle) {
    await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => {});
  }
  await page.waitForTimeout(options.settleMs);
  if (expectedPath && !page.url().includes(expectedPath.split('?')[0])) {
    await page.waitForTimeout(Math.max(100, Math.floor(options.settleMs / 2)));
  }
  await waitForContentReady(page, expectedPath || page.url(), options.contentReadyTimeoutMs);
}

async function waitForContentReady(page, routePath, timeoutMs) {
  await page.waitForFunction(
    ({ routePath }) => {
      const main = document.querySelector('main') || document.body;
      if (!main) return false;
      const text = (main.textContent || '').replace(/\s+/g, ' ').trim();
      const hasMtm = document.querySelectorAll('.mtm-amount').length > 0;
      const hasMoneyToken = /\$/.test(text) || /\d{1,3}(,\d{3})+\.\d{2}/.test(text);
      const hasSkeleton =
        !!main.querySelector(
          '[class*="Skeleton"],[class*="skeleton"],[class*="placeholder"],[class*="loading"],.animate-pulse,[aria-busy="true"]',
        ) || /loading/i.test(text);
      const hasPlanOrGoalRows =
        main.querySelectorAll(
          '[class*="PlanGrid__PlanGridRow"],[class*="PlanCell__Root"],[class*="GoalDashboardRow__"],[class*="GoalDashboardWidget"]',
        ).length > 4;

      if (/\/(?:goals|objectives|plan)(?:\/|$)/.test(routePath)) {
        if ((hasMtm || hasMoneyToken || hasPlanOrGoalRows) && (!hasSkeleton || hasPlanOrGoalRows)) return true;
        if (hasSkeleton) return false;
      }
      return text.length > 100;
    },
    { routePath },
    { timeout: timeoutMs, polling: 250 },
  );
}

async function findScrollContainer(page) {
  return page.evaluate(() => {
    const selectors = ['div[id$="-scroll"]', '[class*="Scroll__Root"]', '[class*="Virtualized"]', 'main'];
    for (const sel of selectors) {
      const nodes = document.querySelectorAll(sel);
      for (const node of nodes) {
        if (!(node instanceof HTMLElement)) continue;
        const style = getComputedStyle(node);
        const scrollable = (style.overflowY === 'auto' || style.overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 20;
        if (scrollable) return { selector: sel, found: true };
      }
    }
    return { selector: null, found: false };
  });
}

async function setScrollRatio(page, ratio, settleMs) {
  await page.evaluate((r) => {
    const selectors = ['div[id$="-scroll"]', '[class*="Scroll__Root"]', '[class*="Virtualized"]', 'main'];
    for (const sel of selectors) {
      const nodes = document.querySelectorAll(sel);
      for (const node of nodes) {
        if (!(node instanceof HTMLElement)) continue;
        const style = getComputedStyle(node);
        const scrollable = (style.overflowY === 'auto' || style.overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 20;
        if (!scrollable) continue;
        const maxTop = Math.max(0, node.scrollHeight - node.clientHeight);
        node.scrollTop = Math.floor(maxTop * r);
        return;
      }
    }
  }, ratio);
  await page.waitForTimeout(settleMs);
}

async function getObfState(page) {
  return page.evaluate(() => {
    const pref = localStorage.getItem('MT_HideSensitiveInfo');
    return {
      prefOn: pref === '1',
      bodyOn: document.body.classList.contains('mt-obfuscate-on'),
      togglePresent: !!document.querySelector('#mtm-obf-master'),
      wrappedCount: document.querySelectorAll('.mtm-amount').length,
    };
  });
}

async function setObfState(page, targetOn, routePath, manifest, options) {
  const targetPref = targetOn ? '1' : '0';

  const initial = await getObfState(page);
  if (initial.prefOn === targetOn && initial.bodyOn === targetOn) return;

  if (initial.togglePresent) {
    await page.evaluate(() => {
      const btn = document.querySelector('#mtm-obf-master');
      if (btn instanceof HTMLElement) btn.click();
    });
    await page.waitForTimeout(options.settleMs);
    const afterClick = await getObfState(page);
    if (afterClick.prefOn === targetOn && (afterClick.bodyOn === targetOn || !targetOn)) {
      return;
    }
  }

  // Fallback only when toggle click path is unavailable/inconsistent.
  await page.evaluate((pref) => {
    localStorage.setItem('MT_HideSensitiveInfo', pref);
  }, targetPref);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForPageReady(page, routePath, options);

  const finalState = await getObfState(page);
  if (finalState.prefOn !== targetOn) {
    throw new Error(`Unable to persist obfuscation preference ${targetOn ? 'on' : 'off'}`);
  }
  if (targetOn && !finalState.bodyOn) {
    manifest.notes.push(`Obfuscation ON preference set but body class is OFF at ${routePath}`);
  }
}

async function maybeNavigateSpa(page, route, options) {
  const clicked = await page.evaluate((href) => {
    const candidates = [
      `a[href="${href}"]`,
      `a[href^="${href}?"]`,
      `a[href^="${href}/"]`,
    ];
    for (const selector of candidates) {
      const a = document.querySelector(selector);
      if (a instanceof HTMLElement) {
        a.click();
        return true;
      }
    }
    return false;
  }, route.navHref);

  if (!clicked) return false;
  await page.waitForURL((url) => url.pathname.startsWith(route.navHref), { timeout: 20_000 });
  await waitForPageReady(page, route.navHref, options);
  return true;
}

function buildFilename({ routeKey, navMode, state, viewportKey, checkpoint }) {
  return `${routeKey}__${navMode}__${state}__${viewportKey}__${checkpoint}.png`;
}

async function captureFrame(page, outDir, params, manifest, options) {
  const filename = buildFilename(params);
  const fullPath = path.join(outDir, filename);
  await page.screenshot({ path: fullPath, fullPage: options.fullPageScreenshots });

  const meta = await page.evaluate(() => {
    const wrapped = document.querySelectorAll('.mtm-amount').length;
    const dollars = Array.from(document.querySelectorAll('.fs-exclude, .fs-mask')).filter((el) =>
      (el.textContent || '').includes('$'),
    ).length;
    return {
      url: window.location.href,
      wrappedCount: wrapped,
      dollarCandidateCount: dollars,
      obfPref: localStorage.getItem('MT_HideSensitiveInfo'),
      togglePresent: !!document.querySelector('#mtm-obf-master'),
      bodyClass: document.body.className,
    };
  });

  manifest.captures.push({
    ...params,
    file: filename,
    ...meta,
  });
}

async function runRoute(page, outDir, manifest, route, viewport, states, options) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.goto(toRouteUrl(route.path), { waitUntil: 'domcontentloaded' });
  await waitForPageReady(page, route.path, options);

  for (const navMode of options.navModes) {
    if (navMode === 'spa') {
      const ok = await maybeNavigateSpa(page, route, options);
      if (!ok) {
        manifest.notes.push(`SPA nav fallback to direct for route ${route.path} at viewport ${viewport.key}`);
        await page.goto(toRouteUrl(route.path), { waitUntil: 'domcontentloaded' });
        await waitForPageReady(page, route.path, options);
      }
    }
    if (navMode === 'reload') {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForPageReady(page, route.path, options);
    }

    for (const state of states) {
      const targetOn = state === 'on';
      await setObfState(page, targetOn, route.path, manifest, options);
      await setScrollRatio(page, 0, options.scrollSettleMs);

      const scroll = await findScrollContainer(page);
      const checkpoints = scroll.found ? options.scrollCheckpoints : [CHECKPOINT_MAP.top];
      if (!scroll.found) {
        manifest.notes.push(`No scrollable container detected for ${route.path} (${viewport.key}, ${state}, ${navMode})`);
      }

      for (const checkpoint of checkpoints) {
        await setScrollRatio(page, checkpoint.ratio, options.scrollSettleMs);
        await captureFrame(
          page,
          outDir,
          {
            routeKey: route.key,
            navMode,
            state,
            viewportKey: viewport.key,
            checkpoint: checkpoint.key,
          },
          manifest,
          options,
        );
      }
    }
  }
}

async function main() {
  const startedAt = Date.now();
  const storageState = loadStorageState();
  const profile = parseProfile();

  const routeFilter = parseListEnv('MONARCH_VISUAL_ROUTES');
  const viewportFilter = parseListEnv('MONARCH_VISUAL_VIEWPORTS');
  const states = parseStates(profile);
  const navModes = parseNavModes(profile);
  const scrollCheckpoints = parseCheckpoints(profile);
  const headless = process.env.MONARCH_VISUAL_HEADLESS === '0' ? false : true;
  const fullPageScreenshots =
    process.env.MONARCH_VISUAL_FULL_PAGE === '1' || (process.env.MONARCH_VISUAL_FULL_PAGE == null && profile === 'full');
  const requireNetworkIdle =
    process.env.MONARCH_VISUAL_REQUIRE_NETWORKIDLE === '1' ||
    (process.env.MONARCH_VISUAL_REQUIRE_NETWORKIDLE == null && profile === 'full');
  const settleMs = parseIntEnv('MONARCH_VISUAL_SETTLE_MS', profile === 'full' ? 700 : 250);
  const scrollSettleMs = parseIntEnv('MONARCH_VISUAL_SCROLL_SETTLE_MS', profile === 'full' ? 700 : 220);
  const contentReadyTimeoutMs = parseIntEnv('MONARCH_VISUAL_CONTENT_READY_TIMEOUT_MS', profile === 'full' ? 9000 : 5000);

  const routes = routeFilter ? ROUTES.filter((r) => routeFilter.includes(r.key)) : ROUTES;
  const viewports = viewportFilter ? VIEWPORTS.filter((v) => viewportFilter.includes(v.key)) : VIEWPORTS;

  if (routes.length === 0) throw new Error('No routes selected. Check MONARCH_VISUAL_ROUTES.');
  if (viewports.length === 0) throw new Error('No viewports selected. Check MONARCH_VISUAL_VIEWPORTS.');
  if (states.length === 0) throw new Error('No states selected. Check MONARCH_VISUAL_STATES.');
  if (navModes.length === 0) throw new Error('No nav modes selected. Check MONARCH_VISUAL_NAV_MODES.');
  if (scrollCheckpoints.length === 0) throw new Error('No checkpoints selected. Check MONARCH_VISUAL_CHECKPOINTS.');
  if (!existsSync(USERSCRIPT_PATH)) throw new Error(`Missing userscript at ${USERSCRIPT_PATH}`);

  const runTs = tsForPath();
  const outDir = path.join(repoRoot, 'playwright-artifacts', 'visual-review', runTs);
  ensureDir(outDir);

  const manifest = {
    generatedAt: new Date().toISOString(),
    outputDir: outDir,
    routes: routes.map((r) => r.path),
    viewports,
    states,
    profile,
    navModes,
    checkpoints: scrollCheckpoints.map((c) => c.key),
    fullPageScreenshots,
    requireNetworkIdle,
    settleMs,
    scrollSettleMs,
    contentReadyTimeoutMs,
    captures: [],
    notes: [],
  };

  const options = {
    navModes,
    scrollCheckpoints,
    settleMs,
    scrollSettleMs,
    contentReadyTimeoutMs,
    requireNetworkIdle,
    fullPageScreenshots,
  };

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    storageState,
    viewport: { width: 1440, height: 900 },
  });

  await context.addInitScript({ path: USERSCRIPT_PATH });
  const page = await context.newPage();

  for (const viewport of viewports) {
    for (const route of routes) {
      try {
        await runRoute(page, outDir, manifest, route, viewport, states, options);
      } catch (err) {
        manifest.notes.push(`Capture failed for ${route.path} (${viewport.key}): ${err?.message || String(err)}`);
      }
    }
  }

  await browser.close();

  writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`[live-visual-capture] output: ${outDir}`);
  console.log(`[live-visual-capture] profile: ${profile}`);
  console.log(`[live-visual-capture] captures: ${manifest.captures.length}`);
  console.log(`[live-visual-capture] elapsed_ms: ${Date.now() - startedAt}`);
  if (manifest.notes.length > 0) {
    console.log('[live-visual-capture] notes:');
    for (const note of manifest.notes) console.log(`- ${note}`);
  }
}

main().catch((err) => {
  console.error('[live-visual-capture] FAILED:', err);
  process.exit(1);
});

