import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

    await page.waitForSelector('#root', { timeout: 30_000 });
    // Give the SPA a moment to finish initial render.
    await page.waitForTimeout(1500);

    const html = await page.evaluate(() => document.documentElement.outerHTML);
    const normalized = normalizeHtml(html);

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


