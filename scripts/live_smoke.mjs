import { chromium } from 'playwright';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const USERSCRIPT_PATH = path.join(repoRoot, 'MonarchMoneyObfuscate.user.js');
const VERIFY_GRAPHQL_AUTH = process.env.MONARCH_VERIFY_GRAPHQL_AUTH === '1';
const DEBUG_GRAPHQL_AUTH = process.env.MONARCH_DEBUG_GRAPHQL_AUTH === '1';

function getAuthScheme(authHeader) {
  if (!authHeader) return null;
  const s = String(authHeader).trim();
  if (!s) return null;
  const first = s.split(/\s+/)[0];
  return first || null;
}

function watchFirstGraphQLRequest(page, timeoutMs) {
  // Observe the next GraphQL request after this is called. We only return presence + scheme
  // (never the token value) to avoid leaking secrets in logs.
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => finish(null), timeoutMs);

    function finish(result) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      page.off('request', onRequest);
      resolve(result);
    }

    function onRequest(req) {
      try {
        const url = req.url();
        if (!/graphql/i.test(url)) return;
        if (req.method() === 'OPTIONS') return;
        const headers = req.headers();
        const auth = headers['authorization'] || null;
        finish({ url, hasAuth: !!auth, scheme: getAuthScheme(auth) });
      } catch {
        finish(null);
      }
    }

    page.on('request', onRequest);
  });
}

function loadStorageState() {
  const b64 = process.env.MONARCH_STORAGE_STATE_B64;
  const p = process.env.MONARCH_STORAGE_STATE_PATH;
  if (b64) {
    const json = Buffer.from(b64, 'base64').toString('utf8');
    return JSON.parse(json);
  }
  if (p) return p;
  throw new Error('Missing auth. Set MONARCH_STORAGE_STATE_B64 (recommended) or MONARCH_STORAGE_STATE_PATH.');
}

async function ensureDir(dir) {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }
}

async function captureFailureArtifacts(page, label) {
  const outDir = path.join(repoRoot, 'playwright-artifacts');
  await ensureDir(outDir);
  try {
    await page.screenshot({ path: path.join(outDir, `${label}.png`), fullPage: true });
  } catch {
    // ignore
  }
  try {
    const html = await page.content();
    writeFileSync(path.join(outDir, `${label}.html`), html, 'utf8');
  } catch {
    // ignore
  }
}

async function collectMaskStats(page) {
  return page.evaluate(() => {
    const wrapped = document.querySelectorAll('.mtm-amount');
    const candidateCount = Array.from(document.querySelectorAll('.fs-exclude, .fs-mask')).filter((el) =>
      (el.textContent || '').includes('$'),
    ).length;
    return {
      wrappedCount: wrapped.length,
      firstMaskedText: wrapped[0]?.textContent || null,
      candidateCount,
    };
  });
}

async function sweepScrollableContainers(page) {
  await page.evaluate(() => {
    const seen = new Set();
    const selectors = ['div[id$="-scroll"]', '[class*="Scroll__Root"]', '[class*="Virtualized"]', 'main'];
    for (const sel of selectors) {
      const nodes = document.querySelectorAll(sel);
      for (const node of nodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (seen.has(node)) continue;
        seen.add(node);
        const cs = getComputedStyle(node);
        const scrollable = (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 20;
        if (!scrollable) continue;
        const checkpoints = [0.25, 0.5, 0.85, 1];
        for (const checkpoint of checkpoints) {
          node.scrollTop = Math.max(0, Math.floor((node.scrollHeight - node.clientHeight) * checkpoint));
        }
      }
    }
  });
}

async function waitForMaskedAmounts(page, routePath) {
  let stats = await collectMaskStats(page);
  if (stats.wrappedCount > 0) return stats;

  for (let i = 0; i < 3; i++) {
    await sweepScrollableContainers(page);
    await page.waitForTimeout(1200);
    stats = await collectMaskStats(page);
    if (stats.wrappedCount > 0) return stats;
  }

  // Some pages may legitimately have no visible dollar values for an account.
  if (stats.candidateCount === 0) {
    console.log(`[live-smoke] ${routePath}: no '$' candidates found; skipping masked-text assertion`);
    return stats;
  }

  throw new Error(
    `Expected wrapped amounts on ${routePath}, found wrapped=${stats.wrappedCount}, dollarCandidates=${stats.candidateCount}`,
  );
}

async function assertSidebarTogglePlacement(page, routePath) {
  const placement = await page.evaluate(() => {
    const toggle = document.querySelector('#mtm-obf-master');
    const sidebar = document.querySelector('[class*="SideBar__Root-"], [class*="SideBar__Root"], .SideBar__Root-sc-161w9oi-0');
    const nav = toggle?.parentElement || null;
    const tr = toggle?.getBoundingClientRect?.() || null;
    const sr = sidebar?.getBoundingClientRect?.() || null;
    return {
      exists: !!toggle,
      lastIsToggle: !!(nav && nav.lastElementChild && nav.lastElementChild.id === 'mtm-obf-master'),
      hasActiveClass: !!toggle?.classList?.contains('nav-item-active'),
      outsideSidebar:
        !!(tr && sr) && (tr.bottom > sr.bottom + 2 || tr.top < sr.top - 2 || tr.left < sr.left - 2 || tr.right > sr.right + 2),
    };
  });

  if (!placement.exists) throw new Error(`Toggle missing on ${routePath}`);
  if (!placement.lastIsToggle) throw new Error(`Toggle is not last nav item on ${routePath}`);
  if (placement.hasActiveClass) throw new Error(`Toggle incorrectly inherited nav-item-active class on ${routePath}`);
  if (placement.outsideSidebar) throw new Error(`Toggle positioned outside sidebar bounds on ${routePath}`);
}

async function runRoute(page, routePath) {
  const url = `https://app.monarch.com${routePath}`;
  const label = routePath.replace(/\W+/g, '_').replace(/^_+|_+$/g, '') || 'root';
  const gqlProbe =
    VERIFY_GRAPHQL_AUTH || DEBUG_GRAPHQL_AUTH ? watchFirstGraphQLRequest(page, 15_000) : Promise.resolve(null);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // Quick auth sanity check: if we got bounced to login, fail loudly.
  if (page.url().includes('/login')) {
    throw new Error(`Auth failed or expired (bounced to /login) while loading ${routePath}`);
  }

  // Note: on some builds the app root can be present but not "visible" per Playwright heuristics
  // (e.g., 0-sized root with fixed-position children). We only need it attached.
  await page.waitForSelector('#root', { timeout: 30_000, state: 'attached' });
  // Wait for a stable, user-visible anchor in the sidebar to ensure the app rendered.
  await page.waitForSelector('a[href="/dashboard"]', { timeout: 30_000 });

  // Toggle should be injected into the sidebar.
  await page.waitForSelector('#mtm-obf-master', { timeout: 20_000 });
  await assertSidebarTogglePlacement(page, routePath);

  // Validate resize does not break toggle placement.
  await page.setViewportSize({ width: 1180, height: 760 });
  await page.waitForTimeout(750);
  await assertSidebarTogglePlacement(page, routePath);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(750);

  // Wait for wrapped amounts, including nested-scroll routes.
  const stats = await waitForMaskedAmounts(page, routePath);
  if (stats.wrappedCount > 0 && (!stats.firstMaskedText || !stats.firstMaskedText.includes('*'))) {
    throw new Error(`Expected masked amount to include "*" on ${routePath}, got: ${JSON.stringify(stats.firstMaskedText)}`);
  }

  // Ensure we didn't wrap inside SVG.
  const svgWrapped = await page.evaluate(() => !!document.querySelector('svg .mtm-amount'));
  if (svgWrapped) {
    throw new Error(`Found .mtm-amount inside <svg> on ${routePath} (should be skipped)`);
  }

  const gql = await gqlProbe;
  if (DEBUG_GRAPHQL_AUTH) {
    if (!gql) console.log(`[live-smoke] ${routePath}: no GraphQL request observed within 15s`);
    else console.log(`[live-smoke] ${routePath}: GraphQL auth header present=${gql.hasAuth} scheme=${gql.scheme || 'n/a'}`);
  }
  if (VERIFY_GRAPHQL_AUTH) {
    if (!gql) {
      throw new Error(`No GraphQL request observed within 15s on ${routePath}; cannot verify Authorization header`);
    }
    if (!gql.hasAuth) {
      throw new Error(`GraphQL request missing Authorization header on ${routePath} (storageState may be incomplete/expired)`);
    }
  }

  // Toggle OFF and ensure the body class flips and amount becomes unmasked.
  await page.evaluate(() => {
    const toggle = document.querySelector('#mtm-obf-master');
    if (toggle instanceof HTMLElement) toggle.click();
  });
  await page.waitForFunction(() => !document.body.classList.contains('mt-obfuscate-on'), null, { timeout: 10_000 });

  const toggleOffState = await page.evaluate(() => {
    const bodyOff = !document.body.classList.contains('mt-obfuscate-on');
    const pref = localStorage.getItem('MT_HideSensitiveInfo');
    const el = document.querySelector('.mtm-amount');
    if (!el) return { bodyOff, pref, unmaskedOk: true };
    const orig = el.dataset.originalText || '';
    return { bodyOff, pref, unmaskedOk: !!orig && el.textContent === orig };
  });
  if (!toggleOffState.bodyOff) {
    throw new Error(`Toggle OFF did not clear body state on ${routePath}`);
  }
  if (toggleOffState.pref !== '0') {
    throw new Error(`Toggle OFF did not persist preference on ${routePath}, got ${toggleOffState.pref}`);
  }
  if (!toggleOffState.unmaskedOk) {
    throw new Error(`Toggle OFF did not restore original text on ${routePath}`);
  }
}

async function main() {
  const storageState = loadStorageState();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState,
    viewport: { width: 1440, height: 900 },
  });

  // Ensure obfuscation starts ON for the smoke test.
  await context.addInitScript(() => {
    try {
      localStorage.setItem('MT_HideSensitiveInfo', '1');
    } catch {
      // ignore
    }
  });

  // Inject the userscript.
  await context.addInitScript({ path: USERSCRIPT_PATH });

  const page = await context.newPage();

  const routes = ['/dashboard', '/accounts', '/transactions', '/goals/savings', '/plan', '/investments/holdings/market'];
  for (const route of routes) {
    try {
      await runRoute(page, route);
      // Reset to ON for next route.
      await page.evaluate(() => {
        try {
          localStorage.setItem('MT_HideSensitiveInfo', '1');
          document.body.classList.add('mt-obfuscate-on');
        } catch {
          // ignore
        }
      });
    } catch (e) {
      await captureFailureArtifacts(page, `smoke${route.replace(/\W+/g, '_')}`);
      throw e;
    }
  }

  await browser.close();
  console.log('[live-smoke] OK:', routes.join(', '));
}

main().catch((err) => {
  console.error('[live-smoke] FAILED:', err);
  process.exit(1);
});



