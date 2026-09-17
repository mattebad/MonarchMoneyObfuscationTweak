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

function rawDollarLeaks(document) {
  const root = document.querySelector('main') || document.querySelector('#root') || document.body;
  if (!root) return [];
  const NodeFilter = document.defaultView.NodeFilter;
  const leaks = [];
  const rawAmountRe = /\$\s*[\d,]+(?:\.\d+)?(?:[KMBTkmbt])?/;
  const excludedRe = 'svg, [class*="recharts-"], [class*="SideBar__"], [data-sidebar], nav, aside, [role="navigation"], script, style';
  const isExcluded = (element) => element?.closest?.(excludedRe);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = node.nodeValue || '';
    const parent = node.parentElement;
    if (!parent) continue;
    if (!text.includes('$')) continue;
    if (parent.closest('.mtm-amount-wrap')) continue;
    if (isExcluded(parent)) continue;

    let context = parent;
    for (let depth = 0; context && depth < 4; depth += 1, context = context.parentElement) {
      if (isExcluded(context)) break;
      if (!rawAmountRe.test(context.textContent || '')) continue;
      leaks.push(text.trim() || (context.textContent || '').trim());
      break;
    }
  }
  return leaks;
}

async function scanAndAssertNoLeaks(document, api) {
  api.scanAndWrap();
  if (typeof api.processPendingQueue === 'function') api.processPendingQueue();
  await new Promise((resolve) => setTimeout(resolve, 40));
  const leaks = rawDollarLeaks(document);
  expect(leaks.length, 'raw dollar leak detected in main').toBe(0);
  expect(document.querySelector('svg .mtm-amount')).toBeNull();
}

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

  it('page preferences default all supported pages to enabled', () => {
    const { window, api } = makeDom({ routePath: '/dashboard', snapshotFile: 'dashboard.html' });
    expect(window.localStorage.getItem('MTM_OBF_PAGES')).toBeNull();
    expect(api.readPagePrefs()).toEqual({
      dashboard: true,
      accounts: true,
      transactions: true,
      goals: true,
      budget: true,
      investments: true,
    });
    expect(api.isActive()).toBe(true);
    expect(api.routeKey('/reports')).toBeNull();
    window.localStorage.setItem('MTM_OBF_PAGES', JSON.stringify({ dashboard: false }));
    expect(api.readPagePrefs().dashboard).toBe(false);
    expect(api.isActive()).toBe(false);
  });

  it('page preferences disable a page family without disabling the master toggle', () => {
    const { document, api } = makeDomFromHtml({
      routePath: '/dashboard',
      html: '<html><body><main><span class="fs-exclude">$1,234.56</span></main></body></html>',
    });

    expect(api.setPagePref('dashboard', false)).toBe(false);
    expect(api.isActive()).toBe(false);
    api.scanAndWrap();
    expect(document.querySelector('.mtm-amount')).toBeNull();
    expect(JSON.parse(document.defaultView.localStorage.getItem('MTM_OBF_PAGES')).dashboard).toBe(false);
  });

  it('page preferences apply to budget and goals route aliases', () => {
    const budgetDom = makeDomFromHtml({
      routePath: '/plan',
      html: '<html><body><main><div>$1,234.56</div></main></body></html>',
    });
    expect(budgetDom.api.routeKey('/budget')).toBe('budget');
    expect(budgetDom.api.routeKey('/plan/monthly')).toBe('budget');
    expect(budgetDom.api.setPagePref('budget', false)).toBe(false);
    expect(budgetDom.api.isActive()).toBe(false);

    const goalsDom = makeDomFromHtml({
      routePath: '/goals/debt-paydown',
      html: '<html><body><main><div>$1,234.56</div></main></body></html>',
    });
    expect(goalsDom.api.routeKey('/objectives')).toBe('goals');
    expect(goalsDom.api.routeKey('/goals/debt-paydown')).toBe('goals');
  });

  it('obfuscation settings pane injects six checkboxes without masking settings amounts', () => {
    const { document, api } = makeDomFromHtml({
      routePath: '/settings/obfuscation',
      html: `
        <html><body>
          <main>
            <section class="Card__CardRoot-x"><h2>Personal information</h2></section>
            <div class="profile-amount">$99.00</div>
          </main>
        </body></html>
      `,
    });

    api.ensureSettings();
    const card = document.querySelector('#mtm-obf-settings');
    expect(card).toBeTruthy();
    expect(card?.className).toContain('Card__CardRoot-x');
    expect(card?.querySelectorAll('input[data-mtm-page]').length).toBe(6);
    expect(Array.from(card?.querySelectorAll('input[data-mtm-page]') || []).every((input) => input.checked)).toBe(true);
    expect(document.querySelector('.profile-amount')?.textContent).toBe('$99.00');
    expect(document.querySelector('.mtm-amount')).toBeNull();
  });

  it('obfuscation settings writes a checkbox change and restores it on re-ensure', () => {
    const { document, api } = makeDomFromHtml({
      routePath: '/settings/obfuscation',
      html: '<html><body><main><div class="Card__CardRoot-x">Profile</div></main></body></html>',
    });

    api.ensureSettings();
    const accounts = document.querySelector('input[data-mtm-page="accounts"]');
    expect(accounts).toBeTruthy();
    accounts.checked = false;
    accounts.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));

    expect(JSON.parse(document.defaultView.localStorage.getItem('MTM_OBF_PAGES')).accounts).toBe(false);
    accounts.checked = true;
    api.ensureSettings();
    expect(document.querySelector('input[data-mtm-page="accounts"]')?.checked).toBe(false);
  });

  it('obfuscation settings adds an Account submenu entry and own pane', () => {
    const { document, api } = makeDomFromHtml({
      routePath: '/settings/obfuscation',
      html: `
        <html><body>
          <nav>
            <div id="account-settings-nav">
              <a href="/settings/profile" class="native-link active" data-selected="">Profile</a>
              <a href="/settings/display" class="native-link">Display</a>
            </div>
          </nav>
          <main><div class="Card__CardRoot-x">Profile</div></main>
        </body></html>
      `,
    });

    api.ensureSettings();
    const navLink = document.querySelector('#mtm-obf-settings-nav');
    expect(navLink).toBeTruthy();
    expect(navLink?.getAttribute('href')).toBe('/settings/obfuscation');
    expect(navLink?.textContent).toBe('Obfuscate Balances');
    expect(document.querySelector('a[href="/settings/profile"]')?.nextElementSibling).toBe(navLink);
    expect(navLink?.hasAttribute('data-selected')).toBe(true);
    expect(document.querySelector('a[href="/settings/profile"]')?.hasAttribute('data-selected')).toBe(false);
    expect(document.querySelector('#mtm-obf-settings-pane')).toBeTruthy();
    expect(document.querySelector('#mtm-obf-settings-pane #mtm-obf-settings')).toBeTruthy();
    expect(document.querySelector('main > .Card__CardRoot-x')?.style.display).toBe('none');
  });

  it('leaving obfuscation settings restores hidden native content', () => {
    const { window, document, api } = makeDomFromHtml({
      routePath: '/settings/obfuscation',
      html: `
        <html><body>
          <nav>
            <div id="account-settings-nav">
              <a href="/settings/profile" class="native-link active" data-selected="">Profile</a>
              <a href="/settings/display" class="native-link">Display</a>
            </div>
          </nav>
          <main>
            <div class="grid-cols-12">
              <div class="Card__CardRoot-x native-profile">Profile</div>
            </div>
          </main>
        </body></html>
      `,
    });

    api.ensureSettings();
    const native = document.querySelector('.native-profile');
    expect(document.querySelector('#mtm-obf-settings-pane')).toBeTruthy();
    expect(native?.getAttribute('data-mtm-obf-hidden')).toBe('1');
    expect(native?.style.display).toBe('none');

    window.history.pushState({}, '', '/settings/profile');
    expect(window.location.pathname).toBe('/settings/profile');
    api.ensureSettings();

    expect(document.querySelector('#mtm-obf-settings-pane')).toBeNull();
    expect(document.querySelector('#mtm-obf-settings')).toBeNull();
    expect(native?.hasAttribute('data-mtm-obf-hidden')).toBe(false);
    expect(native?.classList.contains('mtm-obf-settings-native-hidden')).toBe(false);
    expect(native?.style.display).toBe('');
    expect(document.querySelector('#mtm-obf-settings-nav')?.hasAttribute('data-selected')).toBe(false);
  });

  it('obfuscation settings route is never treated as an active masking page', () => {
    const { api } = makeDomFromHtml({
      routePath: '/settings/obfuscation',
      html: '<html><body><main><div class="Card__CardRoot-x">Profile</div></main></body></html>',
    });

    expect(api.routeKey('/settings/obfuscation')).toBeNull();
    expect(api.routeKey()).toBeNull();
    expect(api.isRouteAllowed()).toBe(false);
    expect(api.isActive()).toBe(false);
  });

  it('obfuscation settings nav only intercepts unmodified left clicks', () => {
    const { window, document, api } = makeDomFromHtml({
      routePath: '/settings/profile',
      html: `
        <html><body>
          <nav>
            <div id="account-settings-nav">
              <a href="/settings/profile" class="native-link active" data-selected="">Profile</a>
              <a href="/settings/display" class="native-link">Display</a>
            </div>
          </nav>
          <main><div class="Card__CardRoot-x">Profile</div></main>
        </body></html>
      `,
    });

    api.ensureSettings();
    const navLink = document.querySelector('#mtm-obf-settings-nav');
    expect(navLink).toBeTruthy();

    const modified = new window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
      ctrlKey: true,
    });
    navLink.dispatchEvent(modified);
    expect(modified.defaultPrevented).toBe(false);
    expect(window.location.pathname).toBe('/settings/profile');

    const plain = new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    navLink.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(true);
    expect(window.location.pathname).toBe('/settings/obfuscation');
  });

  it('malformed page preferences fall back to all supported pages enabled', () => {
    const { window, api } = makeDom({ routePath: '/dashboard', snapshotFile: 'dashboard.html' });
    window.localStorage.setItem('MTM_OBF_PAGES', 'not-json');
    expect(api.readPagePrefs()).toEqual({
      dashboard: true,
      accounts: true,
      transactions: true,
      goals: true,
      budget: true,
      investments: true,
    });
    expect(api.isActive()).toBe(true);
  });

  it('dashboard without main: scans the content pane instead of recurring item rows', async () => {
    const { document, api } = makeDomFromHtml({
      routePath: '/dashboard',
      html: `
        <html><body>
          <aside class="SideBar__Root">Invite a friend, get $30</aside>
          <div id="root">
            <div class="Scroll__Root-x">
              <div class="Card__CardRoot-x group/dashboard-widget">
                <span class="CardTitle-x DashboardWidget__Title-x">$288,332 net worth</span>
              </div>
              <div class="Card__CardRoot-x group/dashboard-widget RecurringTransactionsDashboardWidget__StyledDashboardWidget-x">
                <span class="DashboardWidget__Title-x">Recurring</span>
                <div class="DashboardWidget__Description-x">$7,802.16 remaining due</div>
                <div class="RecurringTransactionsDashboardWidget__Item-x">Apple One $19.99</div>
              </div>
              <div class="Card__CardRoot-x group/dashboard-widget">
                <span class="DashboardWidget__Title-x">Goals</span>
                <span class="Text-x">$601.58</span>
                <span class="fs-exclude">$1,268.40 (0.4%)</span>
              </div>
              <svg><text>$297.5K</text></svg>
            </div>
          </div>
        </body></html>
      `,
    });

    await scanAndAssertNoLeaks(document, api);
    expect(document.querySelector('.DashboardWidget__Description-x .mtm-amount')).toBeTruthy();
    expect(document.querySelector('.CardTitle-x .mtm-amount')).toBeTruthy();
    expect(document.querySelector('.Text-x .mtm-amount')).toBeTruthy();
    expect(document.querySelector('.fs-exclude .mtm-amount')).toBeTruthy();
    expect(document.querySelector('aside .mtm-amount')).toBeNull();
    expect(document.querySelector('svg .mtm-amount')).toBeNull();

    const scopes = api.findScopes();
    expect(scopes.some((scope) => scope.matches?.('[class*="Scroll__Root"]'))).toBe(true);
    expect(scopes.some((scope) => scope.matches?.('[class*="RecurringTransactionsDashboardWidget__Item-"]'))).toBe(false);
    expect(scopes[0].querySelectorAll('[class*="RecurringTransactionsDashboardWidget__Item-"]').length).toBe(1);
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

  it('accounts route: scans amount portals outside the main account list', async () => {
    const { document, api } = makeDomFromHtml({
      routePath: '/accounts',
      html: '<html><body><div class="__react_component_tooltip"><span class="fs-exclude">$123.45</span></div><main><div>$678.90</div></main></body></html>',
    });
    await scanAndAssertNoLeaks(document, api);
    expect(document.querySelector('.__react_component_tooltip .mtm-amount')).toBeTruthy();
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

  it('sidebar injection: re-homes a misplaced toggle into the primary nav list', () => {
    const primaryRoutes = ['dashboard', 'accounts', 'transactions', 'cash-flow', 'reports', 'budget', 'recurring', 'goals'];
    const iconLinks = primaryRoutes.map((route) => `<a href="/${route}" aria-label="${route}"><svg></svg></a>`).join('');
    const { document, api } = makeDomFromHtml({
      routePath: '/dashboard',
      html: `<html><body><div class="SideBar__Root"><div id="icon-rail">${iconLinks}</div><footer><a id="mtm-obf-master" href="#">Obfuscate Balances</a></footer></div><main><div>$1,234.56</div></main></body></html>`,
    });

    expect(document.getElementById('mtm-obf-master')?.parentElement?.tagName).toBe('FOOTER');
    api.ensureSideNav();
    const toggle = document.getElementById('mtm-obf-master');
    expect(toggle?.parentElement?.id).toBe('icon-rail');
    expect(toggle?.parentElement?.lastElementChild?.id).toBe('mtm-obf-master');
    expect(toggle?.closest('main')).toBeNull();
  });

  it('sidebar injection: collapses labeled icon-rail items to native 40x36', () => {
    const primaryRoutes = ['dashboard', 'accounts', 'transactions', 'cash-flow', 'reports', 'budget', 'recurring', 'goals'];
    const iconLinks = primaryRoutes.map((route) => `<a href="/${route}" aria-label="${route}">${route}<svg></svg></a>`).join('');
    const { document, api } = makeDomFromHtml({
      routePath: '/dashboard',
      html: `<html><body><div class="relative w-(--sidebar-collapsed-width) shrink-0" aria-expanded="false"><div class="absolute inset-y-0 left-0 z-10 flex w-(--sidebar-width)"><div id="icon-rail">${iconLinks}</div></div></div><main><div>$1,234.56</div></main></body></html>`,
    });

    api.ensureSideNav();
    const toggle = document.getElementById('mtm-obf-master');
    expect(toggle).toBeTruthy();
    expect(toggle?.classList.contains('mtm-nav-collapsed')).toBe(true);
    expect(toggle?.parentElement?.id).toBe('icon-rail');
    expect(toggle?.querySelector('.mtm-nav-title')).toBeTruthy();
  });

  it('sidebar injection: shows the obfuscate label when the flyout is expanded', () => {
    const primaryRoutes = ['dashboard', 'accounts', 'transactions', 'cash-flow', 'reports', 'budget', 'recurring', 'goals'];
    const iconLinks = primaryRoutes.map((route) => `<a href="/${route}" aria-label="${route}">${route}<svg></svg></a>`).join('');
    const { document, api } = makeDomFromHtml({
      routePath: '/dashboard',
      html: `<html><body><div class="relative w-(--sidebar-collapsed-width) shrink-0" aria-expanded="true"><div class="absolute inset-y-0 left-0 z-10 flex w-(--sidebar-width)"><div id="icon-rail">${iconLinks}</div></div></div><main><div>$1,234.56</div></main></body></html>`,
    });

    api.ensureSideNav();
    const toggle = document.getElementById('mtm-obf-master');
    expect(toggle).toBeTruthy();
    expect(toggle?.classList.contains('mtm-nav-collapsed')).toBe(false);
    expect(toggle?.querySelector('.mtm-nav-title')?.textContent).toBe('Obfuscate Balances');
  });

  it('dashboard Budget row: wraps planned and earned amounts with no raw $ leaks', async () => {
    const { document, api } = makeDomFromHtml({
      routePath: '/dashboard',
      html: '<html><body><main><div class="budget-row"><span>$8,563 planned</span><span>$4,468 earned</span></div><svg><text>$9K</text></svg></main></body></html>',
    });
    await scanAndAssertNoLeaks(document, api);
    expect(document.querySelectorAll('.mtm-amount').length).toBeGreaterThanOrEqual(2);
  });

  it('dashboard Recurring header: wraps remaining due with no raw $ leaks', async () => {
    const { document, api } = makeDomFromHtml({
      routePath: '/dashboard',
      html: '<html><body><main><div class="recurring-header">$7,802.16 remaining due</div><svg><text>$9K</text></svg></main></body></html>',
    });
    await scanAndAssertNoLeaks(document, api);
    expect(document.querySelectorAll('.mtm-amount').length).toBeGreaterThan(0);
  });

  it('dashboard Goals row: wraps goal balance with no raw $ leaks', async () => {
    const { document, api } = makeDomFromHtml({
      routePath: '/dashboard',
      html: '<html><body><main><div class="GoalDashboardRow__Balance-x"><strong>$601.58</strong></div><svg><text>$9K</text></svg></main></body></html>',
    });
    await scanAndAssertNoLeaks(document, api);
    expect(document.querySelectorAll('.mtm-amount').length).toBeGreaterThan(0);
  });

  it('budget remaining pill button and hero: wraps text inside the button, not the button itself', async () => {
    const { document, api } = makeDomFromHtml({
      routePath: '/budget',
      html: '<html><body><main><div class="hero">$1,578</div><button type="button">$4,256</button><svg><text>$12K</text></svg></main></body></html>',
    });
    await scanAndAssertNoLeaks(document, api);
    const pill = document.querySelector('main button');
    expect(pill).toBeTruthy();
    expect(pill?.tagName).toBe('BUTTON');
    expect(pill?.querySelector('.mtm-amount-wrap')).toBeTruthy();
    expect(document.querySelectorAll('.mtm-amount').length).toBeGreaterThanOrEqual(2);
  });

  it('budget split-node amount: joins sibling currency text without main', async () => {
    const { document, api } = makeDomFromHtml({
      routePath: '/budget',
      html: '<html><body><div id="root"><div class="Scroll__Root-x"><div class="budget-hero"><span>$</span><span>1,578</span></div></div></div></body></html>',
    });

    await scanAndAssertNoLeaks(document, api);
    expect(rawDollarLeaks(document)).toEqual([]);
    expect(document.querySelector('.budget-hero .mtm-amount-wrap')).toBeTruthy();
  });

  it('transaction merchant: wraps Cash Dividend dollar amount with no raw $ leaks', async () => {
    const { document, api } = makeDomFromHtml({
      routePath: '/transactions',
      html: '<html><body><main><div class="merchant">Cash Dividend of $5.47</div><svg><text>$9K</text></svg></main></body></html>',
    });
    await scanAndAssertNoLeaks(document, api);
    expect(document.querySelectorAll('.mtm-amount').length).toBeGreaterThan(0);
  });

  it('does not mask integer counts or wrap inside SVG, but does wrap compact $ amounts', async () => {
    const { document, api } = makeDomFromHtml({
      routePath: '/dashboard',
      html: '<html><body><main><div class="count">14,256 transactions</div><div class="compact">$35</div><div class="zero">$0.00</div><svg><text>$9K</text></svg></main></body></html>',
    });
    await scanAndAssertNoLeaks(document, api);
    expect(document.querySelector('.count')?.textContent).toContain('14,256 transactions');
    expect(document.querySelector('.count .mtm-amount')).toBeNull();
    expect(document.querySelectorAll('.mtm-amount').length).toBeGreaterThanOrEqual(2);
  });

  it('skips sidebar marketing copy while wrapping a content button', async () => {
    const { document, api } = makeDomFromHtml({
      routePath: '/dashboard',
      html: '<html><body><aside class="SideBar__Root"><div>Invite a friend, get $30</div></aside><main><button type="button">$35</button></main></body></html>',
    });
    await scanAndAssertNoLeaks(document, api);
    expect(api.wrapFirstAmount(document.querySelector('aside div'))).toBe(false);
    expect(document.querySelector('aside .mtm-amount')).toBeNull();
    expect(document.querySelector('main button .mtm-amount-wrap')).toBeTruthy();
  });

  it('scans lower dashboard widgets past the previous leaf cap', async () => {
    const filler = Array.from({ length: 460 }, (_, index) => `<span>$${index + 1}</span>`).join('');
    const { document, api } = makeDomFromHtml({
      routePath: '/dashboard',
      html: `<html><body><main><div class="filler">${filler}</div><div class="lower-goals-widget"><strong>$601.58</strong></div></main></body></html>`,
    });
    await scanAndAssertNoLeaks(document, api);
    expect(document.querySelector('.lower-goals-widget .mtm-amount')).toBeTruthy();
  });

  it('scans lower dashboard widgets past a capped no-main content pane', async () => {
    const filler = Array.from({ length: 460 }, (_, index) => `<span>$${index + 1}</span>`).join('');
    const { document, api } = makeDomFromHtml({
      routePath: '/dashboard',
      html: `
        <html><body>
          <aside class="SideBar__Root">Invite a friend, get $30</aside>
          <div id="root">
            <div class="Scroll__Root-x">
              <div class="filler">${filler}</div>
              <div class="Card__CardRoot-x group/dashboard-widget GoalsDashboardWidget-x">
                <div class="DashboardWidget__Description-x">$601.58</div>
              </div>
              <div class="Card__CardRoot-x group/dashboard-widget RecurringDashboardWidget-x">
                <div class="DashboardWidget__Description-x">$7,802.16 remaining due</div>
                <div class="RecurringTransactionsDashboardWidget__Item-x">Apple One $19.99</div>
              </div>
            </div>
          </div>
        </body></html>
      `,
    });

    const scroll = document.querySelector('.Scroll__Root-x');
    const goalsDescription = document.querySelector('.GoalsDashboardWidget-x .DashboardWidget__Description-x');
    const recurringDescription = document.querySelector('.RecurringDashboardWidget-x .DashboardWidget__Description-x');
    const cappedCandidates = api.collectDollarLeafCandidates(scroll, 400);
    expect(cappedCandidates).toContain(goalsDescription);
    expect(cappedCandidates).toContain(recurringDescription);

    await scanAndAssertNoLeaks(document, api);
    expect(goalsDescription?.querySelector('.mtm-amount')).toBeTruthy();
    expect(recurringDescription?.querySelector('.mtm-amount')).toBeTruthy();

    const scopes = api.findScopes();
    expect(scopes.some((scope) => scope.matches?.('[class*="Scroll__Root"]'))).toBe(true);
    expect(scopes.some((scope) => scope.matches?.('[class*="RecurringTransactionsDashboardWidget__Item-"]'))).toBe(false);
  });

  it('masks only the budget hero number flow and refreshes auxiliary CSS', () => {
    const { document, api } = makeDomFromHtml({
      routePath: '/budget',
      html: `
        <html><head><style id="mtm-obf-css">stale 1.3.7 css</style></head><body>
          <main>
            <section class="budget-hero">
              <span>Left to budget</span>
              <number-flow-react id="hero-flow"></number-flow-react>
            </section>
            <section class="transaction-count">
              <span>Transaction count</span>
              <number-flow-react id="count-flow"></number-flow-react>
            </section>
          </main>
        </body></html>
      `,
    });

    api.scanAndWrap();
    api.applyState();

    expect(document.querySelector('#hero-flow')?.classList.contains('mtm-mask-number-flow')).toBe(true);
    expect(document.querySelector('#count-flow')?.classList.contains('mtm-mask-number-flow')).toBe(false);
    const css = document.querySelector('#mtm-obf-css')?.textContent || '';
    expect(css).not.toContain('stale 1.3.7 css');
    expect(css).toContain('number-flow-react.mtm-mask-number-flow');
    expect(css).not.toContain('number-flow-react::after');

    document.querySelector('.budget-hero span').textContent = 'Budget available';
    api.applyState();
    expect(document.querySelector('#hero-flow')?.classList.contains('mtm-mask-number-flow')).toBe(false);
  });

  it('masks debt-paydown statistic card number flows without touching counts', () => {
    const { document, api } = makeDomFromHtml({
      routePath: '/goals/debt-paydown',
      html: `
        <html><body>
          <aside>Invite a friend, get $30</aside>
          <div id="root">
            <div class="Scroll__Root-x">
              <div class="DebtPaydown__SummaryCardsContainer-x">
                <div class="StatisticCard__Root-x">
                  <span class="StatisticCard__Value-x">
                    <span data-external-id="animated-currency" class="fs-mask">
                      <number-flow-react id="principal-flow" data='{"pre":[{"type":"currency","value":"$"}]}'></number-flow-react>
                    </span>
                  </span>
                  <span>Current Debt Principal</span>
                </div>
              </div>
              <div class="transaction-count">
                <span>Open debts</span>
                <number-flow-react id="count-flow"></number-flow-react>
              </div>
            </div>
          </div>
        </body></html>
      `,
    });

    api.scanAndWrap();
    api.applyState();
    expect(document.querySelector('#principal-flow')?.classList.contains('mtm-mask-number-flow')).toBe(true);
    expect(document.querySelector('#count-flow')?.classList.contains('mtm-mask-number-flow')).toBe(false);
    expect(document.querySelector('aside .mtm-amount')).toBeNull();

    document.defaultView.localStorage.setItem('MT_HideSensitiveInfo', '0');
    api.applyState();
    expect(document.querySelector('#principal-flow')?.classList.contains('mtm-mask-number-flow')).toBe(false);
  });

  it('masks chart y-axis ticks before revealing starred labels', () => {
    const { document, api } = makeDomFromHtml({
      routePath: '/budget',
      html: `
        <html><body>
          <main>
            <svg>
              <g class="recharts-yAxis-tick-labels"><text>$297.5K</text><text>$1K</text></g>
              <g class="recharts-xAxis-tick-labels"><text>Jan</text></g>
            </svg>
          </main>
        </body></html>
      `,
    });

    api.scanAndWrap();
    api.applyState();

    const css = document.querySelector('#mtm-obf-css')?.textContent || '';
    expect(css).toContain(':not(.mtm-chart-ticks-ready)');
    expect(css).not.toMatch(/body\.mt-obfuscate-on\s+[^{}]*\.recharts-yAxis[^{}]*\{opacity:0/);
    expect(document.querySelector('.recharts-yAxis-tick-labels text')?.textContent).toBe('$*,***.**K');
    expect(document.body.classList.contains('mtm-chart-ticks-ready')).toBe(true);
    expect(document.querySelector('.recharts-xAxis-tick-labels text')?.textContent).toBe('Jan');
    expect(document.querySelector('svg .mtm-amount')).toBeNull();

    document.defaultView.localStorage.setItem('MT_HideSensitiveInfo', '0');
    api.applyState();
    expect(document.body.classList.contains('mtm-chart-ticks-ready')).toBe(false);
    expect(document.querySelector('.recharts-yAxis-tick-labels text')?.textContent).toBe('$297.5K');
  });

  it('wraps dashboard widget titles that hydrate after the first scan', async () => {
    const { document, api } = makeDomFromHtml({
      routePath: '/dashboard',
      html: `
        <html><body>
          <div id="root">
            <div class="Scroll__Root-x">
              <span class="CardTitle-x DashboardWidget__Title-x">investments</span>
            </div>
          </div>
        </body></html>
      `,
    });

    await scanAndAssertNoLeaks(document, api);
    expect(document.querySelector('.DashboardWidget__Title-x .mtm-amount')).toBeNull();

    document.querySelector('.DashboardWidget__Title-x').textContent = '$288,867 investments';
    await scanAndAssertNoLeaks(document, api);
    expect(document.querySelector('.DashboardWidget__Title-x .mtm-amount')).toBeTruthy();
    expect(document.querySelector('.DashboardWidget__Title-x .mtm-amount')?.textContent).toMatch(/\$\*,\*\*\*\.\*\*/);
  });

  it('still wraps the investments title when a sibling trend is already masked', async () => {
    const { document, api } = makeDomFromHtml({
      routePath: '/dashboard',
      html: `
        <html><body>
          <aside class="SideBar__Root">Invite a friend, get $30</aside>
          <div id="root">
            <div class="Scroll__Root-x">
              <div class="DashboardWidget__HeaderArea-x">
                <span class="CardTitle-x DashboardWidget__Title-x">$292,969 investments</span>
                <span class="fs-exclude"><span class="mtm-amount-wrap"><span class="mtm-amount" data-original-text="$1,268.40">$*,***.**</span></span> (1.4%)</span>
              </div>
            </div>
          </div>
        </body></html>
      `,
    });

    await scanAndAssertNoLeaks(document, api);
    expect(document.querySelector('.DashboardWidget__Title-x .mtm-amount')).toBeTruthy();
    expect(document.querySelector('.DashboardWidget__Title-x .mtm-amount')?.textContent).toMatch(/\$\*,\*\*\*\.\*\*/);
    expect(document.querySelector('aside .mtm-amount')).toBeNull();
  });

  it('wraps investments titles on text-node replacement without waiting for a rescan', async () => {
    const { window, document } = makeDomFromHtml({
      routePath: '/dashboard',
      html: `
        <html><body>
          <aside class="SideBar__Root">Invite a friend, get $30</aside>
          <div id="root">
            <div class="Scroll__Root-x">
              <span class="CardTitle-x DashboardWidget__Title-x">investments</span>
            </div>
          </div>
        </body></html>
      `,
    });

    window.MTM_startObserver();
    const title = document.querySelector('.DashboardWidget__Title-x');
    title.textContent = '$292,969 investments';
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(title.querySelector('.mtm-amount')).toBeTruthy();
    expect(title.querySelector('.mtm-amount')?.textContent).toMatch(/\$\*,\*\*\*\.\*\*/);
    expect(document.querySelector('aside .mtm-amount')).toBeNull();
  });

  it('keeps chart ticks hidden until late dollar labels are masked', async () => {
    const { document, api } = makeDomFromHtml({
      routePath: '/dashboard',
      html: '<html><body><main><div class="recharts-wrapper fs-mask"></div></main></body></html>',
    });

    api.scanAndWrap();
    api.applyAuxMasks();
    expect(document.body.classList.contains('mtm-chart-ticks-ready')).toBe(false);

    document.querySelector('.recharts-wrapper').innerHTML =
      '<svg><g class="recharts-yAxis-tick-labels"><text>$297.5K</text></g></svg>';
    api.scanAndWrap();
    api.applyAuxMasks();

    expect(document.querySelector('.recharts-yAxis-tick-labels text')?.textContent).toBe('$*,***.**K');
    expect(document.body.classList.contains('mtm-chart-ticks-ready')).toBe(true);
    expect(document.querySelector('svg .mtm-amount')).toBeNull();
  });
});
