import { chromium, firefox, webkit } from 'playwright';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const OUT_PATH = process.env.MONARCH_STORAGE_STATE_PATH || 'monarch.storageState.json';
const START_URL = 'https://app.monarch.com/';

async function launchBrowser() {
  const preferred = (process.env.MONARCH_PLAYWRIGHT_BROWSER || '').toLowerCase();
  const channel = process.env.MONARCH_PLAYWRIGHT_CHANNEL || 'chrome';

  const engines = [
    { name: 'chromium', engine: chromium },
    { name: 'firefox', engine: firefox },
    { name: 'webkit', engine: webkit },
  ];

  const ordered = preferred
    ? [engines.find((e) => e.name === preferred)].filter(Boolean).concat(engines.filter((e) => e.name !== preferred))
    : engines;

  const errors = [];

  // First try: system Chrome (often more compatible on new macOS releases).
  try {
    return await chromium.launch({ headless: false, channel });
  } catch (e) {
    errors.push(`chromium(channel=${channel}): ${e?.message || String(e)}`);
  }

  // Fallback: bundled browsers.
  for (const e of ordered) {
    try {
      return await e.engine.launch({ headless: false });
    } catch (err) {
      errors.push(`${e.name}: ${err?.message || String(err)}`);
    }
  }

  const msg =
    `Unable to launch a browser for auth export.\n` +
    `Tried (in order): chromium(channel=${channel}), then bundled ${ordered.map((e) => e.name).join(', ')}.\n\n` +
    `Errors:\n- ${errors.join('\n- ')}\n\n` +
    `Fixes to try:\n` +
    `- Install Google Chrome and retry (default uses channel="${channel}")\n` +
    `- Or set MONARCH_PLAYWRIGHT_BROWSER=webkit (uses Safari engine) or MONARCH_PLAYWRIGHT_BROWSER=firefox\n` +
    `- If you are on Apple Silicon and running an x64 Node under Rosetta, retry with an arm64 Node\n`;

  throw new Error(msg);
}

async function main() {
  const browser = await launchBrowser();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  console.log(`[auth] Opening ${START_URL}`);
  await page.goto(START_URL, { waitUntil: 'domcontentloaded' });

  console.log('[auth] Sign in (Sign in with Apple) in the opened browser window.');
  console.log(`[auth] Once you are fully logged in, return here and press Enter to write storageState to: ${OUT_PATH}`);

  const rl = createInterface({ input, output });
  await rl.question('Press Enter to save storageState... ');
  rl.close();

  await context.storageState({ path: OUT_PATH });
  await browser.close();

  console.log(`[auth] Saved storageState -> ${OUT_PATH}`);
  console.log('[auth] For GitLab CI, base64-encode it and store as a masked/protected variable: MONARCH_STORAGE_STATE_B64');
  console.log(`[auth] Example (macOS): base64 -i ${OUT_PATH} | pbcopy`);
}

main().catch((err) => {
  console.error('[auth] Failed:', err);
  process.exit(1);
});


