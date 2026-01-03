import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const ROUTE_DOMS_DIR = path.join(repoRoot, 'Route DOMs');

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

function normalizeHtml(html) {
  // Reduce snapshot noise from random UUIDs (cookie banner, aria ids, etc.)
  return String(html).replace(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    '00000000-0000-0000-0000-000000000000',
  );
}

function sanitizeHtml(html) {
  const dom = new JSDOM(String(html));
  const { document, NodeFilter } = dom.window;

  // Remove scripts entirely (can contain embedded user data and is irrelevant to DOM-structure tests).
  for (const s of Array.from(document.querySelectorAll('script'))) s.remove();

  const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
  const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
  const MONEY_RE = /\$\s*[\d,.]+|\(\$\s*[\d,.]+\)|-\$\s*[\d,.]+/g;
  const PERCENT_RE = /\b-?\d+(?:\.\d+)?%\b/g;

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function sanitizeMoneyMatch(m) {
    const t = String(m).trim();
    const isNeg = t.startsWith('-$');
    const isParen = /^\(\$/.test(t);
    let masked = '$1,234.56';
    if (isNeg) masked = `-${masked}`;
    if (isParen) masked = `(${masked})`;
    return masked;
  }

  // Best-effort: detect the logged-in user's name and redact it anywhere it appears.
  const namesToRedact = new Set();
  for (const el of Array.from(document.querySelectorAll('[class*="UserName"]'))) {
    const t = (el.textContent || '').trim();
    if (t && t.length <= 60) namesToRedact.add(t);
  }
  // Also detect greeting breadcrumb: "Good afternoon, <Name>!"
  for (const el of Array.from(document.querySelectorAll('*'))) {
    const t = (el.textContent || '').trim();
    if (!t) continue;
    if (t.length > 80) continue;
    if (!t.startsWith('Good ')) continue;
    const m = t.match(/^Good (?:morning|afternoon|evening),\s*([^!]+)!/);
    if (!m) continue;
    const name = (m[1] || '').trim();
    if (!name) continue;
    if (name.length > 60) continue;
    if (/\$/.test(name)) continue;
    if (/\d/.test(name)) continue;
    namesToRedact.add(name);
  }
  const nameRes = Array.from(namesToRedact).map((n) => new RegExp(escapeRegExp(n), 'g'));

  const walker = document.createTreeWalker(document, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    let v = node.nodeValue;
    if (!v || !v.trim()) continue;

    const parent = node.parentElement;
    const inFsExclude = !!(parent && parent.closest && parent.closest('.fs-exclude'));
    const inCreditScore = !!(parent && parent.closest && parent.closest('[class*="CreditScore"]'));

    let next = v;
    next = next.replace(UUID_RE, '00000000-0000-0000-0000-000000000000');
    next = next.replace(EMAIL_RE, 'user@example.com');
    next = next.replace(MONEY_RE, sanitizeMoneyMatch);
    next = next.replace(PERCENT_RE, '0.0%');
    for (const re of nameRes) next = next.replace(re, 'REDACTED');

    if (inFsExclude && next.indexOf('$') === -1) {
      const trimmed = next.trim();
      if (trimmed && /[A-Za-z0-9]/.test(trimmed)) next = 'REDACTED';
    }
    if (inCreditScore && next.indexOf('$') === -1) {
      const trimmed = next.trim();
      if (trimmed && /[A-Za-z0-9]/.test(trimmed)) next = 'REDACTED';
    }

    if (next !== v) node.nodeValue = next;
  }

  // Shrink fixtures: keep only the SPA root. This removes huge inline <style> blocks (incl. sourcemaps),
  // cookie banners, iframes (Stripe/recaptcha), and other non-structural noise.
  try {
    const root = document.getElementById('root');
    if (root && document.body) {
      const cloned = root.cloneNode(true);
      if (document.head) document.head.innerHTML = '';
      document.body.innerHTML = '';
      document.body.appendChild(cloned);
    }
  } catch {
    // ignore
  }

  return dom.serialize();
}

async function main() {
  mkdirSync(ROUTE_DOMS_DIR, { recursive: true });

  const storageState = loadStorageState();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState,
    viewport: { width: 1440, height: 900 },
  });

  const page = await context.newPage();

  const targets = [
    { route: '/dashboard', file: 'dashboard.html' },
    { route: '/accounts', file: 'accounts.html' },
    { route: '/transactions', file: 'transactions.html' },
    { route: '/objectives', file: 'objectives.html' },
    { route: '/investments', file: 'investments.html' },
  ];

  for (const t of targets) {
    const url = `https://app.monarch.com${t.route}`;
    console.log(`[snapshot] Fetching ${t.route}`);
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    if (page.url().includes('/login')) {
      throw new Error(`Auth failed or expired (bounced to /login) while loading ${t.route}`);
    }

    // Note: on some builds the app root can be present but not "visible" per Playwright heuristics
    // (e.g., 0-sized root with fixed-position children). We only need it attached.
    await page.waitForSelector('#root', { timeout: 30_000, state: 'attached' });
    // Wait for a stable, user-visible anchor in the sidebar to ensure the app rendered.
    await page.waitForSelector('a[href="/dashboard"]', { timeout: 30_000 });
    // Ensure at least one currency value is present in privacy-marked nodes; this makes fixtures useful
    // for selector regression tests and avoids capturing a partially-rendered virtualized list.
    await page.waitForFunction(() => {
      const els = document.querySelectorAll('.fs-exclude, .fs-mask');
      for (let i = 0; i < els.length; i++) {
        const t = els[i].textContent || '';
        if (t.indexOf('$') !== -1) return true;
      }
      return false;
    }, null, { timeout: 30_000 });
    // Give the SPA a moment to finish initial render.
    await page.waitForTimeout(1500);

    const html = await page.evaluate(() => document.documentElement.outerHTML);
    const sanitized = sanitizeHtml(html);
    const normalized = normalizeHtml(sanitized);

    const outPath = path.join(ROUTE_DOMS_DIR, t.file);
    let prev = '';
    try {
      prev = readFileSync(outPath, 'utf8');
    } catch {
      prev = '';
    }
    if (prev !== normalized) console.log(`[snapshot] Updated: ${t.file}`);
    else console.log(`[snapshot] Unchanged: ${t.file}`);
    writeFileSync(outPath, normalized, 'utf8');
  }

  await browser.close();
  console.log('[snapshot] Done.');
}

main().catch((err) => {
  console.error('[snapshot] FAILED:', err);
  process.exit(1);
});


