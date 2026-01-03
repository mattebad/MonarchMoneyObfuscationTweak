import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const USERSCRIPT_PATH = path.join(repoRoot, 'MonarchMoneyObfuscate.user.js');
const ROUTE_DOMS_DIR = path.join(repoRoot, 'Route DOMs');

const userscriptText = readFileSync(USERSCRIPT_PATH, 'utf8');

function makeDom({ routePath, snapshotFile }) {
  const html = readFileSync(path.join(ROUTE_DOMS_DIR, snapshotFile), 'utf8');
  const dom = new JSDOM(html, {
    url: `https://app.monarch.com${routePath}`,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });

  const { window } = dom;
  // Enable deterministic "test mode" in the userscript (disables intervals/lifecycle wiring).
  window.__MTM_OBF_TEST__ = true;
  // Enable obfuscation.
  window.localStorage.setItem('MT_HideSensitiveInfo', '1');

  // Evaluate the userscript inside the JSDOM window context.
  window.eval(userscriptText);

  const api = window.MTM_OBF_TEST_API;
  expect(api, 'Expected MTM_OBF_TEST_API to be exposed in test mode').toBeTruthy();
  return { dom, window, document: window.document, api };
}

function wrapSomeMoneyCandidates(document, api, { maxAttempts = 60 } = {}) {
  const candidates = Array.from(document.querySelectorAll('.fs-exclude, .fs-mask'))
    .filter((el) => ((el.textContent || '').includes('$')));

  let wrapped = 0;
  let attempted = 0;
  for (const el of candidates) {
    attempted += 1;
    if (api.wrapFirstAmount(el)) wrapped += 1;
    if (attempted >= maxAttempts) break;
  }
  return { wrapped, attempted, candidates: candidates.length };
}

const MASK_RE = /\$\*,\*\*\*\.\*\*/; // "$*,***.**"

describe('MonarchMoneyObfuscate userscript - DOM snapshot regression', () => {
  it('dashboard snapshot: wraps and masks at least one value, and does not touch SVG', () => {
    const { document, api } = makeDom({ routePath: '/dashboard', snapshotFile: 'dashboard.html' });
    const { wrapped } = wrapSomeMoneyCandidates(document, api);
    expect(wrapped).toBeGreaterThan(0);

    const amounts = Array.from(document.querySelectorAll('.mtm-amount'));
    expect(amounts.length).toBeGreaterThan(0);
    for (const span of amounts.slice(0, 10)) {
      expect(span.dataset.originalText || '').toMatch(/\$/);
      expect(span.textContent || '').toMatch(MASK_RE);
    }
    expect(document.querySelector('svg .mtm-amount')).toBeNull();

    // Unmask should restore original text.
    document.defaultView.localStorage.setItem('MT_HideSensitiveInfo', '0');
    api.applyState();
    for (const span of amounts.slice(0, 10)) {
      expect(span.textContent).toBe(span.dataset.originalText);
    }
  });

  it('accounts snapshot: wraps and masks at least one value', () => {
    const { document, api } = makeDom({ routePath: '/accounts', snapshotFile: 'accounts.html' });
    const { wrapped } = wrapSomeMoneyCandidates(document, api, { maxAttempts: 120 });
    expect(wrapped).toBeGreaterThan(0);
    expect(document.querySelectorAll('.mtm-amount').length).toBeGreaterThan(0);
  });

  it('transactions snapshot: wraps and masks at least one value', () => {
    const { document, api } = makeDom({ routePath: '/transactions', snapshotFile: 'transactions.html' });
    const { wrapped } = wrapSomeMoneyCandidates(document, api, { maxAttempts: 120 });
    expect(wrapped).toBeGreaterThan(0);
    expect(document.querySelectorAll('.mtm-amount').length).toBeGreaterThan(0);
  });

  it('objectives snapshot: wraps and masks at least one value', () => {
    const { document, api } = makeDom({ routePath: '/objectives', snapshotFile: 'objectives.html' });
    const { wrapped } = wrapSomeMoneyCandidates(document, api, { maxAttempts: 120 });
    expect(wrapped).toBeGreaterThan(0);
    expect(document.querySelectorAll('.mtm-amount').length).toBeGreaterThan(0);
  });

  it('investments snapshot: wraps and masks at least one value (fs-mask coverage)', () => {
    const { document, api } = makeDom({ routePath: '/investments', snapshotFile: 'investments.html' });
    const { wrapped } = wrapSomeMoneyCandidates(document, api, { maxAttempts: 200 });
    expect(wrapped).toBeGreaterThan(0);
    expect(document.querySelectorAll('.mtm-amount').length).toBeGreaterThan(0);
  });

  it('route gating: enabled preference does not activate on unsupported route', () => {
    const { api } = makeDom({ routePath: '/reports', snapshotFile: 'dashboard.html' });
    expect(api.isActive()).toBe(false);
  });

  it('sidebar injection: can insert toggle into dashboard sidebar in test mode', () => {
    const { document, api } = makeDom({ routePath: '/dashboard', snapshotFile: 'dashboard.html' });
    expect(document.getElementById('mtm-obf-master')).toBeNull();
    api.ensureSideNav();
    expect(document.getElementById('mtm-obf-master')).toBeTruthy();
  });
});



