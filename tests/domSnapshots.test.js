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
  return makeDomFromHtml({ routePath, html });
}

function makeDomFromHtml({ routePath, html }) {
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

  it('route gating: goals routes remain active', () => {
    const { api } = makeDom({ routePath: '/goals/savings', snapshotFile: 'objectives.html' });
    expect(api.isActive()).toBe(true);
  });

  it('route gating: the current budget route is active', () => {
    const { api } = makeDom({ routePath: '/budget', snapshotFile: 'dashboard.html' });
    expect(api.isActive()).toBe(true);
  });

  it('budget route: scans compact values that are not FullStory-marked', async () => {
    const { document, api } = makeDomFromHtml({
      routePath: '/budget',
      html: '<html><body><main><div class="budget-value"><span>$</span><span>1,234.56</span></div></main></body></html>',
    });

    api.scanAndWrap();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.querySelectorAll('.mtm-amount').length).toBeGreaterThan(0);
    expect(document.querySelector('.mtm-amount')?.textContent).toMatch(/\*/);
  });

  it('route gating: auxiliary masks do not leak onto unsupported routes', () => {
    const { document, api } = makeDomFromHtml({
      routePath: '/reports',
      html: '<html><body><svg><text>$9K</text></svg><input value="$123.45"></body></html>',
    });

    api.applyState();
    expect(document.body.classList.contains('mt-obfuscate-on')).toBe(false);
    expect(document.querySelector('text')?.textContent).toBe('$9K');
    expect(document.querySelector('input')?.value).toBe('$123.45');
  });

  it('sidebar injection: can insert toggle into dashboard sidebar in test mode', () => {
    const { document, api } = makeDom({ routePath: '/dashboard', snapshotFile: 'dashboard.html' });
    expect(document.getElementById('mtm-obf-master')).toBeNull();
    api.ensureSideNav();
    const toggle = document.getElementById('mtm-obf-master');
    expect(toggle).toBeTruthy();
    expect(toggle.classList.contains('nav-item-active')).toBe(false);
    expect(toggle.querySelector('.mtm-nav-title')?.textContent).toBe('Obfuscate Balances');
    expect(toggle.parentElement?.lastElementChild?.id).toBe('mtm-obf-master');
  });

  it('sidebar injection: stays in a new icon-only navigation rail', () => {
    const primaryRoutes = ['dashboard', 'accounts', 'transactions', 'cash-flow', 'reports', 'budget', 'recurring', 'goals'];
    const iconLinks = primaryRoutes.map((route) => `<a href="/${route}" aria-label="${route}"><svg></svg></a>`).join('');
    const contentLinks = primaryRoutes.slice(0, 4).map((route) => `<a href="/${route}">${route}</a>`).join('');
    const { document, api } = makeDomFromHtml({
      routePath: '/dashboard',
      html: `<html><body><div id="app"><div id="icon-rail">${iconLinks}</div><main><header id="dashboard-header">${contentLinks}</header><div>$1,234.56</div></main></div></body></html>`,
    });

    api.ensureSideNav();
    const toggle = document.getElementById('mtm-obf-master');
    expect(toggle).toBeTruthy();
    expect(toggle?.parentElement?.id).toBe('icon-rail');
    expect(toggle?.classList.contains('mtm-nav-collapsed')).toBe(true);
    expect(toggle?.getAttribute('aria-pressed')).toBe('true');
    expect(toggle?.getAttribute('aria-label')).toBe('Show balances');
  });
});
