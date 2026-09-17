// ==UserScript==
// @name         Monarch Money - Obfuscate Balances
// @namespace    https://tampermonkey.net/
// @version      1.3.17
// @description  Obfuscate dollar amounts on Monarch Money Dashboard/Accounts/Transactions/Goals/Budget/Investments with performant observers
// @match        https://app.monarch.com/*
// @downloadURL  https://github.com/mattebad/MonarchMoneyObfuscationTweak/raw/refs/heads/main/MonarchMoneyObfuscate.user.js
// @updateURL    https://github.com/mattebad/MonarchMoneyObfuscationTweak/raw/refs/heads/main/MonarchMoneyObfuscate.user.js
// @icon         https://www.google.com/s2/favicons?sz=64&domain=monarchmoney.com
// @grant        none
// ==/UserScript==

(function(){
    'use strict';
    const MTM_TEST_MODE = !!window.__MTM_OBF_TEST__;

    // Minimal helpers (localStorage-backed)
    function setCookie(cName, cValue) { localStorage.setItem(cName,cValue); }
    function getCookie(cname,isNum) {
        let value = localStorage.getItem(cname);
        if(value !== null) return value;
        if(isNum == true) {return 0;} else {return '';}
    }
    // Debug (opt-in): set localStorage MTM_OBF_DEBUG=1 to enable console.debug + counters.
    function MTM_isDebugEnabled(){ try { return getCookie('MTM_OBF_DEBUG', true) == 1; } catch(e) { void e; return false; } }
    function MTM_dbg(){
        if(!MTM_isDebugEnabled()) return;
        try { console.debug.apply(console, ['[MTM Obfuscate]'].concat([].slice.call(arguments))); } catch(e) { void e; }
    }
    window.MTM_OBF_STATS = Object.assign({
        scanRuns:0, candidatesSeen:0, watched:0, enqueued:0, queueRuns:0,
        wrapAttempts:0, wrapSuccess:0, observerStarts:0, observerStops:0,
        scanMs:0, queueMsMax:0, chartLabelMs:0, longTaskCount:0
    }, window.MTM_OBF_STATS || {});
    var MTM_CHART_MASK = { dirty: true, lastOn: null, route: null, applying: false };
    var MTM_SCOPE_FP = '';
    function MTM_markChartLabelsDirty(){
        if(MTM_CHART_MASK.applying) return;
        MTM_CHART_MASK.dirty = true;
        if(document.body && MTM_isActive()) document.body.classList.remove('mtm-chart-ticks-ready');
    }
    var MTM_LONGTASK_OBSERVER = window.MTM_OBF_LONGTASK_OBSERVER || null;
    function MTM_startLongTaskObserver(){
        if(MTM_LONGTASK_OBSERVER || typeof window.PerformanceObserver === 'undefined') return;
        try {
            var po = new window.PerformanceObserver(function(list){
                if(!MTM_isActive()) return;
                var entries = list.getEntries ? list.getEntries() : [];
                for(var i=0;i<entries.length;i++){
                    if(entries[i] && entries[i].duration > 50){
                        try { window.MTM_OBF_STATS.longTaskCount += 1; } catch(e) { void e; }
                    }
                }
            });
            var observed = false;
            try {
                po.observe({ type: 'longtask', buffered: true });
                observed = true;
            } catch(e1){
                try { po.observe({ entryTypes: ['longtask'] }); observed = true; } catch(e2) { void e2; }
            }
            if(observed){
                MTM_LONGTASK_OBSERVER = po;
                window.MTM_OBF_LONGTASK_OBSERVER = po;
            } else if(po.disconnect) {
                po.disconnect();
            }
        } catch(e) { void e; }
    }
    function MTM_stopLongTaskObserver(){
        if(!MTM_LONGTASK_OBSERVER) return;
        try { MTM_LONGTASK_OBSERVER.disconnect(); } catch(e) { void e; }
        MTM_LONGTASK_OBSERVER = null;
        window.MTM_OBF_LONGTASK_OBSERVER = null;
    }

    // [ MT: Obfuscate Dollar Amounts — scoped to dashboard, accounts, transactions, goals, budget/plan, and investments ]
    // Injects minimal CSS used by the masking spans and the sidebar toggle; idempotent.
    (function MTM_Obfuscation_InitCSS(){
        const css = '\n.mtm-amount-wrap{position:relative;display:inline-block;margin-right:.25em}\nbody.mt-obfuscate-on:not(.mtm-chart-ticks-ready) .fs-mask .recharts-yAxis .recharts-text tspan{opacity:0}\nbody.mt-obfuscate-on:not(.mtm-chart-ticks-ready) .recharts-yAxis .recharts-cartesian-axis-tick-value,\nbody.mt-obfuscate-on:not(.mtm-chart-ticks-ready) .recharts-yAxis .recharts-text,\nbody.mt-obfuscate-on:not(.mtm-chart-ticks-ready) .recharts-yAxis tspan{opacity:0!important}\nbody.mt-obfuscate-on input.fs-exclude,\nbody.mt-obfuscate-on input[class*="CurrencyInput__Input-"]{-webkit-text-security:disc;text-security:disc}\n.mtm-nav-eye-btn{display:flex;align-items:center;gap:12px;cursor:pointer;color:inherit;background:transparent;border:0;width:100%;padding:8px 10px;border-radius:8px;text-align:left}\n.mtm-nav-eye-btn:hover{background:rgba(255,255,255,.06)}\n.mtm-nav-eye-btn .mtm-iconwrap{display:flex;align-items:center;justify-content:center;width:40px;height:40px}\n.mtm-nav-eye-btn .mtm-icon{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px}\n.mtm-nav-eye-btn .mtm-icon svg{width:20px;height:20px;display:block}\n.mtm-nav-eye-btn .mtm-label{font-size:12px;white-space:nowrap}\n.mtm-nav-collapsed .mtm-label{display:none}\n#mtm-obf-master{display:flex;align-items:center;gap:0;box-sizing:border-box;min-width:0;max-width:100%;height:36px;margin:0 0 2px;padding:8px 12px;overflow:hidden;transition:none!important}\n#mtm-obf-master .mtm-nav-title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}\n#mtm-obf-master:not(.mtm-nav-collapsed) .mtm-nav-title{display:inline-block}\n#mtm-obf-master .mtm-nav-iconwrap{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:16px;height:16px;min-width:16px;margin:0 12px 0 0;transition:none!important}\n#mtm-obf-master .mtm-eye-icon{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;line-height:1}\n#mtm-obf-master .mtm-eye-icon::before,\n#mtm-obf-master .mtm-eye-icon::after{content:none!important}\n#mtm-obf-master .mtm-eye-icon svg{width:16px;height:16px;display:block}\n.sidebar-collapsed #mtm-obf-master,\n#mtm-obf-master.mtm-nav-collapsed{width:40px!important;min-width:40px!important;max-width:40px!important;height:36px!important;padding:8px 12px!important;gap:0!important;margin:0 0 2px!important;overflow:hidden!important;justify-content:flex-start!important;transition:none!important}\n.sidebar-collapsed #mtm-obf-master .mtm-nav-iconwrap,\n#mtm-obf-master.mtm-nav-collapsed .mtm-nav-iconwrap{margin:0!important}\n.sidebar-collapsed #mtm-obf-master .mtm-nav-title,\n#mtm-obf-master.mtm-nav-collapsed .mtm-nav-title{display:none!important}\n#mtm-obf-settings.mtm-settings-card{box-sizing:border-box;width:100%;max-width:100%;margin-top:16px;padding:24px;color:inherit;scroll-margin-top:24px}\n#mtm-obf-settings .mtm-settings-header{display:flex;flex-direction:column;gap:6px;margin:0 0 16px}\n#mtm-obf-settings .mtm-settings-heading{margin:0;font-size:1.125rem;line-height:1.4;font-weight:600;color:inherit}\n#mtm-obf-settings .mtm-settings-description{margin:0;max-width:60rem;font-size:.875rem;line-height:1.45;opacity:.72}\n#mtm-obf-settings .mtm-settings-list{list-style:none;margin:0;padding:0}\n#mtm-obf-settings .mtm-settings-row{border-top:1px solid color-mix(in srgb,currentColor 14%,transparent)}\n#mtm-obf-settings .mtm-settings-row:last-child{border-bottom:1px solid color-mix(in srgb,currentColor 14%,transparent)}\n#mtm-obf-settings .mtm-settings-label{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:52px;width:100%;cursor:pointer}\n#mtm-obf-settings .mtm-settings-copy{display:flex;flex-direction:column;gap:2px;min-width:0}\n#mtm-obf-settings .mtm-settings-name{font-size:.9375rem;line-height:1.3;font-weight:500}\n#mtm-obf-settings .mtm-settings-hint{font-size:.8125rem;line-height:1.35;opacity:.65}\n#mtm-obf-settings input[data-mtm-page]{flex:0 0 auto;width:16px;height:16px;margin:0;accent-color:currentColor}\n';
        const auxCss = '\nbody.mt-obfuscate-on:not(.mtm-chart-ticks-ready) .recharts-wrapper.fs-mask .recharts-cartesian-axis-tick-labels.recharts-yAxis-tick-labels .recharts-layer.recharts-cartesian-axis-tick-label,\nbody.mt-obfuscate-on:not(.mtm-chart-ticks-ready) .recharts-wrapper.fs-mask .recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value,\nbody.mt-obfuscate-on:not(.mtm-chart-ticks-ready) svg .recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-label{opacity:0!important}\nbody.mt-obfuscate-on number-flow-react.mtm-mask-number-flow{position:relative}\nbody.mt-obfuscate-on number-flow-react.mtm-mask-number-flow::part(left),\nbody.mt-obfuscate-on number-flow-react.mtm-mask-number-flow::part(number),\nbody.mt-obfuscate-on number-flow-react.mtm-mask-number-flow::part(right){opacity:0!important}\nbody.mt-obfuscate-on number-flow-react.mtm-mask-number-flow::after{content:"$*,***.**";position:absolute;inset:0;display:inline-flex;align-items:center;justify-content:center;pointer-events:none;white-space:nowrap;color:inherit;z-index:1}\n';
        // md+ 4/span 9 matches Monarch's current settings grid (3-col nav + 9-col content).
        const paneCss = '\n#mtm-obf-settings-pane{box-sizing:border-box;display:block;grid-column:1/-1;grid-row:1;min-width:0;width:100%;min-height:100%;padding:0;scroll-margin-top:24px}\n#mtm-obf-settings-pane>#mtm-obf-settings{width:100%;max-width:none;margin:0}\n@media (min-width:768px){#mtm-obf-settings-pane{grid-column:4/span 9}}\n.mtm-obf-settings-native-hidden{display:none!important}\n';
        function inject(){
            try {
                const head = document.head || document.documentElement;
                if(!head) return;
                const style = document.getElementById('mtm-obf-css') || document.createElement('style');
                if(!style.id) style.id = 'mtm-obf-css';
                style.textContent = css + auxCss + paneCss;
                if(!style.parentNode) head.appendChild(style);
            } catch(e) { void e; }
        }
        // When injected via Playwright addInitScript, document.head may not exist yet; defer safely.
        if (document.head) inject();
        else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject, { once: true });
        else inject();
    })();

    // Central configuration: supported pages, scan containers, and elements to skip.
    // The catalog is also consumed by the dedicated settings pane so route gating and UI
    // cannot drift apart when a supported page is added or renamed.
    const MTM_PAGE_CATALOG = [
        { id: 'dashboard', label: 'Dashboard', hint: 'Net worth, widgets, charts', re: /^\/dashboard(?:\/|$)/ },
        { id: 'accounts', label: 'Accounts', hint: 'Account list and balances', re: /^\/accounts(?:\/|$)/ },
        { id: 'transactions', label: 'Transactions', hint: 'Transaction amounts', re: /^\/transactions(?:\/|$)/ },
        { id: 'goals', label: 'Goals', hint: 'Save up and pay down', re: /^\/(?:goals|objectives)(?:\/|$)/ },
        { id: 'budget', label: 'Budget', hint: 'Budget / plan', re: /^\/(?:plan|budget)(?:\/|$)/ },
        { id: 'investments', label: 'Investments', hint: 'Holdings and movers', re: /^\/investments(?:\/|$)/ }
    ];
    const MTM_OBF_CFG = {
        routeAllow: MTM_PAGE_CATALOG.map(function(page){ return page.re; }),
        skipSelectors: [
            // App chrome & internal UIs
            '[class*="SideBar__"]','[class*="NavBarLink__"]',
            '[id="side-drawer-root"]','[class*="FooterButtonContainer__"]',
            '[data-sidebar]',
            'aside','nav','[role="navigation"]',
            'input','textarea','select','[contenteditable="true"]',
            // Skip highly dynamic charting/SVG areas to avoid DOM races
            'svg', '[class*="recharts-"]', '.recharts-wrapper',
            '[class*="MultipleLineChart__"]', '[class*="NetWorthPerformanceChart__"]',
            '[class*="CashFlowDashboardWidgetGraph__"]'
        ],
    };
    // Precomputed skip selector for a single closest() check in hot paths.
    const MTM_SKIP_CLOSEST = MTM_OBF_CFG.skipSelectors.join(',');
    const MTM_DIRECT_SCAN_CLOSEST = '[class*="react_component_tooltip"],[role="tooltip"]';

    // Precompiled regexes to avoid re-allocation on hot paths
    const MTM_RE_MONEY = /\$\s*[\d,.]+|\(\$\s*[\d,.]+\)|-\$\s*[\d,.]+/g;
    const MTM_RE_FIRST_SIMPLE = /\$\s*[\d,.]+/;
    const MTM_RE_PLAIN_MONEY = /\d{1,3}(?:,\d{3})+(?:\.\d+)?/;
    const MTM_RE_PLAIN_MONEY_GLOBAL = /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g;
    const MTM_RE_CHART_DOLLAR = /\$\s*[-+]?\s*[\d,.]+(?:[KMBTkmbt])?/;
    // Hoisted dashboard selector reused in multiple places to avoid string rebuilds.
    var MTM_DASH_SEL = window.MTM_DASH_SEL || '[class*="CardTitle-"], [class*="DashboardWidget__Title-"], [class*="DashboardWidget__Description-"], [class*="GoalDashboardRow__Balance-"], [class*="RecurringTransactionsDashboardWidget__Amount-"], [class*="InvestmentsDashboardWidgetTopMoverRow__CurrentPriceText-"]';
    window.MTM_DASH_SEL = MTM_DASH_SEL;
    // Dedupe and batching helpers
    // Dedupe structures and batching queues for observer work.
    window.MTM_SEEN = window.MTM_SEEN || new WeakSet();
    window.MTM_OBF_PENDING = window.MTM_OBF_PENDING || new Set();
    window.MTM_OBF_SCHEDULED = window.MTM_OBF_SCHEDULED || false;
    // IntersectionObserver gating: process only when candidates are near/inside viewport.
    window.MTM_IO = window.MTM_IO || (('IntersectionObserver' in window) ? new IntersectionObserver(function(entries){
        var didEnqueue = false;
        for (var i=0;i<entries.length;i++){
            var entry = entries[i];
            if(entry.isIntersecting){
                MTM_enqueue(entry.target);
                didEnqueue = true;
                try { window.MTM_IO.unobserve(entry.target); } catch(e) { void e; }
            }
        }
        if(didEnqueue) MTM_scheduleProcessQueue();
    },{root: null, rootMargin: '200px', threshold: 0}) : null);
    // True when the candidate sits inside its own scroll container (virtualized panes/tables).
    // For these, viewport IntersectionObserver can miss updates permanently, so process directly.
    function MTM_hasScrollableAncestor(el){
        var p = el && el.parentElement;
        while(p && p !== document.body){
            try {
                var st = window.getComputedStyle(p);
                if(st){
                    var oy = st.overflowY;
                    if((oy === 'auto' || oy === 'scroll') && p.scrollHeight > (p.clientHeight + 20)){
                        return true;
                    }
                }
            } catch(e) { void e; }
            p = p.parentElement;
        }
        return false;
    }
    function MTM_hasMaskableText(txt){
        if(!txt) return false;
        return txt.indexOf('$') !== -1 || MTM_RE_PLAIN_MONEY.test(txt);
    }
    // Returns true when an element still contains raw '$' text outside our wrappers.
    function MTM_hasUnwrappedDollarText(el){
        if(!el || !(el instanceof Element)) return false;
        var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
        while(walker.nextNode()){
            var n = walker.currentNode;
            var t = n && n.nodeValue || '';
            if(!MTM_hasMaskableText(t)) continue;
            var p = n.parentElement;
            if(!p) continue;
            if(p.closest && p.closest('.mtm-amount-wrap')) continue;
            if(MTM_SKIP_CLOSEST && p.closest && p.closest(MTM_SKIP_CLOSEST)) continue;
            return true;
        }
        return false;
    }
    // Watch helper: observes element visibility or falls back to immediate queueing.
    function MTM_watch(el){
        if(!el || !MTM_isActive()) return;
        // Dashboard titles must wrap before the next paint. rAF / IO is too late for first load,
        // and titles live under Scroll__Root so the scrollable-ancestor shortcut would delay them.
        if(el.matches && el.matches(MTM_DASH_SEL)){
            MTM_wrapNow(el);
            return;
        }
        // JSDOM / test mode: IntersectionObserver may exist but never fire; enqueue immediately.
        if(MTM_TEST_MODE){
            MTM_enqueue(el);
            MTM_scheduleProcessQueue();
            return;
        }
        if(MTM_hasScrollableAncestor(el)){
            MTM_enqueue(el);
            MTM_scheduleProcessQueue();
            return;
        }
        if(el.closest && el.closest(MTM_DIRECT_SCAN_CLOSEST)){
            MTM_enqueue(el);
            MTM_scheduleProcessQueue();
            return;
        }
        if(window.MTM_IO){
            try { window.MTM_IO.observe(el); } catch(e) { void e; MTM_enqueue(el); MTM_scheduleProcessQueue(); }
        } else {
            MTM_enqueue(el);
            MTM_scheduleProcessQueue();
        }
    }
    // Helper: quick eligibility check for processing.
    function MTM_shouldProcess(el){
        if(!el || !(el instanceof Element) || !el.isConnected) return false;
        if(window.MTM_SEEN && window.MTM_SEEN.has(el) && !MTM_hasUnwrappedDollarText(el)) return false;
        if(el.querySelector && el.querySelector('.mtm-amount') && !MTM_hasUnwrappedDollarText(el)) return false;
        if(el.closest && el.closest('.mtm-amount-wrap')) return false;
        return true;
    }
    // Wrap immediately so MutationObserver runs before the browser paints the raw amount.
    function MTM_wrapNow(el){
        if(!MTM_isActive() || !el || !el.isConnected) return 0;
        if(MTM_SKIP_CLOSEST && el.closest && el.closest(MTM_SKIP_CLOSEST)) return 0;
        if(el.closest && el.closest('.mtm-amount-wrap')) return 0;
        if(!MTM_hasUnwrappedDollarText(el)) return 0;
        var wrappedCount = MTM_wrapAllAmounts(el, 10);
        try {
            if(window.MTM_SEEN && (wrappedCount > 0 || !MTM_hasUnwrappedDollarText(el))) window.MTM_SEEN.add(el);
        } catch(e) { void e; }
        if(wrappedCount > 0) {
            try { window.MTM_OBF_STATS.wrapSuccess += wrappedCount; } catch(e2) { void e2; }
        }
        return wrappedCount;
    }
    function MTM_wrapDashboardHeaders(root){
        if(!MTM_isActive()) return;
        if(!/^\/dashboard(?:\/|$)/.test(window.location.pathname || '')) return;
        var scope = root && root.querySelectorAll ? root : document;
        var nodes = [];
        try {
            if(scope.nodeType === 1 && scope.matches && scope.matches(MTM_DASH_SEL)) nodes.push(scope);
            if(scope.querySelectorAll){
                var found = scope.querySelectorAll(MTM_DASH_SEL);
                for(var i=0;i<found.length;i++) nodes.push(found[i]);
            }
        } catch(e) { void e; }
        for(var ni=0; ni<nodes.length; ni++){
            if(MTM_hasUnwrappedDollarText(nodes[ni])) MTM_wrapNow(nodes[ni]);
        }
    }
    function MTM_wrapDashHostFromNode(node){
        if(!node) return;
        var el = (node.nodeType === 1) ? node : node.parentElement;
        if(!el || !el.closest) return;
        var host = (el.matches && el.matches(MTM_DASH_SEL)) ? el : el.closest(MTM_DASH_SEL);
        if(host) MTM_wrapNow(host);
    }
    // Enqueue a candidate element for masked wrapping; skips already processed/masked hosts.
    function MTM_enqueue(el){
        if(!MTM_isActive()) return;
        if(!MTM_shouldProcess(el)) return;
        window.MTM_OBF_PENDING.add(el);
        try { window.MTM_OBF_STATS.enqueued += 1; } catch(e) { void e; }
    }
    // Processes the pending queue within a frame time budget to avoid long tasks.
    function MTM_processPendingQueue(){
        if(!MTM_isActive()){
            try { window.MTM_OBF_PENDING.clear(); } catch(e) { void e; }
            window.MTM_OBF_SCHEDULED = false;
            return;
        }
        try { window.MTM_OBF_STATS.queueRuns += 1; } catch(e) { void e; }
        const start = performance.now();
        const budgetMs = 8;
        const cap = 300;
        let processed = 0;
        // Drain a frame-budgeted slice
        const it = window.MTM_OBF_PENDING.values();
        let step = it.next();
        while(!step.done){
            const el = step.value;
            window.MTM_OBF_PENDING.delete(el);
            if(el && el.isConnected){
                try { window.MTM_OBF_STATS.wrapAttempts += 1; } catch(e) { void e; }
                var wrappedCount = MTM_wrapAllAmounts(el, 10);
                if(wrappedCount > 0) { processed+=1; try { window.MTM_OBF_STATS.wrapSuccess += wrappedCount; } catch(e) { void e; } }
                // Only mark seen after a successful wrap, or when nothing maskable remains.
                // Failed first-load wraps (title still "investments", $ arrives later) must stay eligible.
                try{
                    if(window.MTM_SEEN && (wrappedCount > 0 || !MTM_hasUnwrappedDollarText(el))) window.MTM_SEEN.add(el);
                }catch(e){ void e; }
            }
            if(processed >= cap || (performance.now() - start) > budgetMs) break;
            step = it.next();
        }
        MTM_applyAuxMasks();
        try { window.MTM_OBF_STATS.queueMsMax = Math.max(window.MTM_OBF_STATS.queueMsMax || 0, performance.now() - start); } catch(e) { void e; }
        if(window.MTM_OBF_PENDING.size > 0){
            if(MTM_TEST_MODE){
                window.MTM_OBF_SCHEDULED = false;
                return;
            }
            requestAnimationFrame(MTM_processPendingQueue);
        } else {
            window.MTM_OBF_SCHEDULED = false;
        }
    }
    // Schedules queue processing on the next animation frame once.
    function MTM_scheduleProcessQueue(){
        if(!MTM_isActive()){
            try { window.MTM_OBF_PENDING.clear(); } catch(e) { void e; }
            window.MTM_OBF_SCHEDULED = false;
            return;
        }
        if(window.MTM_OBF_SCHEDULED) return;
        window.MTM_OBF_SCHEDULED = true;
        if(MTM_TEST_MODE){
            var guard = 0;
            while(window.MTM_OBF_PENDING && window.MTM_OBF_PENDING.size > 0 && guard < 80){
                window.MTM_OBF_SCHEDULED = true;
                MTM_processPendingQueue();
                guard++;
            }
            window.MTM_OBF_SCHEDULED = false;
            return;
        }
        requestAnimationFrame(MTM_processPendingQueue);
    }

    // Schedules a low-priority catch-up task to process any stragglers off the critical path.
    function MTM_scheduleIdleCatchup(){
        var idle = window.requestIdleCallback || function(cb){ return setTimeout(function(){ cb({ timeRemaining:function(){ return 0; }, didTimeout:true }); }, 120); };
        idle(function(){
            try { MTM_scanAndWrap(); } catch(e) { void e; }
            MTM_scheduleProcessQueue();
        }, { timeout: 200 });
    }

    const MTM_OBF_PAGE_PREFS_KEY = 'MTM_OBF_PAGES';
    var MTM_PAGE_PREFS_CACHE = null;
    var MTM_PAGE_PREFS_RAW = undefined;

    function MTM_findPageEntry(id) {
        for(var i=0; i<MTM_PAGE_CATALOG.length; i++){
            if(MTM_PAGE_CATALOG[i].id === id) return MTM_PAGE_CATALOG[i];
        }
        return null;
    }

    // Missing, malformed, or partial preferences intentionally resolve to "on" for
    // every known page so existing installs retain their current behavior.
    // Cache the parsed object keyed by the raw localStorage string so MutationObserver
    // and wrap scans skip JSON.parse on the hot path.
    function MTM_readPagePrefs() {
        var raw = null;
        try { raw = localStorage.getItem(MTM_OBF_PAGE_PREFS_KEY); } catch(e) { raw = null; }
        if(MTM_PAGE_PREFS_CACHE && MTM_PAGE_PREFS_RAW === raw) return MTM_PAGE_PREFS_CACHE;
        var parsed = null;
        try { if(raw) parsed = JSON.parse(raw); } catch(e) { parsed = null; }
        var source = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
        var prefs = {};
        for(var i=0; i<MTM_PAGE_CATALOG.length; i++){
            var id = MTM_PAGE_CATALOG[i].id;
            prefs[id] = !(source && source[id] === false);
        }
        MTM_PAGE_PREFS_RAW = raw;
        MTM_PAGE_PREFS_CACHE = prefs;
        return prefs;
    }

    function MTM_writePagePrefs(next) {
        var normalized = {};
        for(var i=0; i<MTM_PAGE_CATALOG.length; i++){
            var id = MTM_PAGE_CATALOG[i].id;
            normalized[id] = !!(next && next[id] !== false);
        }
        var serialized = JSON.stringify(normalized);
        try { setCookie(MTM_OBF_PAGE_PREFS_KEY, serialized); } catch(e) { void e; }
        MTM_PAGE_PREFS_RAW = serialized;
        MTM_PAGE_PREFS_CACHE = normalized;
        return normalized;
    }

    function MTM_isPageEnabled(id) {
        return !!MTM_findPageEntry(id) && MTM_readPagePrefs()[id] !== false;
    }

    function MTM_setPagePref(id, enabled) {
        if(!MTM_findPageEntry(id)) return false;
        var prefs = MTM_readPagePrefs();
        prefs[id] = enabled !== false;
        MTM_writePagePrefs(prefs);
        MTM_onPrefsChanged();
        return prefs[id];
    }

    function MTM_routeKey(pathname) {
        var p = pathname || (window.location && window.location.pathname) || '';
        for(var i=0; i<MTM_PAGE_CATALOG.length; i++){
            if(MTM_PAGE_CATALOG[i].re.test(p)) return MTM_PAGE_CATALOG[i].id;
        }
        return null;
    }

    // Returns true if current SPA route is supported and enabled in page settings.
    function MTM_isRouteAllowed() {
        var key = MTM_routeKey();
        return !!key && MTM_isPageEnabled(key);
    }
    // Returns user preference for masking (driven by sidebar toggle or settings checkbox).
    function MTM_isObfEnabled() { return getCookie('MT_HideSensitiveInfo', true) == 1; }
    // Single source of truth for whether masking work should run.
    function MTM_isActive(){ return MTM_isRouteAllowed() && MTM_isObfEnabled(); }
    function MTM_onPrefsChanged(){
        MTM_applyState();
        MTM_scanAndWrap();
        if(MTM_isActive()){
            if(window.MTM_restartObserver) window.MTM_restartObserver();
        } else if(window.MTM_stopObserver) {
            window.MTM_stopObserver();
        }
    }
    // Finds DOM roots to scan/observe, limited to known containers for performance.
    const MTM_SCOPE_EXCLUDE = '[class*="SideBar__"],[data-sidebar],nav,aside,[role="navigation"],svg,[class*="recharts-"]';
    function MTM_isScopeEligible(root) {
        if(!root || (root.nodeType !== 1 && root.nodeType !== 9)) return false;
        if(root.nodeType !== 1) return true;
        try {
            if(root.matches && root.matches(MTM_SCOPE_EXCLUDE)) return false;
            if(root.closest && root.closest('[class*="SideBar__"],[data-sidebar],nav,aside,[role="navigation"]')) return false;
        } catch(e) { void e; }
        return true;
    }
    function MTM_dedupeScopes(roots) {
        const unique = [];
        for(var i=0; i<roots.length; i++){
            var root = roots[i];
            if(!root || !MTM_isScopeEligible(root) || unique.indexOf(root) !== -1) continue;
            unique.push(root);
        }
        return unique.filter(function(root, index){
            for(var i=0; i<unique.length; i++){
                var other = unique[i];
                if(i === index || !other || !other.contains) continue;
                try { if(other.contains(root)) return false; } catch(e) { void e; }
            }
            return true;
        });
    }
    // Prefer one page content pane, then fall back to widget roots, app root, or document.
    // Supplemental tooltip portals stay included when they sit outside the selected pane.
    function MTM_findScopes() {
        function query(sel) {
            try { return Array.from(document.querySelectorAll(sel)).filter(MTM_isScopeEligible); }
            catch(e) { void e; return []; }
        }
        var primary = query('main');
        if(!primary.length) primary = query('[class*="Scroll__Root"],[data-external-id="scroll"]');
        if(!primary.length) primary = query('[class*="group/dashboard-widget"],[class*="Card__CardRoot"]');
        if(!primary.length) {
            primary = query('[data-rbd-droppable-id="accountGroups"],[class*="AccountNetWorthCharts__Root"],[class*="AccountSummaryCardGroup__"],[class*="AccountGroupCard__Content-"],[class*="AccountBalanceIndicator__Root-"]');
        }
        if(!primary.length) {
            try {
                var appRoot = document.querySelector('#root');
                if(appRoot && MTM_isScopeEligible(appRoot)) primary = [appRoot];
            } catch(e) { void e; }
        }
        if(!primary.length) primary = [document];

        primary = MTM_dedupeScopes(primary);
        var scopes = primary.slice();
        var portals = query('[class*="react_component_tooltip"],[role="tooltip"]');
        for(var pi=0; pi<portals.length; pi++){
            var portal = portals[pi];
            var covered = false;
            for(var si=0; si<primary.length; si++){
                var content = primary[si];
                try {
                    if((content.contains && content.contains(portal)) || (portal.contains && portal.contains(content))){
                        covered = true;
                        break;
                    }
                } catch(e) { void e; }
            }
            if(!covered) scopes.push(portal);
        }
        return MTM_dedupeScopes(scopes);
    }
    function MTM_scopeFingerprint(){
        var scopes = MTM_findScopes();
        var parts = [];
        for(var i=0; i<scopes.length; i++){
            var scope = scopes[i];
            if(!scope) continue;
            if(scope === document) { parts.push('document'); continue; }
            var cls = '';
            try { cls = String(scope.className || '').slice(0, 80); } catch(e) { void e; }
            parts.push((scope.tagName || 'n') + '#' + (scope.id || '') + '.' + cls);
        }
        return parts.join('|');
    }
    // Masks any dollar amounts within a string to a normalized $*,***.** shape.
    function MTM_maskMoneyValue(s){
        var out = String(s).replace(MTM_RE_MONEY, function(m){
            // Standardize to $*,***.** while keeping sign and parentheses
            var isNeg = m.trim().startsWith('-$');
            var isParen = /^\(\$/.test(m.trim());
            var masked = '$*,***.**';
            if(isNeg) masked = '-'+masked;
            if(isParen) masked = '('+masked+')';
            return masked;
        });
        // Also mask plain money-like values without a leading '$' (e.g. "7,622.26").
        out = out.replace(MTM_RE_PLAIN_MONEY_GLOBAL, '*,***.**');
        return out;
    }

    // Applies current masking state to all existing .mtm-amount nodes (toggle on/off).
    function MTM_applyState(){
        const on = MTM_isActive();
        if(on) MTM_startLongTaskObserver(); else MTM_stopLongTaskObserver();
        document.body.classList.toggle('mt-obfuscate-on', on);
        if(!on) document.body.classList.remove('mtm-chart-ticks-ready');
        document.querySelectorAll('.mtm-amount').forEach(function(span){
            const orig = span.dataset.originalText || span.textContent;
            if(!span.dataset.originalText) span.dataset.originalText = orig;
            var next = on ? MTM_maskMoneyValue(orig) : orig;
            if(span.textContent !== next) { span.textContent = next; }
        });
        // State transitions are rare; always re-apply chart/input masks. The dirty
        // skip in applyAuxMasks is for the 8ms wrap-queue hot path, and it misses
        // leftover SVG originals when lastOn is already false (page pref off from settings).
        MTM_CHART_MASK.dirty = true;
        MTM_applyAuxMasks();
    }
    function MTM_nodeTouchesChart(node){
        if(!node) return false;
        if(node.nodeType === 3){
            var tp = node.parentElement;
            return !!(tp && tp.closest && tp.closest('svg, [class*="recharts-"]'));
        }
        if(!(node instanceof Element)) return false;
        if(node.closest && node.closest('svg, [class*="recharts-"]')) return true;
        if(node.querySelector && node.querySelector('svg, [class*="recharts-"]')) return true;
        return false;
    }
    function MTM_chartMutationNeedsMask(node){
        if(!node || node.nodeType !== 3) return true;
        var parent = node.parentElement;
        if(!parent || !parent.dataset || !parent.dataset.mtmChartOriginalText) return true;
        return parent.textContent !== MTM_maskMoneyValue(parent.dataset.mtmChartOriginalText);
    }
    // Masks remaining SVG currency labels not covered by wrapper logic.
    // Dirty-checked so 8ms queue slices do not walk every svg text unless charts changed.
    function MTM_maskChartDollarLabels(){
        var t0 = performance.now();
        var on = MTM_isActive();
        if(!MTM_CHART_MASK.dirty && MTM_CHART_MASK.lastOn === on){
            if(!on && document.body) document.body.classList.remove('mtm-chart-ticks-ready');
            return;
        }
        MTM_CHART_MASK.dirty = false;
        MTM_CHART_MASK.lastOn = on;
        var nodes = document.querySelectorAll('svg text, svg tspan');
        MTM_CHART_MASK.applying = true;
        try {
            for (var i=0; i<nodes.length; i++){
                var n = nodes[i];
                if(!n) continue;
                var txt = n.textContent || '';
                var orig = n.dataset && n.dataset.mtmChartOriginalText;
                if(on){
                    if(orig){
                        n.textContent = MTM_maskMoneyValue(orig);
                        continue;
                    }
                    if(!MTM_RE_CHART_DOLLAR.test(txt)) continue;
                    n.dataset.mtmChartOriginalText = txt;
                    n.textContent = MTM_maskMoneyValue(txt);
                } else if(orig){
                    n.textContent = orig;
                    delete n.dataset.mtmChartOriginalText;
                }
            }
        } finally {
            MTM_CHART_MASK.applying = false;
        }
        var maskedAny = false;
        var rawTicksRemain = false;
        if(on){
            for(var ri=0; ri<nodes.length; ri++){
                var tick = nodes[ri];
                var tickText = (tick && tick.textContent) || '';
                if(tick && tick.dataset && tick.dataset.mtmChartOriginalText) maskedAny = true;
                if(MTM_RE_CHART_DOLLAR.test(tickText)) rawTicksRemain = true;
            }
        }
        var chartHost = null;
        try { chartHost = document.querySelector('.recharts-wrapper, .recharts-yAxis-tick-labels, svg .recharts-cartesian-axis-tick-label'); } catch(e) { void e; }
        // Keep the first-paint hide up until dollar ticks exist and are masked.
        // An empty first pass used to set ready=true, so later $297.5K ticks painted raw.
        var ticksReady = false;
        if(on && !rawTicksRemain){
            ticksReady = maskedAny || !chartHost;
        }
        if(document.body) document.body.classList.toggle('mtm-chart-ticks-ready', ticksReady);
        if(on && chartHost && !maskedAny) MTM_CHART_MASK.dirty = true;
        try { window.MTM_OBF_STATS.chartLabelMs = Math.max(window.MTM_OBF_STATS.chartLabelMs || 0, performance.now() - t0); } catch(e) { void e; }
    }
    // Masks read-only/live-rendered money values exposed through form controls.
    function MTM_maskInputDollarValues(){
        var on = MTM_isActive();
        var fields = document.querySelectorAll('input, textarea');
        for (var i=0; i<fields.length; i++){
            var field = fields[i];
            if(!field) continue;
            var current = String(field.value || '');
            var orig = field.dataset && field.dataset.mtmOriginalDollarValue;
            if(on){
                if(orig){
                    field.value = MTM_maskMoneyValue(orig);
                    continue;
                }
                if(current.indexOf('$') === -1) continue;
                field.dataset.mtmOriginalDollarValue = current;
                field.value = MTM_maskMoneyValue(current);
            } else if(orig){
                field.value = orig;
                delete field.dataset.mtmOriginalDollarValue;
            }
        }
    }
    function MTM_isCurrencyNumberFlow(node){
        if(!node) return false;
        try {
            if(node.closest && node.closest('[data-external-id="animated-currency"], [class*="StatisticCard__Value-"]')) return true;
        } catch(e) { void e; }
        try {
            var raw = node.getAttribute('data') || '';
            if(raw.indexOf('"type":"currency"') !== -1) return true;
            if(raw.indexOf('"value":"$"') !== -1) return true;
        } catch(e2) { void e2; }
        var ancestor = node.parentElement;
        var depth = 0;
        while(ancestor && ancestor !== document.body && ancestor !== document.documentElement && depth < 6){
            if(ancestor.id === 'root' || (ancestor.matches && ancestor.matches('main, [class*="Scroll__Root"]'))) break;
            var text = (ancestor.textContent || '').replace(/\s+/g, ' ').trim();
            if(text.length > 400) break;
            if(/left to budget/i.test(text)) return true;
            ancestor = ancestor.parentElement;
            depth += 1;
        }
        return false;
    }
    function MTM_markBudgetNumberFlows(){
        var on = MTM_isActive();
        var flows = document.querySelectorAll('number-flow-react');
        for(var i=0; i<flows.length; i++){
            var node = flows[i];
            node.classList.toggle('mtm-mask-number-flow', !!(on && MTM_isCurrencyNumberFlow(node)));
        }
    }
    function MTM_applyAuxMasks(){
        var on = MTM_isActive();
        MTM_markBudgetNumberFlows();
        if(MTM_CHART_MASK.dirty || MTM_CHART_MASK.lastOn !== on) MTM_maskChartDollarLabels();
        if(!on && document.body) document.body.classList.remove('mtm-chart-ticks-ready');
        MTM_maskInputDollarValues();
    }
    // Wraps the first $ amount found within an element into .mtm-amount span; returns true if wrapped.
    function MTM_wrapFirstAmount(el){
        if(!el) return false;
        if(MTM_SKIP_CLOSEST && el.closest && el.closest(MTM_SKIP_CLOSEST)) return false;
        // Locate the first '$' using a TreeWalker; supports both simple and spanning cases.
        var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
            acceptNode: function(node){
                if(!node || !node.nodeValue) return NodeFilter.FILTER_SKIP;
                var p = node.parentElement;
                if(!p) return NodeFilter.FILTER_SKIP;
                if(p.closest && p.closest('.mtm-amount-wrap')) return NodeFilter.FILTER_REJECT;
                if(MTM_SKIP_CLOSEST && p.closest && p.closest(MTM_SKIP_CLOSEST)) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        });
        var startNode = null, endNode = null, startOffset = 0, endOffset = 0;
        while(walker.nextNode()){
            var txt = walker.currentNode.nodeValue || '';
            var sIdx = txt.indexOf('$');
            if(sIdx !== -1){
                startNode = walker.currentNode;
                startOffset = sIdx;
                break;
            }
        }
        if(!startNode) return false;
        // Continue from startNode to find end of amount
        var remain = startNode.nodeValue.slice(startOffset);
        var m2 = remain.match(MTM_RE_FIRST_SIMPLE);
        if(m2){ endNode = startNode; endOffset = startOffset + m2[0].length; }
        else {
            // Walk forward to find remaining part when "$" and digits are split across nodes.
            endNode = startNode; endOffset = startNode.nodeValue.length;
            var foundDigits = false;
            while(walker.nextNode()){
                var t2 = walker.currentNode.nodeValue || '';
                var mm = t2.match(/^\s*[\d,.]+/);
                if(mm){
                    foundDigits = true;
                    endNode = walker.currentNode;
                    endOffset = mm[0].length;
                    if(/[0-9]/.test(mm[0])) break;
                    continue;
                }
                if(foundDigits) break;
                if(/^\s*$/.test(t2)) continue;
                break;
            }
            if(!foundDigits) return false;
        }
        if(!startNode || !endNode) return false;
        try {
            var range = document.createRange();
            // Guard against races
            if(!startNode.isConnected || !endNode.isConnected || !el.isConnected || !el.contains(startNode) || !el.contains(endNode)) return false;
            range.setStart(startNode, startOffset);
            range.setEnd(endNode, endOffset);
            var selected = range.extractContents();
            var selectedText = selected.textContent;
            const wrap = MTM_buildWrap(selectedText);
            // Ensure trailing spacing regardless of following node
            wrap.appendChild(document.createTextNode(' '));
            // no eye; we will reveal on hover/focus
            range.insertNode(wrap);
            // If the next text starts immediately with a letter, insert a space
            var ns = wrap.nextSibling;
            if(ns && ns.nodeType === Node.TEXT_NODE){
                if(ns.nodeValue && !/^\s/.test(ns.nodeValue)){
                    ns.nodeValue = ' ' + ns.nodeValue;
                }
            }
            try{ if(window.MTM_SEEN) window.MTM_SEEN.add(el);}catch(e){ void e; }
            return true;
        } catch{
            return false;
        }
    }
    // Wraps the first money-like plain numeric value (e.g. "64,075.00") in an element.
    function MTM_wrapFirstPlainAmount(el){
        if(!el) return false;
        if(MTM_SKIP_CLOSEST && el.closest && el.closest(MTM_SKIP_CLOSEST)) return false;
        var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
            acceptNode: function(node){
                if(!node || !node.nodeValue) return NodeFilter.FILTER_SKIP;
                var p = node.parentElement;
                if(!p) return NodeFilter.FILTER_SKIP;
                if(p.closest && p.closest('.mtm-amount-wrap')) return NodeFilter.FILTER_REJECT;
                if(MTM_SKIP_CLOSEST && p.closest && p.closest(MTM_SKIP_CLOSEST)) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        });
        while(walker.nextNode()){
            var txt = walker.currentNode.nodeValue || '';
            if(txt.indexOf('$') !== -1) continue;
            var m = txt.match(MTM_RE_PLAIN_MONEY);
            if(!m) continue;
            try {
                var r = document.createRange();
                var s = m.index || 0;
                var e = s + m[0].length;
                // Do not mask integer counts like "14,256 transactions".
                if(/^\s*[A-Za-z]/.test(txt.slice(e))) continue;
                if(!walker.currentNode.isConnected || !el.isConnected || !el.contains(walker.currentNode)) return false;
                r.setStart(walker.currentNode, s);
                r.setEnd(walker.currentNode, e);
                var selected = r.extractContents();
                var wrap = MTM_buildWrap(selected.textContent || m[0]);
                wrap.appendChild(document.createTextNode(' '));
                r.insertNode(wrap);
                return true;
            } catch(e2){
                void e2;
                return false;
            }
        }
        return false;
    }
    // Wraps multiple dollar amounts in the same element (eg "$x of $y").
    function MTM_wrapAllAmounts(el, maxWraps){
        var wraps = 0;
        var cap = maxWraps || 8;
        for (var i=0; i<cap; i++){
            if(!MTM_wrapFirstAmount(el)) break;
            wraps += 1;
        }
        // Fallback for values rendered without '$' prefix (e.g. some dashboard goals/investment widgets).
        for (var j=0; j<cap; j++){
            if(!MTM_wrapFirstPlainAmount(el)) break;
            wraps += 1;
        }
        return wraps;
    }
    function MTM_isSplitDollarPart(el) {
        if(!el || !el.parentElement) return false;
        var own = (el.textContent || '').replace(/\s+/g, '');
        if(own !== '$' && !/^[\d,.]+$/.test(own)) return false;
        var parent = el.parentElement;
        var joined = (parent.textContent || '').replace(/\s+/g, '');
        return parent.childNodes.length > 1 && /^\$[\d,]+(?:\.\d+)?$/.test(joined);
    }
    // Builds and returns the wrapper span structure for a masked amount.
    function MTM_buildWrap(amountText){
        const wrap = document.createElement('span');
        wrap.className = 'mtm-amount-wrap';
        const amt = document.createElement('span');
        amt.className = 'mtm-amount';
        amt.dataset.originalText = amountText;
        amt.textContent = MTM_isObfEnabled() ? MTM_maskMoneyValue(amountText) : amountText;
        wrap.appendChild(amt);
        return wrap;
    }
    // Finds leaf-ish elements with '$' in text and no nested '$' descendants.
    function MTM_collectDollarLeafCandidates(scope, max){
        var cap = (typeof max === 'number' && max > 0) ? max : 5000;
        var leafSel = 'span, div, p, td, th, li, a, h1, h2, h3, h4, h5, button, strong, em, b, label, small';
        var widgetSel = '[class*="group/dashboard-widget"], [class*="Card__CardRoot"], [class*="DashboardWidget__Description-"], [class*="CardTitle-"], [class*="DashboardWidget__Title-"]';
        function collectFrom(root, limit){
            var out = [];
            if(!root || !root.querySelectorAll || limit <= 0) return out;
            var pool = [];
            if(root.nodeType === 1 && root.matches && root.matches(leafSel)) pool.push(root);
            var descendants = root.querySelectorAll(leafSel);
            for(var di=0; di<descendants.length; di++) pool.push(descendants[di]);
            for (var i=0; i<pool.length; i++){
                var el = pool[i];
                if(!el || !MTM_shouldProcess(el)) continue;
                if(MTM_SKIP_CLOSEST && el.closest && el.closest(MTM_SKIP_CLOSEST)) continue;
                if(MTM_isSplitDollarPart(el)) continue;
                var txt = el.textContent || '';
                if(!MTM_hasMaskableText(txt)) continue;
                // Avoid wrapping container nodes when a deeper node already carries the dollar value.
                var childHasDollar = false;
                try {
                    if(el.children && el.children.length){
                        for (var ci=0; ci<el.children.length; ci++){
                            var child = el.children[ci];
                            if(MTM_SKIP_CLOSEST && child && child.closest && child.closest(MTM_SKIP_CLOSEST)) continue;
                            var ct = child && child.textContent || '';
                            if(MTM_hasMaskableText(ct)){ childHasDollar = true; break; }
                        }
                    }
                } catch(e) { void e; }
                if(childHasDollar) continue;
                out.push(el);
                if(out.length >= limit) break;
            }
            return out;
        }
        var out = collectFrom(scope, cap);
        var firstPassCapped = out.length >= cap;
        var fallback = null;
        if(firstPassCapped){
            try {
                var main = document.querySelector('main');
                if(main && main !== scope && MTM_isScopeEligible(main)) fallback = main;
                if(!fallback){
                    var appRoot = document.querySelector('#root');
                    if(appRoot && appRoot !== scope && MTM_isScopeEligible(appRoot)) fallback = appRoot;
                }
            } catch(e) { void e; }
            if(fallback) out = collectFrom(fallback, cap);
        }
        // A capped generic leaf pass can still starve known dashboard widgets. Give their
        // descriptions/titles a bounded second chance, while retaining the normal cap.
        if(firstPassCapped){
            var seen = new Set();
            for(var oi=0; oi<out.length; oi++) seen.add(out[oi]);
            var widgetRoots = [];
            function addWidgetRoots(root){
                if(!root || !root.querySelectorAll) return;
                if(root.nodeType === 1 && root.matches && root.matches(widgetSel) && widgetRoots.indexOf(root) === -1){
                    widgetRoots.push(root);
                }
                var matches = root.querySelectorAll(widgetSel);
                for(var wi=0; wi<matches.length; wi++){
                    if(widgetRoots.indexOf(matches[wi]) === -1) widgetRoots.push(matches[wi]);
                }
            }
            addWidgetRoots(scope);
            if(fallback && fallback !== scope) addWidgetRoots(fallback);
            var extraCount = 0;
            var extraCap = 500;
            for(var ri=0; ri<widgetRoots.length && extraCount < extraCap; ri++){
                var widgetLeaves = collectFrom(widgetRoots[ri], extraCap - extraCount);
                for(var li=0; li<widgetLeaves.length && extraCount < extraCap; li++){
                    var leaf = widgetLeaves[li];
                    if(seen.has(leaf)) continue;
                    seen.add(leaf);
                    out.push(leaf);
                    extraCount += 1;
                }
            }
        }
        return out;
    }
    // Scans allowed containers (or a given root) and wraps simple currency occurrences once.
    function MTM_scanAndWrap(root){
        if (!MTM_isActive()) return;
        MTM_startLongTaskObserver();
        var scanStart = performance.now();
        try { window.MTM_OBF_STATS.scanRuns += 1; } catch(e) { void e; }
        var routePath = window.location.pathname || '';
        if(MTM_CHART_MASK.route !== routePath) MTM_CHART_MASK.route = routePath;
        MTM_markChartLabelsDirty();
        const scopes = root ? [root] : MTM_findScopes();
        scopes.forEach(function(scope){
            // Primary: target Monarch's FullStory privacy-marked nodes (fs-exclude/fs-mask) that actually contain '$'
            var candidates = scope.querySelectorAll('.fs-exclude, .fs-mask');
            for (var ci=0; ci<candidates.length; ci++){
                var el = candidates[ci];
                try { window.MTM_OBF_STATS.candidatesSeen += 1; } catch(e) { void e; }
                if(!MTM_shouldProcess(el)) continue;
                if(MTM_SKIP_CLOSEST && el.closest && el.closest(MTM_SKIP_CLOSEST)) continue;
                var txt = el.textContent || '';
                if(!MTM_hasMaskableText(txt)) continue;
                try { window.MTM_OBF_STATS.watched += 1; } catch(e) { void e; }
                MTM_watch(el);
            }
            // Fallback for account details pages where amounts may not be marked fs-exclude
            var path = routePath;
            if(/^\/accounts(?:\/|$)/.test(path)){
                var extra = Array.from(scope.querySelectorAll('[class*="Card__CardRoot-"] .Text-qcxgyd-0, [class*="Card__CardRoot-"] .Summary__SummaryValue, [class*="AccountSummaryCardGroup__"] .fs-exclude, [class*="AccountGroupCard__Content-"] .fs-exclude, [class*="AccountBalanceIndicator__Root-"] .fs-exclude'))
                    .filter(function(el){ return /\$/.test(el.textContent || '') && !el.querySelector('.mtm-amount') && !el.closest('.mtm-amount-wrap'); });
                for (var i=0;i<extra.length && i<300; i++) { MTM_watch(extra[i]); }
            }
            if(/^\/dashboard(?:\/|$)/.test(path)){
                var dashCandidates = Array.from(scope.querySelectorAll(MTM_DASH_SEL));
                var dash = dashCandidates.filter(function(el){
                    if(el.closest && el.closest('.mtm-amount-wrap')) return false;
                    // A sibling/child trend wrap (.mtm-amount / .fs-exclude) must not skip the title amount.
                    return MTM_hasUnwrappedDollarText(el);
                });
                for (var di=0; di<dash.length; di++) { MTM_wrapNow(dash[di]); }
                MTM_wrapDashboardHeaders(scope);
            }
            // Leaf collection on every allowed route so $35 / $0.00 in buttons, strong, labels, etc. get wrapped.
            if(MTM_isRouteAllowed()){
                var moneyLeaves = MTM_collectDollarLeafCandidates(scope, /^\/dashboard(?:\/|$)/.test(path) ? 5000 : 2500);
                for (var gi=0; gi<moneyLeaves.length; gi++) { MTM_watch(moneyLeaves[gi]); }
            }
            if(/^\/(?:plan|budget)(?:\/|$)/.test(path)){
                // Plan table often splits "$" and number into sibling nodes; include compact containers directly.
                var planExtra = Array.from(scope.querySelectorAll('div, span, p, td, th')).filter(function(el){
                    if(!MTM_shouldProcess(el)) return false;
                    if(MTM_SKIP_CLOSEST && el.closest && el.closest(MTM_SKIP_CLOSEST)) return false;
                    var t = (el.textContent || '').replace(/\s+/g, '');
                    if(!MTM_hasMaskableText(t)) return false;
                    if(MTM_isSplitDollarPart(el)) return false;
                    return t.length > 1 && t.length <= 40;
                });
                for (var pi=0; pi<planExtra.length && pi<350; pi++) { MTM_watch(planExtra[pi]); }
            }
        });
        MTM_applyAuxMasks();
        try { window.MTM_OBF_STATS.scanMs = performance.now() - scanStart; } catch(e) { void e; }
    }
    // MutationObserver wiring: enqueues relevant added/updated nodes and batches processing.
    (function MTM_Observer(){
        if (window.MTM_OBF_OBSERVER_API_WIRED) return;
        window.MTM_OBF_OBSERVER_API_WIRED = true;

        // Starts scoped observers if masking is enabled and route is allowed.
        window.MTM_startObserver = function(){
            window.MTM_stopObserver();
            if(!MTM_isActive()) return;
            MTM_startLongTaskObserver();
            MTM_markChartLabelsDirty();
            MTM_markBudgetNumberFlows();
            try { window.MTM_OBF_STATS.observerStarts += 1; } catch(e) { void e; }

            var scopes = MTM_findScopes();
            MTM_SCOPE_FP = MTM_scopeFingerprint();
            window.MTM_OBF_OBSERVERS = [];
            // Always observe the document root too. Dashboard widgets often mount in a
            // replacement Scroll__Root after the first scoped observer was attached.
            var docRoot = document.documentElement || document;
            if(scopes.indexOf(docRoot) === -1 && scopes.indexOf(document) === -1) scopes.push(docRoot);

            scopes.forEach(function(scope){
                var observer = new MutationObserver(function(mutations){
                    var path = window.location.pathname;
                    var chartDirty = false;
                    var dashDirty = false;
                    for (var i=0; i<mutations.length; i++){
                        var m = mutations[i];
                        if(m.type === 'childList'){
                            for (var j=0; j<m.addedNodes.length; j++){
                                var node = m.addedNodes[j];
                                if(MTM_nodeTouchesChart(node) && MTM_chartMutationNeedsMask(node)){
                                    MTM_markChartLabelsDirty();
                                    chartDirty = true;
                                }
                                // React often hydrates "$N investments" by replacing a Text node, not an Element.
                                if(!(node instanceof Element)){
                                    if(/^\/dashboard(?:\/|$)/.test(path) && node && node.nodeType === 3){
                                        dashDirty = true;
                                        MTM_wrapDashHostFromNode(node);
                                    }
                                    continue;
                                }
                                if(node.matches && node.matches('.fs-exclude, .fs-mask')){
                                    if(MTM_shouldProcess(node)){
                                        if(MTM_SKIP_CLOSEST && node.closest && node.closest(MTM_SKIP_CLOSEST)) { continue; }
                                        var t0 = node.textContent || '';
                                        if(MTM_hasMaskableText(t0)) { if(window.MTM_IO) { MTM_watch(node); } else { MTM_enqueue(node); } }
                                    }
                                }
                                if(node.querySelectorAll){
                                    var list = node.querySelectorAll('.fs-exclude, .fs-mask');
                                    for(var k=0; k<list.length; k++) {
                                        if(!MTM_shouldProcess(list[k])) continue;
                                        if(MTM_SKIP_CLOSEST && list[k].closest && list[k].closest(MTM_SKIP_CLOSEST)) continue;
                                        var t1 = list[k].textContent || '';
                                        if(!MTM_hasMaskableText(t1)) continue;
                                        if(window.MTM_IO) { MTM_watch(list[k]); } else { MTM_enqueue(list[k]); }
                                    }
                                }
                                // Also handle dashboard non-fs-exclude currency nodes that load late
                                if(/^\/dashboard(?:\/|$)/.test(path)){
                                    dashDirty = true;
                                    if(node.matches && node.matches(MTM_DASH_SEL)) MTM_wrapNow(node);
                                    if(node.querySelectorAll){
                                        var dqs = node.querySelectorAll(MTM_DASH_SEL);
                                        for(var dk=0; dk<dqs.length; dk++) MTM_wrapNow(dqs[dk]);
                                    }
                                }
                                if(MTM_isRouteAllowed() && node.querySelectorAll){
                                    var leaves = MTM_collectDollarLeafCandidates(node, 2500);
                                    for(var li=0; li<leaves.length; li++){ if(MTM_shouldProcess(leaves[li])) { if(window.MTM_IO) { MTM_watch(leaves[li]); } else { MTM_enqueue(leaves[li]); } } }
                                }
                                if(/^\/(?:plan|budget)(?:\/|$)/.test(path) && node.querySelectorAll){
                                    var pextra = [];
                                    if(node.matches && node.matches('div, span, p, td, th')) pextra.push(node);
                                    var pdesc = node.querySelectorAll('div, span, p, td, th');
                                    for(var pd=0; pd<pdesc.length; pd++) pextra.push(pdesc[pd]);
                                    for(var px=0; px<pextra.length && px<180; px++){
                                        var pe = pextra[px];
                                        if(!MTM_shouldProcess(pe)) continue;
                                        var pt = (pe.textContent || '').replace(/\s+/g, '');
                                        if(!MTM_hasMaskableText(pt)) continue;
                                        if(pt.length <= 1 || pt.length > 40) continue;
                                        if(MTM_isSplitDollarPart(pe)) continue;
                                        if(window.MTM_IO) { MTM_watch(pe); } else { MTM_enqueue(pe); }
                                    }
                                }
                            }
                        } else if(m.type === 'characterData'){
                            if(MTM_nodeTouchesChart(m.target) && MTM_chartMutationNeedsMask(m.target)){
                                MTM_markChartLabelsDirty();
                                chartDirty = true;
                            }
                            var p = m.target && m.target.parentElement;
                            if(p){
                                // Ignore our own text swaps (hover reveal / applyState) to avoid observer churn.
                                if(p.closest && p.closest('.mtm-amount-wrap')) { continue; }
                                if(p.closest && p.closest('svg, [class*="recharts-"]')) { continue; }
                                // Early bail when updated text has no maskable token.
                                if(m.target && typeof m.target.nodeValue === 'string' && !MTM_hasMaskableText(m.target.nodeValue)) { continue; }
                                var host = p.matches('.fs-exclude, .fs-mask') ? p : p.closest('.fs-exclude, .fs-mask');
                                if(host && MTM_shouldProcess(host)) { if(window.MTM_IO) { MTM_watch(host); } else { MTM_enqueue(host); } }
                                if(/^\/dashboard(?:\/|$)/.test(path)){
                                    dashDirty = true;
                                    var dashHost = p.matches(MTM_DASH_SEL) ? p : p.closest(MTM_DASH_SEL);
                                    if(dashHost) MTM_wrapNow(dashHost);
                                }
                                if(!host && MTM_isRouteAllowed()){
                                    if(p && MTM_shouldProcess(p)) { if(window.MTM_IO) { MTM_watch(p); } else { MTM_enqueue(p); } }
                                }
                            }
                        }
                    }
                    if(chartDirty) MTM_applyAuxMasks();
                    if(dashDirty) MTM_wrapDashboardHeaders(document);
                    if(MTM_isActive()) MTM_markBudgetNumberFlows();
                    // Only schedule processing if there is queued work; IntersectionObserver will schedule on intersect.
                    if(window.MTM_OBF_PENDING && window.MTM_OBF_PENDING.size > 0) MTM_scheduleProcessQueue();
                });

                observer.observe(scope, { childList: true, subtree: true, characterData: true, characterDataOldValue: false });
                window.MTM_OBF_OBSERVERS.push(observer);
            });
            MTM_ensureScopeWatch();
        };
        function MTM_ensureScopeWatch(){
            if(MTM_TEST_MODE) return;
            if(window.MTM_SCOPE_WATCH) return;
            var timer = null;
            var obs = new MutationObserver(function(){
                if(!MTM_isActive()) return;
                if(timer) clearTimeout(timer);
                timer = setTimeout(function(){
                    timer = null;
                    var fp = MTM_scopeFingerprint();
                    if(fp === MTM_SCOPE_FP) return;
                    MTM_SCOPE_FP = fp;
                    window.MTM_restartObserver();
                    MTM_scanAndWrap();
                }, 250);
            });
            try { obs.observe(document.documentElement || document.body, { childList: true, subtree: true }); } catch(e) { void e; }
            window.MTM_SCOPE_WATCH = obs;
        }
        // Disconnects all observers and clears state.
        window.MTM_stopObserver = function(){
            if(window.MTM_OBF_OBSERVERS){
                window.MTM_OBF_OBSERVERS.forEach(function(o){ try{o.disconnect();}catch{ /* ignore */ } });
            }
            window.MTM_OBF_OBSERVERS = [];
            try { window.MTM_OBF_STATS.observerStops += 1; } catch(e) { void e; }
            // Ensure OFF (or unsupported routes) truly idle: clear pending work and disconnect IO targets.
            if(!MTM_isActive()){
                try { window.MTM_OBF_PENDING.clear(); } catch(e) { void e; }
                window.MTM_OBF_SCHEDULED = false;
                try { if(window.MTM_IO) window.MTM_IO.disconnect(); } catch(e) { void e; }
                MTM_stopLongTaskObserver();
            }
        };
        // Restarts observers (used after route transitions and toggles).
        window.MTM_restartObserver = function(){
            window.MTM_stopObserver();
            window.MTM_startObserver();
        };
    })();
    // Hover-to-reveal: shows the original amount on hover, remasks on mouseleave; respects setting.
    (function MTM_wireHoverReveal(){
        if (MTM_TEST_MODE) return;
        if (window.MTM_OBF_HOVER_WIRED) return;
        window.MTM_OBF_HOVER_WIRED = true;

        function reveal(amt){ if(!amt) return; amt.textContent = amt.dataset.originalText || amt.textContent; }
        function remask(amt){ if(!amt) return; if(MTM_isObfEnabled()) amt.textContent = MTM_maskMoneyValue(amt.dataset.originalText || amt.textContent); }

        document.addEventListener('mouseenter', function(e){
            var t = e.target;
            if(!(t instanceof Element)) return;
            if(!t.classList.contains('mtm-amount')) return;
            reveal(t);
        }, true);
        document.addEventListener('mouseleave', function(e){
            var t = e.target;
            if(!(t instanceof Element)) return;
            if(!t.classList.contains('mtm-amount')) return;
            remask(t);
        }, true);

        // Keep settings change handler
        document.addEventListener('change', function(e){
            var t = e.target;
            if(!(t instanceof Element)) return;
            if(t.id === 'MT_HideSensitiveInfo'){
                MTM_onPrefsChanged();
            }
        });
    })();

    // Lifecycle wiring: initial/burst scans and observer restarts across SPA navigation and load.
    (function MTM_wireLifecycle(){
        if (MTM_TEST_MODE) return;
        if (window.MTM_OBF_LIFE_WIRED) return;
        window.MTM_OBF_LIFE_WIRED = true;

        function run(){ MTM_scanAndWrap(); MTM_applyState(); }
        function runBurst(){
            // Cold dashboard widgets (investments title, net-worth ticks) often hydrate after 300ms.
            [0, 150, 300, 600, 1200, 3000].forEach(function(d){
                setTimeout(function(){
                    run();
                    if(MTM_isActive() && window.MTM_restartObserver){
                        var fp = MTM_scopeFingerprint();
                        if(fp !== MTM_SCOPE_FP || !window.MTM_OBF_OBSERVERS || !window.MTM_OBF_OBSERVERS.length){
                            MTM_SCOPE_FP = fp;
                            window.MTM_restartObserver();
                        }
                    } else if(window.MTM_stopObserver) {
                        window.MTM_stopObserver();
                    }
                }, d);
            });
            MTM_scheduleIdleCatchup();
        }
        function bootstrap(){
            runBurst();
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', bootstrap);
        } else {
            bootstrap();
        }

        var _ps = history.pushState;
        history.pushState = function(){
            var r = _ps.apply(this, arguments);
            setTimeout(runBurst, 0);
            return r;
        };
        var _rs = history.replaceState;
        history.replaceState = function(){
            var r = _rs.apply(this, arguments);
            setTimeout(runBurst, 0);
            return r;
        };
        window.addEventListener('popstate', function(){ setTimeout(runBurst, 0); });
        window.addEventListener('load', function(){ setTimeout(runBurst, 0); });

        var scrollTimer = null;
        window.addEventListener('scroll', function(){
            if(!MTM_isActive()) return;
            if(scrollTimer) clearTimeout(scrollTimer);
            scrollTimer = setTimeout(function(){ MTM_scanAndWrap(); }, 250);
        }, {passive:true});
    })();

    // Sidebar toggle injection: adds a nav item that flips masking on/off persistently.
    (function MTM_SideNavToggle(){
        // In test mode, we export the ensure() helper and avoid timers/observers that keep the event loop alive.
        if (window.MTM_OBF_SIDENAV_WIRED) return;
        window.MTM_OBF_SIDENAV_WIRED = true;
        function MTM_parsePath(href){
            try { return new URL(href || '', window.location.origin).pathname || ''; } catch(e) { void e; return ''; }
        }
        function MTM_isPrimaryNavHref(href){
            var p = MTM_parsePath(href);
            return /^\/(?:dashboard|accounts|transactions|cash-flow|reports|budget|recurring|goals|investments|forecast|advice)(?:\/|$)/.test(p);
        }
        function MTM_collectPrimaryNavLinks(root){
            if(!root) return [];
            var out = [];
            var all = root.querySelectorAll('a[href]');
            for (var i=0; i<all.length; i++){
                var a = all[i];
                if(!MTM_isPrimaryNavHref(a.getAttribute('href'))) continue;
                out.push(a);
            }
            return out;
        }
        function MTM_countDistinctPrimaryRoutes(links, root){
            var seen = Object.create(null);
            for(var i=0; i<links.length; i++){
                if(root && !root.contains(links[i])) continue;
                var path = MTM_parsePath(links[i].getAttribute('href'));
                if(path) seen[path.split('/').slice(0, 2).join('/')] = true;
            }
            return Object.keys(seen).length;
        }
        function MTM_isInsideMain(el){
            if(!el || !el.closest) return false;
            if(el.tagName === 'MAIN' || (el.matches && el.matches('main'))) return true;
            return !!el.closest('main');
        }
        function MTM_isInSidebar(el){
            if(!el) return false;
            if(el.matches && el.matches('[class*="SideBar__"]')) return true;
            return !!(el.closest && el.closest('[class*="SideBar__"]'));
        }
        function MTM_hasLabeledDashboardAndAccounts(root){
            if(!root || !root.querySelectorAll) return false;
            var links = root.querySelectorAll('a[href]');
            var hasDash = false, hasAcct = false;
            for(var i=0;i<links.length;i++){
                var a = links[i];
                var path = MTM_parsePath(a.getAttribute('href'));
                var label = ((a.getAttribute('aria-label') || '') + ' ' + (a.textContent || '')).toLowerCase();
                if(path.indexOf('/dashboard') === 0 || label.indexOf('dashboard') !== -1) hasDash = true;
                if(path.indexOf('/accounts') === 0 || label.indexOf('accounts') !== -1) hasAcct = true;
                if(hasDash && hasAcct) return true;
            }
            return false;
        }
        function MTM_candidateBeats(next, best){
            if(!best) return true;
            if(next.inSidebar !== best.inSidebar) return next.inSidebar;
            if(next.hasPair !== best.hasPair) return next.hasPair;
            if(next.density !== best.density) return next.density > best.density;
            if(next.routes !== best.routes) return next.routes > best.routes;
            if(next.desc !== best.desc) return next.desc < best.desc;
            return next.hops < best.hops;
        }
        // Finds the tightest ancestor containing a real primary-nav group. Prefer a SideBar
        // ancestor that contains labeled Dashboard AND Accounts links; never return <main>.
        function MTM_findPrimaryNavListInRoot(searchRoot){
            if(!searchRoot) return null;
            var links = MTM_collectPrimaryNavLinks(searchRoot);
            if(!links.length) return null;
            var best = null;
            var bestMeta = null;
            for (var li=0; li<links.length; li++){
                var p = links[li].parentElement;
                var hops = 0;
                while(p && p !== searchRoot && hops < 9){
                    if(!MTM_isInsideMain(p)){
                        var routeCount = MTM_countDistinctPrimaryRoutes(links, p);
                        if(routeCount >= 2){
                            var desc = 0;
                            try { desc = p.querySelectorAll('a[href]').length; } catch(e2) { void e2; }
                            var meta = {
                                inSidebar: MTM_isInSidebar(p),
                                hasPair: MTM_hasLabeledDashboardAndAccounts(p),
                                density: routeCount / Math.max(desc, 1),
                                routes: routeCount,
                                desc: desc,
                                hops: hops
                            };
                            if(MTM_candidateBeats(meta, bestMeta)){
                                best = p;
                                bestMeta = meta;
                            }
                        }
                    }
                    p = p.parentElement;
                    hops++;
                }
            }
            return best;
        }
        function MTM_findPrimaryNavList(sidebarRoot, sideContent){
            var sidebarShell = sidebarRoot || document.querySelector('[class*="SideBar__"]');
            if(sidebarShell && !MTM_isInsideMain(sidebarShell)){
                var fromSidebar = MTM_findPrimaryNavListInRoot(sidebarShell);
                if(fromSidebar && MTM_hasLabeledDashboardAndAccounts(fromSidebar)) return fromSidebar;
                if(fromSidebar) return fromSidebar;
            }
            return MTM_findPrimaryNavListInRoot(sideContent || sidebarRoot || document);
        }

        function MTM_findSidebarFlyout(navList){
            var el = navList;
            for(var i=0; i<10 && el; i++){
                var cls = '';
                try { cls = String(el.className || ''); } catch(e) { void e; }
                // The overlay uses w-(--sidebar-width) and grows 52→240. Do not use
                // min-w-(--sidebar-expanded-width); that inner column stays ~224px even when clipped.
                if(/(?:^|\s)w-\(--sidebar-width\)/.test(cls) || cls.indexOf(' flex w-(--sidebar-width)') !== -1 || cls.indexOf('w-(--sidebar-width)') !== -1){
                    if(cls.indexOf('min-w-(--sidebar-expanded-width)') === -1) return el;
                }
                el = el.parentElement;
            }
            return null;
        }
        function MTM_isNavCollapsed(navList, sidebarRoot, firstLink){
            var rail = sidebarRoot;
            var aria = rail && rail.getAttribute && rail.getAttribute('aria-expanded');
            if(aria === 'true') return false;
            var flyout = MTM_findSidebarFlyout(navList);
            var width = 0;
            try { width = (flyout || rail || navList).getBoundingClientRect().width; } catch(e) { void e; }
            if(width >= 160) return false;
            if(aria === 'false') return true;
            if(width > 0 && width < 120) return true;
            if(rail && rail.classList && rail.classList.contains('sidebar-collapsed')) return true;
            var sourceText = ((firstLink && firstLink.textContent) || '').replace(/\s+/g, '').trim();
            return !sourceText;
        }
        function MTM_syncSideNavChrome(link, firstLink){
            if(!link) return;
            var title = link.querySelector('.mtm-nav-title');
            if(title){
                var nativeLabel = firstLink && firstLink.querySelector('.hidden.truncate, [class*="in-aria-expanded"]');
                title.className = nativeLabel && nativeLabel.className
                    ? ('mtm-nav-title ' + String(nativeLabel.className))
                    : 'mtm-nav-title hidden truncate in-aria-expanded:inline-block';
            }
            var iconWrap = link.querySelector('.mtm-nav-iconwrap');
            var nativeIcon = firstLink && firstLink.querySelector('[class*="LinkIcon"]');
            if(iconWrap && nativeIcon && nativeIcon.className){
                iconWrap.className = String(nativeIcon.className) + ' mtm-nav-iconwrap';
            }
        }
        function MTM_bindSideNavGuards(navList, link, sidebarRoot, firstLink){
            try { if(window.MTM_SIDENAV_ORDER_OBS) window.MTM_SIDENAV_ORDER_OBS.disconnect(); } catch{ /* ignore */ }
            try { if(window.MTM_SIDENAV_COLLAPSE_OBS) window.MTM_SIDENAV_COLLAPSE_OBS.disconnect(); } catch{ /* ignore */ }
            try { if(window.MTM_SIDENAV_RESIZE_OBS) window.MTM_SIDENAV_RESIZE_OBS.disconnect(); } catch{ /* ignore */ }

            var orderObs = new MutationObserver(function(){
                var last = navList.lastElementChild;
                if(last && last.id !== 'mtm-obf-master') { navList.appendChild(link); }
            });
            orderObs.observe(navList, { childList: true });
            window.MTM_SIDENAV_ORDER_OBS = orderObs;

            sidebarRoot = sidebarRoot || (firstLink && firstLink.closest && firstLink.closest('.SideBar__Root-sc-161w9oi-0, [class*="SideBar__Root-"], [class*="SideBar__Root"], [class*="sidebar-collapsed-width"]')) || document.querySelector('.SideBar__Root-sc-161w9oi-0, [class*="SideBar__Root-"], [class*="SideBar__Root"], [class*="sidebar-collapsed-width"]') || navList;
            var flyout = MTM_findSidebarFlyout(navList);
            var setCollapsed = function(){
                link.classList.toggle('mtm-nav-collapsed', MTM_isNavCollapsed(navList, sidebarRoot, firstLink));
            };
            setCollapsed();
            var observed = [];
            function observeNode(node){
                if(!node || node.nodeType !== 1 || observed.indexOf(node) !== -1) return;
                observed.push(node);
            }
            observeNode(sidebarRoot);
            observeNode(flyout);
            observeNode(navList);
            if(observed.length){
                var collapseObs = new MutationObserver(function(){ setCollapsed(); });
                for(var oi=0; oi<observed.length; oi++){
                    try { collapseObs.observe(observed[oi], { attributes: true, attributeFilter: ['class', 'style', 'aria-expanded', 'data-pinned'] }); } catch(e) { void e; }
                }
                window.MTM_SIDENAV_COLLAPSE_OBS = collapseObs;
                if(typeof ResizeObserver !== 'undefined'){
                    var resizeObs = new ResizeObserver(function(){ setCollapsed(); });
                    for(var ri=0; ri<observed.length; ri++){
                        try { resizeObs.observe(observed[ri]); } catch(e2) { void e2; }
                    }
                    window.MTM_SIDENAV_RESIZE_OBS = resizeObs;
                }
            }
        }

        function ensure(){
            // Insert as a native nav item at the end of the primary list
            var sidebarRoot = document.querySelector('[class*="SideBar__Root-"], [class*="SideBar__Root"], .SideBar__Root-sc-161w9oi-0, [class*="sidebar-collapsed-width"]');
            var sideContent = sidebarRoot && (sidebarRoot.querySelector('[class*="SideBar__Content-"], [class*="SideBar__Content"], .SideBar__Content-sc-161w9oi-4') || null);
            var navList = MTM_findPrimaryNavList(sidebarRoot, sideContent);
            var firstLink = null;
            var navLinks = MTM_collectPrimaryNavLinks(navList || sideContent || sidebarRoot || document);
            for (var ni=0; ni<navLinks.length; ni++){
                if(MTM_parsePath(navLinks[ni].getAttribute('href')) === '/dashboard'){ firstLink = navLinks[ni]; break; }
            }
            if(!firstLink && navLinks.length) firstLink = navLinks[0];
            if(!firstLink){
                var fallbackLinks = MTM_collectPrimaryNavLinks(sideContent || sidebarRoot || document);
                if(fallbackLinks.length) firstLink = fallbackLinks[0];
            }
            if(!firstLink && !navList) return;
            if(!navList && firstLink) navList = firstLink.parentElement;
            // Fallback walk-up only when our strict detector did not find a stable primary list.
            if(!MTM_findPrimaryNavList(sidebarRoot, sideContent)){
                var hops = 0;
                while(navList && sideContent && navList !== sideContent && hops < 6){
                    var count = 0;
                    try { count = MTM_collectPrimaryNavLinks(navList).length; } catch(e3) { void e3; }
                    if(count >= 4) break;
                    navList = navList.parentElement;
                    hops++;
                }
            }
            if(!navList || MTM_isInsideMain(navList)) return;

            var existing = document.getElementById('mtm-obf-master');
            if(existing){
                existing.style.order = '9999';
                if(existing.parentElement !== navList || navList.lastElementChild !== existing){
                    navList.appendChild(existing);
                }
                MTM_syncSideNavChrome(existing, firstLink);
                MTM_bindSideNavGuards(navList, existing, sidebarRoot, firstLink);
                return;
            }

            var link = document.createElement('a');
            link.id = 'mtm-obf-master';
            link.href = '#';
            link.setAttribute('role','button');
            // Prefer copying Monarch's current nav link className to match styling (styled-components hashes can change).
            // Fallback to a known-good class list from snapshots if className is missing.
            link.className = (firstLink && firstLink.className) ? firstLink.className : 'NavLink-sc-1bdi3x9-0 jwNjNr NavBarLink__Container-sc-1xv1ifc-3 dFxBOe NavBarLink-sc-1xv1ifc-4 gmbciN';
            try {
                link.className = link.className.split(/\s+/).filter(function(cls){
                    if(!cls) return false;
                    if(cls === 'nav-item-active' || cls === 'active') return false;
                    if(cls.indexOf('in-aria-') !== -1) return false;
                    return true;
                }).join(' ');
            } catch(e) { void e; }
            link.setAttribute('data-state','closed');
            // Always keep as last item of the primary group
            link.style.order = '9999';

            var iconWrap = document.createElement('span');
            iconWrap.classList.add('mtm-nav-iconwrap');
            var nativeIcon = firstLink && firstLink.querySelector('[class*="LinkIcon"]');
            if(nativeIcon && nativeIcon.className){
                iconWrap.className = String(nativeIcon.className) + ' mtm-nav-iconwrap';
            }
            var iconSpan = document.createElement('span');
            iconSpan.className = '';
            iconSpan.classList.add('mtm-eye-icon');
            function setIcon(on){
                iconSpan.innerHTML = on
                    ? '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" stroke="currentColor" stroke-width="2"/><path d="M22 2 2 22" stroke="currentColor" stroke-width="2"/></svg>'
                    : '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/></svg>';
                link.setAttribute('aria-pressed', on ? 'true' : 'false');
                link.setAttribute('aria-label', on ? 'Show balances' : 'Obfuscate balances');
                link.title = on ? 'Show balances' : 'Obfuscate balances';
            }
            setIcon(MTM_isObfEnabled());
            iconWrap.appendChild(iconSpan);

            var title = document.createElement('span');
            title.className = 'mtm-nav-title hidden truncate in-aria-expanded:inline-block';
            title.textContent = 'Obfuscate Balances';

            link.appendChild(iconWrap);
            link.appendChild(title);
            link.addEventListener('click', function(e){
                e.preventDefault();
                setCookie('MT_HideSensitiveInfo', MTM_isObfEnabled() ? 0 : 1);
                MTM_onPrefsChanged();
                setIcon(MTM_isObfEnabled());
            });

            navList.appendChild(link);
            MTM_bindSideNavGuards(navList, link, sidebarRoot, firstLink);
        }

        var ensureTimer = null;
        function scheduleEnsure(delay){
            if(ensureTimer) clearTimeout(ensureTimer);
            ensureTimer = setTimeout(function(){
                ensureTimer = null;
                ensure();
            }, delay || 0);
        }

        window.MTM_OBF_ENSURE_SIDENAV = ensure;
        if(MTM_TEST_MODE) return;
        // Try repeatedly as sidebar mounts/re-renders. Keep window long enough for slow auth/data loads.
        scheduleEnsure(0);
        var tries = 0; var intv = setInterval(function(){
            tries++; ensure(); if(tries > 120) clearInterval(intv);
        }, 500);
        // Re-ensure after route changes and late-rendered sidebar shells.
        window.addEventListener('load', function(){ scheduleEnsure(250); });
        window.addEventListener('popstate', function(){ scheduleEnsure(250); });
        var _ps2 = history.pushState;
        history.pushState = function(){
            var r = _ps2.apply(this, arguments);
            scheduleEnsure(250);
            return r;
        };
        var _rs2 = history.replaceState;
        history.replaceState = function(){
            var r = _rs2.apply(this, arguments);
            scheduleEnsure(250);
            return r;
        };
        var ensureObs = new MutationObserver(function(){
            scheduleEnsure(200);
        });
        try { ensureObs.observe(document.documentElement || document.body, { childList: true, subtree: true }); } catch(e) { void e; }
    })();

    // Dedicated settings pane: controls which supported page families use the
    // sidebar's global obfuscation switch. This pane itself is never obfuscated.
    (function MTM_SettingsPane(){
        if(window.MTM_OBF_SETTINGS_WIRED) return;
        window.MTM_OBF_SETTINGS_WIRED = true;

        var CARD_ID = 'mtm-obf-settings';
        var PANE_ID = 'mtm-obf-settings-pane';
        var CARD_SELECTOR = '[class*="Card__CardRoot"], [class*="CardRoot-"], [class*="CardRoot"]';
        var OBFUSCATION_RE = /^\/settings\/obfuscation(?:\/|$)/;
        var SETTINGS_RE = /^\/settings(?:\/|$)/;
        var NAV_ID = 'mtm-obf-settings-nav';
        var NAV_HREF = '/settings/obfuscation';
        var ensureTimer = null;
        var lastAnchorTarget = '';
        var settingsObs = null;

        function isSettingsRoute(){
            return SETTINGS_RE.test((window.location && window.location.pathname) || '');
        }
        function isObfuscationRoute(){
            return OBFUSCATION_RE.test((window.location && window.location.pathname) || '');
        }
        function isSettingsProfileHref(href){
            try { return new URL(href || '', window.location.origin).pathname === '/settings/profile'; }
            catch(e) { return false; }
        }
        function findProfileSettingsLink(){
            var scoped = document.querySelectorAll('nav a[href], [class*="Card__CardRoot"] a[href]');
            for(var i=0; i<scoped.length; i++){
                if(isSettingsProfileHref(scoped[i].getAttribute('href'))) return scoped[i];
            }
            var loose = document.querySelectorAll('a[href*="/settings/profile"]');
            for(var li=0; li<loose.length; li++){
                if(!isSettingsProfileHref(loose[li].getAttribute('href'))) continue;
                var parent = loose[li].parentElement;
                if(parent && parent.querySelectorAll && parent.querySelectorAll('a[href*="/settings/"]').length >= 2){
                    return loose[li];
                }
            }
            return null;
        }
        function findSettingsNavList(profileLink){
            if(!profileLink || !profileLink.parentElement) return null;
            var list = profileLink.parentElement;
            var linkCount = list.querySelectorAll ? list.querySelectorAll('a[href]').length : 0;
            if(linkCount <= 1 && list.parentElement){
                var outer = list.parentElement;
                if(outer.querySelectorAll && outer.querySelectorAll('a[href]').length > linkCount){
                    list = outer;
                }
            }
            return list;
        }
        function copySettingsNavClass(profileLink, link){
            var className = '';
            try { className = profileLink && profileLink.className ? String(profileLink.className) : ''; } catch(e) { void e; }
            link.className = className.split(/\s+/).filter(function(token){
                return token && token !== 'active' && token !== 'nav-item-active';
            }).join(' ');
        }
        function syncSettingsNavState(link, profileLink){
            if(!link) return;
            var active = isObfuscationRoute();
            if(active){
                link.setAttribute('data-selected', '');
                link.setAttribute('aria-current', 'page');
                if(profileLink){
                    profileLink.removeAttribute('data-selected');
                    profileLink.removeAttribute('aria-current');
                }
            } else {
                link.removeAttribute('data-selected');
                link.removeAttribute('aria-current');
            }
        }
        function ensureSettingsNav(){
            var existing = document.getElementById(NAV_ID);
            if(!isSettingsRoute()){
                if(existing && existing.parentNode) existing.parentNode.removeChild(existing);
                return;
            }
            var profileLink = findProfileSettingsLink();
            var navList = findSettingsNavList(profileLink);
            if(!profileLink || !navList) return;

            var link = existing;
            if(!link){
                link = document.createElement('a');
                link.id = NAV_ID;
                link.textContent = 'Obfuscate Balances';
                link.setAttribute('data-mtm-settings-nav', '');
                link.setAttribute('aria-label', 'Obfuscate Balances');
                link.addEventListener('click', function(e){
                    if(e.defaultPrevented) return;
                    if(e.button !== 0) return;
                    if(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                    e.preventDefault();
                    if(isObfuscationRoute()) return;
                    history.pushState(history.state, '', NAV_HREF);
                    window.dispatchEvent(new PopStateEvent('popstate'));
                });
            }
            link.setAttribute('href', NAV_HREF);
            copySettingsNavClass(profileLink, link);
            if(link.parentElement !== navList || link !== profileLink.nextElementSibling){
                navList.insertBefore(link, profileLink.nextSibling);
            }
            syncSettingsNavState(link, profileLink);
        }
        function maybeScrollToSettingsPane(){
            if(!isObfuscationRoute()){
                lastAnchorTarget = '';
                return;
            }
            var pane = document.getElementById(PANE_ID);
            var target = window.location.pathname || '';
            if(!pane || lastAnchorTarget === target) return;
            lastAnchorTarget = target;
            setTimeout(function(){
                try {
                    if(pane.isConnected && pane.scrollIntoView) pane.scrollIntoView({ block: 'start', behavior: 'smooth' });
                } catch(e) { void e; }
            }, 0);
        }
        function isExcludedMount(node){
            if(!node || !node.closest) return false;
            return !!node.closest('aside, nav, [role="navigation"], [data-sidebar]');
        }
        function addRoot(roots, root){
            if(!root || roots.indexOf(root) !== -1 || isExcludedMount(root)) return;
            roots.push(root);
        }
        function findRootCandidates(){
            var roots = [];
            addRoot(roots, document.querySelector('main'));
            var scrollRoots = document.querySelectorAll('[class*="Scroll__Root"]');
            for(var i=0; i<scrollRoots.length; i++) addRoot(roots, scrollRoots[i]);
            addRoot(roots, document.getElementById('root'));
            return roots;
        }
        function findCards(root){
            if(!root || !root.querySelectorAll) return [];
            var all = root.querySelectorAll(CARD_SELECTOR);
            var cards = [];
            for(var i=0; i<all.length; i++){
                if(all[i].id === CARD_ID || isExcludedMount(all[i])) continue;
                cards.push(all[i]);
            }
            return cards;
        }
        function findSettingsContentRoot(){
            var roots = findRootCandidates();
            for(var i=0; i<roots.length; i++){
                var cards = findCards(roots[i]);
                if(!cards.length) continue;
                var node = cards[0];
                while(node.parentElement && node.parentElement !== roots[i]) node = node.parentElement;
                if(node === cards[0]) return roots[i];
                if(node.parentElement === roots[i]) return node;
                return roots[i];
            }
            for(var ri=0; ri<roots.length; ri++){
                if(roots[ri].matches && roots[ri].matches('[class*="Scroll__Root"]')){
                    return roots[ri].firstElementChild || roots[ri];
                }
                if(roots[ri].tagName === 'MAIN') return roots[ri];
            }
            return roots.length ? roots[0] : null;
        }
        function findSettingsGrid(root){
            if(!root) return null;
            if(root.matches && root.matches('[class*="grid-cols-12"]')) return root;
            var grids = root.querySelectorAll ? root.querySelectorAll('[class*="grid-cols-12"]') : [];
            for(var i=0; i<grids.length; i++){
                if(grids[i].querySelector('a[href="/settings/profile"]') || findCards(grids[i]).length) return grids[i];
            }
            return grids.length ? grids[0] : null;
        }
        function findSettingsTemplate(root){
            var cards = findCards(root);
            return cards.length ? cards[cards.length - 1] : null;
        }
        function isSettingsNavigationShell(node){
            if(!node || !node.contains) return false;
            var navLink = document.getElementById(NAV_ID);
            if(navLink && node.contains(navLink)) return true;
            return !!(node.querySelector && node.querySelector('nav a[href="/settings/profile"]'));
        }
        function hideNativeSettingsContent(root, pane){
            if(!root || !root.children) return;
            for(var i=0; i<root.children.length; i++){
                var child = root.children[i];
                if(child === pane) continue;
                if(isSettingsNavigationShell(child)){
                    var navOriginalDisplay = child.getAttribute('data-mtm-obf-original-display') || '';
                    var navOriginalStyle = child.getAttribute('data-mtm-obf-original-nav-style');
                    child.classList.remove('mtm-obf-settings-native-hidden');
                    child.style.removeProperty('display');
                    if(navOriginalStyle !== null){
                        if(navOriginalStyle) child.setAttribute('style', navOriginalStyle);
                        else child.removeAttribute('style');
                    } else if(navOriginalDisplay) {
                        child.style.display = navOriginalDisplay;
                    }
                    child.removeAttribute('data-mtm-obf-hidden');
                    child.removeAttribute('data-mtm-obf-original-display');
                    child.removeAttribute('data-mtm-obf-original-nav-style');
                    child.classList.remove('mtm-obf-settings-nav-shell');
                    continue;
                }
                if(child.getAttribute('data-mtm-obf-hidden') !== '1'){
                    child.setAttribute('data-mtm-obf-hidden', '1');
                    child.setAttribute('data-mtm-obf-original-display', child.style.display || '');
                }
                child.classList.add('mtm-obf-settings-native-hidden');
                child.style.setProperty('display', 'none', 'important');
            }
        }
        function restoreNativeSettingsContent(){
            var hidden = document.querySelectorAll('[data-mtm-obf-hidden="1"]');
            for(var i=0; i<hidden.length; i++){
                var original = hidden[i].getAttribute('data-mtm-obf-original-display') || '';
                hidden[i].classList.remove('mtm-obf-settings-native-hidden');
                hidden[i].style.removeProperty('display');
                if(original) hidden[i].style.display = original;
                hidden[i].removeAttribute('data-mtm-obf-hidden');
                hidden[i].removeAttribute('data-mtm-obf-original-display');
            }
            var navShells = document.querySelectorAll('.mtm-obf-settings-nav-shell, [data-mtm-obf-original-nav-style]');
            for(var ni=0; ni<navShells.length; ni++){
                var originalStyle = navShells[ni].getAttribute('data-mtm-obf-original-nav-style');
                if(originalStyle !== null){
                    if(originalStyle) navShells[ni].setAttribute('style', originalStyle);
                    else navShells[ni].removeAttribute('style');
                }
                navShells[ni].removeAttribute('data-mtm-obf-original-nav-style');
                navShells[ni].classList.remove('mtm-obf-settings-nav-shell');
            }
        }
        function removeSettingsPane(){
            var pane = document.getElementById(PANE_ID);
            if(pane && pane.parentNode) pane.parentNode.removeChild(pane);
            var oldCard = document.getElementById(CARD_ID);
            if(oldCard && oldCard.parentNode) oldCard.parentNode.removeChild(oldCard);
            restoreNativeSettingsContent();
        }
        function ensureSettingsPane(){
            var contentRoot = findSettingsContentRoot();
            if(!contentRoot) return;
            var grid = findSettingsGrid(contentRoot) || contentRoot;
            var template = findSettingsTemplate(grid);
            var pane = document.getElementById(PANE_ID);
            if(!pane){
                pane = document.createElement('div');
                pane.id = PANE_ID;
                pane.className = 'mtm-settings-pane';
                pane.setAttribute('data-mtm-obf-pane', '');
                pane.setAttribute('role', 'region');
                pane.setAttribute('aria-label', 'Obfuscate Balances');
            }
            if(pane.parentElement !== grid){
                grid.appendChild(pane);
            }

            var card = pane.querySelector('#' + CARD_ID);
            var detachedCard = document.getElementById(CARD_ID);
            if(detachedCard && detachedCard !== card && detachedCard.parentNode){
                detachedCard.parentNode.removeChild(detachedCard);
            }
            if(!card || !cardMatchesCatalog(card)) card = buildCard(card, template);
            if(template){
                copyClassName(card, template, 'mtm-settings-card');
                var heading = card.querySelector('h1, h2, h3, h4');
                var templateHeading = findTemplateHeading(template);
                if(heading && templateHeading) copyClassName(heading, templateHeading, 'mtm-settings-heading');
            }
            if(card.parentElement !== pane || pane.lastElementChild !== card) pane.appendChild(card);
            hideNativeSettingsContent(grid, pane);
            syncCard(card);
            bindCard(card);
            maybeScrollToSettingsPane();
        }
        function copyClassName(target, source, ownClass){
            var sourceClass = '';
            try { sourceClass = source && source.className ? String(source.className) : ''; } catch(e) { void e; }
            target.className = ownClass + (sourceClass ? ' ' + sourceClass : '');
        }
        function findTemplateHeading(template){
            return template && template.querySelector
                ? template.querySelector('h1, h2, h3, h4, [class*="CardHeader__Title"]')
                : null;
        }
        function buildCard(existing, template){
            var card = existing || document.createElement('section');
            card.id = CARD_ID;
            card.setAttribute('data-mtm-obf-settings', '');
            card.setAttribute('data-mtm-settings-version', '1');
            copyClassName(card, template, 'mtm-settings-card');
            card.innerHTML = '';

            var header = document.createElement('header');
            header.className = 'mtm-settings-header';
            var heading = document.createElement('h2');
            copyClassName(heading, findTemplateHeading(template), 'mtm-settings-heading');
            heading.textContent = 'Obfuscate Balances';
            header.appendChild(heading);
            var description = document.createElement('p');
            description.className = 'mtm-settings-description';
            description.textContent = 'Choose which pages the sidebar toggle applies to. Turning a page off leaves amounts visible there even when obfuscation is on.';
            header.appendChild(description);
            card.appendChild(header);

            var list = document.createElement('ul');
            list.className = 'mtm-settings-list';
            for(var i=0; i<MTM_PAGE_CATALOG.length; i++){
                var page = MTM_PAGE_CATALOG[i];
                var row = document.createElement('li');
                row.className = 'mtm-settings-row';
                var label = document.createElement('label');
                label.className = 'mtm-settings-label';
                var copy = document.createElement('span');
                copy.className = 'mtm-settings-copy';
                var name = document.createElement('span');
                name.className = 'mtm-settings-name';
                name.textContent = page.label;
                var hint = document.createElement('span');
                hint.className = 'mtm-settings-hint';
                hint.textContent = page.hint;
                copy.appendChild(name);
                copy.appendChild(hint);

                var input = document.createElement('input');
                input.type = 'checkbox';
                input.id = 'mtm-obf-page-' + page.id;
                input.setAttribute('data-mtm-page', page.id);
                input.setAttribute('aria-label', page.label + ' obfuscation');
                input.checked = MTM_isPageEnabled(page.id);
                label.appendChild(copy);
                label.appendChild(input);
                row.appendChild(label);
                list.appendChild(row);
            }
            card.appendChild(list);
            return card;
        }
        function cardMatchesCatalog(card){
            if(!card) return false;
            var inputs = card.querySelectorAll('input[data-mtm-page]');
            if(inputs.length !== MTM_PAGE_CATALOG.length) return false;
            for(var i=0; i<MTM_PAGE_CATALOG.length; i++){
                if(!card.querySelector('input[data-mtm-page="' + MTM_PAGE_CATALOG[i].id + '"]')) return false;
            }
            return true;
        }
        function syncCard(card){
            if(!card) return;
            var inputs = card.querySelectorAll('input[data-mtm-page]');
            for(var i=0; i<inputs.length; i++){
                var id = inputs[i].getAttribute('data-mtm-page');
                if(MTM_findPageEntry(id)) inputs[i].checked = MTM_isPageEnabled(id);
            }
        }
        function bindCard(card){
            if(!card || card.getAttribute('data-mtm-bound') === '1') return;
            card.setAttribute('data-mtm-bound', '1');
            card.addEventListener('change', function(e){
                var target = e.target;
                if(!target || !target.matches || !target.matches('input[data-mtm-page]')) return;
                MTM_setPagePref(target.getAttribute('data-mtm-page'), target.checked);
            });
        }
        function syncSettingsObserver(){
            if(MTM_TEST_MODE) return;
            if(isSettingsRoute()){
                if(!settingsObs){
                    settingsObs = new MutationObserver(function(){ scheduleEnsure(200); });
                    try { settingsObs.observe(document.documentElement || document.body, { childList: true, subtree: true }); } catch(e) { void e; }
                }
                return;
            }
            if(settingsObs){
                try { settingsObs.disconnect(); } catch(e) { void e; }
                settingsObs = null;
            }
        }
        function ensure(){
            ensureSettingsNav();
            if(isObfuscationRoute()){
                ensureSettingsPane();
            } else {
                removeSettingsPane();
                maybeScrollToSettingsPane();
            }
            syncSettingsObserver();
        }
        function scheduleEnsure(delay){
            if(ensureTimer) clearTimeout(ensureTimer);
            ensureTimer = setTimeout(function(){
                ensureTimer = null;
                ensure();
            }, delay || 0);
        }

        window.MTM_OBF_ENSURE_SETTINGS = ensure;
        window.MTM_OBF_SETTINGS_API = { ensure: ensure };
        if(MTM_TEST_MODE) return;

        scheduleEnsure(0);
        var tries = 0;
        var intv = setInterval(function(){
            tries++;
            if(isSettingsRoute()) ensure();
            if(tries > 120) clearInterval(intv);
        }, 500);
        window.addEventListener('load', function(){ scheduleEnsure(250); });
        window.addEventListener('popstate', function(){ scheduleEnsure(250); });
        var _ps3 = history.pushState;
        history.pushState = function(){
            var r = _ps3.apply(this, arguments);
            scheduleEnsure(250);
            return r;
        };
        var _rs3 = history.replaceState;
        history.replaceState = function(){
            var r = _rs3.apply(this, arguments);
            scheduleEnsure(250);
            return r;
        };
    })();

    // Test harness hooks (only populated when window.__MTM_OBF_TEST__ is truthy).
    if(MTM_TEST_MODE){
        window.MTM_OBF_TEST_API = {
            maskMoneyValue: MTM_maskMoneyValue,
            wrapFirstAmount: MTM_wrapFirstAmount,
            wrapAllAmounts: MTM_wrapAllAmounts,
            wrapNow: MTM_wrapNow,
            wrapDashboardHeaders: MTM_wrapDashboardHeaders,
            collectDollarLeafCandidates: MTM_collectDollarLeafCandidates,
            processPendingQueue: MTM_processPendingQueue,
            applyState: MTM_applyState,
            scanAndWrap: MTM_scanAndWrap,
            findScopes: MTM_findScopes,
            maskChartDollarLabels: MTM_maskChartDollarLabels,
            applyAuxMasks: MTM_applyAuxMasks,
            isActive: MTM_isActive,
            isRouteAllowed: MTM_isRouteAllowed,
            routeKey: MTM_routeKey,
            readPagePrefs: MTM_readPagePrefs,
            setPagePref: MTM_setPagePref,
            ensureSettings: function(){ try { if(window.MTM_OBF_ENSURE_SETTINGS) window.MTM_OBF_ENSURE_SETTINGS(); } catch(e) { void e; } },
            stats: function(){ return window.MTM_OBF_STATS; },
            ensureSideNav: function(){ try { if(window.MTM_OBF_ENSURE_SIDENAV) window.MTM_OBF_ENSURE_SIDENAV(); } catch(e) { void e; } },
            cfg: MTM_OBF_CFG,
            pageCatalog: MTM_PAGE_CATALOG
        };
    }
})();
