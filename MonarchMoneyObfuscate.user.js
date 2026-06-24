// ==UserScript==
// @name         Monarch Money - Obfuscate Balances
// @namespace    https://tampermonkey.net/
// @version      1.3.1
// @description  Obfuscate dollar amounts on Monarch Money Dashboard/Accounts/Transactions/Goals/Plan/Investments with performant observers
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
    function flipCookie(inCookie,spin) {
        let OldValue = parseInt(getCookie(inCookie,true)) + 1;
        if(spin == null) {spin = 1;}
        if(OldValue > spin) { setCookie(inCookie,0); } else {setCookie(inCookie,OldValue); }
    }

    // Debug (opt-in): set localStorage MTM_OBF_DEBUG=1 to enable console.debug + counters.
    function MTM_isDebugEnabled(){ try { return getCookie('MTM_OBF_DEBUG', true) == 1; } catch(e) { void e; return false; } }
    function MTM_dbg(){
        if(!MTM_isDebugEnabled()) return;
        try { console.debug.apply(console, ['[MTM Obfuscate]'].concat([].slice.call(arguments))); } catch(e) { void e; }
    }
    window.MTM_OBF_STATS = window.MTM_OBF_STATS || { scanRuns:0, candidatesSeen:0, watched:0, enqueued:0, queueRuns:0, wrapAttempts:0, wrapSuccess:0, observerStarts:0, observerStops:0 };

    // [ MT: Obfuscate Dollar Amounts — scoped to /dashboard, /accounts, /transactions, /objectives|/goals, /plan, /investments ]
    // Injects minimal CSS used by the masking spans and the sidebar toggle; idempotent.
    (function MTM_Obfuscation_InitCSS(){
        if (document.getElementById('mtm-obf-css')) return;
        const css = '\n.mtm-amount-wrap{position:relative;display:inline-block;margin-right:.25em}\nbody.mt-obfuscate-on .fs-mask .recharts-yAxis .recharts-text tspan{opacity:0}\nbody.mt-obfuscate-on .recharts-yAxis .recharts-cartesian-axis-tick-value,\nbody.mt-obfuscate-on .recharts-yAxis .recharts-text,\nbody.mt-obfuscate-on .recharts-yAxis tspan{opacity:0!important}\nbody.mt-obfuscate-on input.fs-exclude,\nbody.mt-obfuscate-on input[class*="CurrencyInput__Input-"]{-webkit-text-security:disc;text-security:disc}\n.mtm-nav-eye-btn{display:flex;align-items:center;gap:12px;cursor:pointer;color:inherit;background:transparent;border:0;width:100%;padding:8px 10px;border-radius:8px;text-align:left}\n.mtm-nav-eye-btn:hover{background:rgba(255,255,255,.06)}\n.mtm-nav-eye-btn .mtm-iconwrap{display:flex;align-items:center;justify-content:center;width:40px;height:40px}\n.mtm-nav-eye-btn .mtm-icon{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px}\n.mtm-nav-eye-btn .mtm-icon svg{width:20px;height:20px;display:block}\n.mtm-nav-eye-btn .mtm-label{font-size:12px;white-space:nowrap}\n.mtm-nav-collapsed .mtm-label{display:none}\n#mtm-obf-master{display:flex;align-items:center;gap:12px;transition:none!important}\n#mtm-obf-master .mtm-nav-title{display:inline-block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}\n#mtm-obf-master .mtm-nav-iconwrap{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;min-width:20px;transition:none!important}\n#mtm-obf-master .mtm-eye-icon{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;line-height:1}\n#mtm-obf-master .mtm-eye-icon::before,\n#mtm-obf-master .mtm-eye-icon::after{content:none!important}\n#mtm-obf-master .mtm-eye-icon svg{width:20px;height:20px;display:block}\n.sidebar-collapsed #mtm-obf-master,\n.mtm-nav-collapsed#mtm-obf-master,\n.mtm-nav-collapsed #mtm-obf-master{height:40px!important;padding-top:0!important;padding-bottom:0!important;transition:none!important}\n.sidebar-collapsed #mtm-obf-master .mtm-nav-title,\n.mtm-nav-collapsed #mtm-obf-master .mtm-nav-title{display:none!important}\n';
        function inject(){
            try {
                if (document.getElementById('mtm-obf-css')) return;
                const head = document.head || document.documentElement;
                if(!head) return;
                const style = document.createElement('style');
                style.id = 'mtm-obf-css';
                style.textContent = css;
                head.appendChild(style);
            } catch(e) { void e; }
        }
        // When injected via Playwright addInitScript, document.head may not exist yet; defer safely.
        if (document.head) inject();
        else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject, { once: true });
        else inject();
    })();

    // Central configuration: allowed routes, scan containers, and elements to skip.
    const MTM_OBF_CFG = {
        routeAllow: [/^\/dashboard(?:\/|$)/, /^\/accounts(?:\/|$)/, /^\/transactions(?:\/|$)/, /^\/objectives(?:\/|$)/, /^\/goals(?:\/|$)/, /^\/plan(?:\/|$)/, /^\/investments(?:\/|$)/],
        containerAllow: [
            'main',
            '[data-rbd-droppable-id="accountGroups"]',
            '[class*="AccountNetWorthCharts__Root"]',
            '.AccountNetWorthCharts__Root-sc-14tj3z2-0',
            '[class*="DashboardWidget__Root-"]',
            '[class*="GoalDashboardRow__Root-"]',
            '[class*="RecurringTransactionsDashboardWidget__Item-"]',
            '[class*="AccountSummaryCardGroup__"]',
            '[class*="AccountGroupCard__Content-"]',
            '[class*="AccountBalanceIndicator__Root-"]'
        ],
        skipSelectors: [
            // App chrome & internal UIs
            '[class*="SideBar__"]','[class*="NavBarLink__"]',
            '[id="side-drawer-root"]','[class*="FooterButtonContainer__"]',
            'button','input','textarea','select','[contenteditable="true"]',
            // Skip highly dynamic charting/SVG areas to avoid DOM races
            'svg', '[class*="recharts-"]', '.recharts-wrapper',
            '[class*="MultipleLineChart__"]', '[class*="NetWorthPerformanceChart__"]',
            '[class*="CashFlowDashboardWidgetGraph__"]'
        ],
    };
    // Precomputed skip selector for a single closest() check in hot paths.
    const MTM_SKIP_CLOSEST = MTM_OBF_CFG.skipSelectors.join(',');

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
        if(MTM_hasScrollableAncestor(el)){
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
                try{ if(window.MTM_SEEN) window.MTM_SEEN.add(el);}catch(e){ void e; }
            }
            if(processed >= cap || (performance.now() - start) > budgetMs) break;
            step = it.next();
        }
        MTM_applyAuxMasks();
        if(window.MTM_OBF_PENDING.size > 0){
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

    // Returns true if current SPA route should have masking active.
    function MTM_isRouteAllowed() {
        const p = window.location.pathname;
        return MTM_OBF_CFG.routeAllow.some(rx => rx.test(p));
    }
    // Returns user preference for masking (driven by sidebar toggle or settings checkbox).
    function MTM_isObfEnabled() { return getCookie('MT_HideSensitiveInfo', true) == 1; }
    // Single source of truth for whether masking work should run.
    function MTM_isActive(){ return MTM_isRouteAllowed() && MTM_isObfEnabled(); }
    // Finds DOM roots to scan/observe, limited to known containers for performance.
    function MTM_findScopes() {
        const roots = MTM_OBF_CFG.containerAllow.map(sel => Array.from(document.querySelectorAll(sel))).flat();
        return roots.length ? roots : [document];
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
        const on = MTM_isObfEnabled();
        document.body.classList.toggle('mt-obfuscate-on', on);
        document.querySelectorAll('.mtm-amount').forEach(function(span){
            const orig = span.dataset.originalText || span.textContent;
            if(!span.dataset.originalText) span.dataset.originalText = orig;
            var next = on ? MTM_maskMoneyValue(orig) : orig;
            if(span.textContent !== next) { span.textContent = next; }
        });
        MTM_applyAuxMasks();
    }
    // Masks remaining SVG currency labels not covered by wrapper logic.
    function MTM_maskChartDollarLabels(){
        var on = MTM_isObfEnabled();
        var nodes = document.querySelectorAll('svg text, svg tspan');
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
    }
    // Masks read-only/live-rendered money values exposed through form controls.
    function MTM_maskInputDollarValues(){
        var on = MTM_isObfEnabled();
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
    function MTM_applyAuxMasks(){
        MTM_maskChartDollarLabels();
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
        var out = [];
        var cap = max || 300;
        var pool = scope.querySelectorAll('span, div, p, td, th, li, a, h1, h2, h3, h4, h5');
        for (var i=0; i<pool.length; i++){
            var el = pool[i];
            if(!el || !MTM_shouldProcess(el)) continue;
            if(MTM_SKIP_CLOSEST && el.closest && el.closest(MTM_SKIP_CLOSEST)) continue;
            var txt = el.textContent || '';
            if(!MTM_hasMaskableText(txt)) continue;
            // Avoid wrapping container nodes when a deeper node already carries the dollar value.
            var childHasDollar = false;
            try {
                if(el.children && el.children.length){
                    for (var ci=0; ci<el.children.length; ci++){
                        var ct = el.children[ci] && el.children[ci].textContent || '';
                        if(MTM_hasMaskableText(ct)){ childHasDollar = true; break; }
                    }
                }
            } catch(e) { void e; }
            if(childHasDollar) continue;
            out.push(el);
            if(out.length >= cap) break;
        }
        return out;
    }
    // Scans allowed containers (or a given root) and wraps simple currency occurrences once.
    function MTM_scanAndWrap(root){
        if (!MTM_isActive()) return;
        try { window.MTM_OBF_STATS.scanRuns += 1; } catch(e) { void e; }
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
            var path = window.location.pathname || '';
            if(/^\/accounts(?:\/|$)/.test(path)){
                var extra = Array.from(scope.querySelectorAll('[class*="Card__CardRoot-"] .Text-qcxgyd-0, [class*="Card__CardRoot-"] .Summary__SummaryValue, [class*="AccountSummaryCardGroup__"] .fs-exclude, [class*="AccountGroupCard__Content-"] .fs-exclude, [class*="AccountBalanceIndicator__Root-"] .fs-exclude'))
                    .filter(function(el){ return /\$/.test(el.textContent || '') && !el.querySelector('.mtm-amount') && !el.closest('.mtm-amount-wrap'); });
                for (var i=0;i<extra.length && i<300; i++) { MTM_watch(extra[i]); }
            }
            if(/^\/dashboard(?:\/|$)/.test(path)){
                var dashCandidates = Array.from(scope.querySelectorAll(MTM_DASH_SEL));
                var dash = dashCandidates.filter(function(el){
                    if(el.querySelector('.fs-exclude')) return false; // let fs-exclude path handle it
                    if(el.querySelector('.mtm-amount')) return false;  // already processed inside
                    return MTM_hasMaskableText(el.textContent || '') && !el.closest('.mtm-amount-wrap');
                });
                for (var di=0; di<dash.length && di<300; di++) { MTM_watch(dash[di]); }
                // Fallback pass for widgets with plain numeric values (goals/top-movers) outside static selectors.
                var dashLeaves = MTM_collectDollarLeafCandidates(scope, 450);
                for (var dl=0; dl<dashLeaves.length; dl++) { MTM_watch(dashLeaves[dl]); }
            }
            if(/^\/(?:goals|objectives|plan)(?:\/|$)/.test(path)){
                var moneyLeaves = MTM_collectDollarLeafCandidates(scope, 450);
                for (var gi=0; gi<moneyLeaves.length; gi++) { MTM_watch(moneyLeaves[gi]); }
                if(/^\/plan(?:\/|$)/.test(path)){
                    // Plan table often splits "$" and number into sibling nodes; include compact containers directly.
                    var planExtra = Array.from(scope.querySelectorAll('div, span, p, td, th')).filter(function(el){
                        if(!MTM_shouldProcess(el)) return false;
                        if(MTM_SKIP_CLOSEST && el.closest && el.closest(MTM_SKIP_CLOSEST)) return false;
                        var t = (el.textContent || '').replace(/\s+/g, '');
                        if(!MTM_hasMaskableText(t)) return false;
                        return t.length > 1 && t.length <= 40;
                    });
                    for (var pi=0; pi<planExtra.length && pi<350; pi++) { MTM_watch(planExtra[pi]); }
                }
            }
        });
        MTM_applyAuxMasks();
    }
    // MutationObserver wiring: enqueues relevant added/updated nodes and batches processing.
    (function MTM_Observer(){
        if (window.MTM_OBF_OBSERVER_API_WIRED) return;
        window.MTM_OBF_OBSERVER_API_WIRED = true;

        // Starts scoped observers if masking is enabled and route is allowed.
        window.MTM_startObserver = function(){
            window.MTM_stopObserver();
            if(!MTM_isActive()) return;
            try { window.MTM_OBF_STATS.observerStarts += 1; } catch(e) { void e; }

            var scopes = MTM_findScopes();
            window.MTM_OBF_OBSERVERS = [];

            scopes.forEach(function(scope){
                var observer = new MutationObserver(function(mutations){
                    var path = window.location.pathname;
                    for (var i=0; i<mutations.length; i++){
                        var m = mutations[i];
                        if(m.type === 'childList'){
                            for (var j=0; j<m.addedNodes.length; j++){
                                var node = m.addedNodes[j];
                                if(!(node instanceof Element)) continue;
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
                                    if(node.matches && node.matches(MTM_DASH_SEL)) { if(MTM_shouldProcess(node)) { if(window.MTM_IO) { MTM_watch(node); } else { MTM_enqueue(node); } } }
                                    if(node.querySelectorAll){
                                        var dqs = node.querySelectorAll(MTM_DASH_SEL);
                                        for(var dk=0; dk<dqs.length; dk++){ if(MTM_shouldProcess(dqs[dk])) { if(window.MTM_IO) { MTM_watch(dqs[dk]); } else { MTM_enqueue(dqs[dk]); } } }
                                        var dLeaves = MTM_collectDollarLeafCandidates(node, 150);
                                        for(var dli=0; dli<dLeaves.length; dli++){ if(MTM_shouldProcess(dLeaves[dli])) { if(window.MTM_IO) { MTM_watch(dLeaves[dli]); } else { MTM_enqueue(dLeaves[dli]); } } }
                                    }
                                }
                                if(/^\/(?:goals|objectives|plan)(?:\/|$)/.test(path)){
                                    if(node.matches && MTM_shouldProcess(node)){
                                        var nt = node.textContent || '';
                                        if(MTM_hasMaskableText(nt)) { if(window.MTM_IO) { MTM_watch(node); } else { MTM_enqueue(node); } }
                                    }
                                    if(node.querySelectorAll){
                                        var leaves = MTM_collectDollarLeafCandidates(node, 150);
                                        for(var li=0; li<leaves.length; li++){ if(MTM_shouldProcess(leaves[li])) { if(window.MTM_IO) { MTM_watch(leaves[li]); } else { MTM_enqueue(leaves[li]); } } }
                                        if(/^\/plan(?:\/|$)/.test(path)){
                                            var pextra = node.querySelectorAll('div, span, p, td, th');
                                            for(var px=0; px<pextra.length && px<180; px++){
                                                var pe = pextra[px];
                                                if(!MTM_shouldProcess(pe)) continue;
                                                var pt = (pe.textContent || '').replace(/\s+/g, '');
                                                if(!MTM_hasMaskableText(pt)) continue;
                                                if(pt.length <= 1 || pt.length > 40) continue;
                                                if(window.MTM_IO) { MTM_watch(pe); } else { MTM_enqueue(pe); }
                                            }
                                        }
                                    }
                                }
                            }
                        } else if(m.type === 'characterData'){
                            var p = m.target && m.target.parentElement;
                            if(p){
                                // Ignore our own text swaps (hover reveal / applyState) to avoid observer churn.
                                if(p.closest && p.closest('.mtm-amount-wrap')) { continue; }
                                // Early bail when updated text has no maskable token.
                                if(m.target && typeof m.target.nodeValue === 'string' && !MTM_hasMaskableText(m.target.nodeValue)) { continue; }
                                var host = p.matches('.fs-exclude, .fs-mask') ? p : p.closest('.fs-exclude, .fs-mask');
                                if(host && MTM_shouldProcess(host)) { if(window.MTM_IO) { MTM_watch(host); } else { MTM_enqueue(host); } }
                                // Dashboard text nodes updating in place
                                if(!host && /^\/dashboard(?:\/|$)/.test(path)){
                                    var dashHost = p.matches(MTM_DASH_SEL) ? p : p.closest(MTM_DASH_SEL);
                                    if(dashHost && MTM_shouldProcess(dashHost)) { if(window.MTM_IO) { MTM_watch(dashHost); } else { MTM_enqueue(dashHost); } }
                                }
                                if(!host && /^\/(?:goals|objectives|plan)(?:\/|$)/.test(path)){
                                    var moneyHost = p;
                                    if(moneyHost && MTM_shouldProcess(moneyHost)) { if(window.MTM_IO) { MTM_watch(moneyHost); } else { MTM_enqueue(moneyHost); } }
                                }
                            }
                        }
                    }
                    // Only schedule processing if there is queued work; IntersectionObserver will schedule on intersect.
                    if(window.MTM_OBF_PENDING && window.MTM_OBF_PENDING.size > 0) MTM_scheduleProcessQueue();
                });

                observer.observe(scope, { childList: true, subtree: true, characterData: true, characterDataOldValue: false });
                window.MTM_OBF_OBSERVERS.push(observer);
            });
        };
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
                MTM_applyState();
                MTM_scanAndWrap();
                if(MTM_isObfEnabled()) { window.MTM_restartObserver(); } else { window.MTM_stopObserver(); }
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
            [300].forEach(function(d){ setTimeout(run, d); });
            if(MTM_isObfEnabled()){
                setTimeout(window.MTM_restartObserver, 300);
            } else {
                window.MTM_stopObserver();
            }
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
                var txt = (a.textContent || '').replace(/\s+/g,' ').trim();
                if(!txt) continue; // exclude logo/dashboard icon links in sticky header
                out.push(a);
            }
            return out;
        }
        // Finds smallest ancestor that still contains most visible primary nav links.
        function MTM_findPrimaryNavList(sidebarRoot, sideContent){
            var searchRoot = sideContent || sidebarRoot || document;
            var links = MTM_collectPrimaryNavLinks(searchRoot);
            if(!links.length) return null;
            var best = null;
            var bestCount = 0;
            var bestDesc = Number.POSITIVE_INFINITY;
            for (var li=0; li<links.length; li++){
                var p = links[li].parentElement;
                var hops = 0;
                while(p && p !== searchRoot && hops < 9){
                    var count = 0;
                    for (var j=0; j<links.length; j++){ if(p.contains(links[j])) count++; }
                    if(count >= 4){
                        var desc = 0;
                        try { desc = p.querySelectorAll('a[href]').length; } catch(e2) { void e2; }
                        if(!best || count > bestCount || (count === bestCount && desc < bestDesc)){
                            best = p;
                            bestCount = count;
                            bestDesc = desc;
                        }
                    }
                    p = p.parentElement;
                    hops++;
                }
            }
            return best;
        }

        function ensure(){
            // Insert as a native nav item at the end of the primary list
            var sidebarRoot = document.querySelector('[class*="SideBar__Root-"], [class*="SideBar__Root"], .SideBar__Root-sc-161w9oi-0');
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
            if(!navList) return;
            if(document.getElementById('mtm-obf-master')) return;

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
                    if(cls === 'nav-item-active') return false;
                    if(cls.indexOf('in-aria-') !== -1) return false;
                    return true;
                }).join(' ');
            } catch(e) { void e; }
            link.setAttribute('data-state','closed');
            // Always keep as last item of the primary group
            link.style.order = '9999';

            var iconWrap = document.createElement('span');
            iconWrap.classList.add('mtm-nav-iconwrap');
            var iconSpan = document.createElement('span');
            iconSpan.className = '';
            iconSpan.classList.add('mtm-eye-icon');
            function setIcon(on){
                iconSpan.innerHTML = on
                    ? '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" stroke="currentColor" stroke-width="2"/><path d="M22 2 2 22" stroke="currentColor" stroke-width="2"/></svg>'
                    : '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/></svg>';
            }
            setIcon(MTM_isObfEnabled());
            iconWrap.appendChild(iconSpan);

            var title = document.createElement('span');
            title.className = 'mtm-nav-title';
            title.textContent = 'Obfuscate Balances';

            link.appendChild(iconWrap);
            link.appendChild(title);
            link.addEventListener('click', function(e){
                e.preventDefault();
                flipCookie('MT_HideSensitiveInfo');
                MTM_applyState();
                MTM_scanAndWrap();
                if(MTM_isObfEnabled()) window.MTM_restartObserver(); else window.MTM_stopObserver();
                setIcon(MTM_isObfEnabled());
            });

            navList.appendChild(link);

            // Guard against reordering and sidebar collapse state with narrowly scoped observers
            try { if(window.MTM_SIDENAV_ORDER_OBS) window.MTM_SIDENAV_ORDER_OBS.disconnect(); } catch{ /* ignore */ }
            try { if(window.MTM_SIDENAV_COLLAPSE_OBS) window.MTM_SIDENAV_COLLAPSE_OBS.disconnect(); } catch{ /* ignore */ }

            // Keep link last by observing only the nav list
            var orderObs = new MutationObserver(function(){
                var last = navList.lastElementChild;
                if(last && last.id !== 'mtm-obf-master') { navList.appendChild(link); }
            });
            orderObs.observe(navList, { childList: true });
            window.MTM_SIDENAV_ORDER_OBS = orderObs;

            // Toggle collapsed style by observing only the sidebar root for class changes
            sidebarRoot = sidebarRoot || firstLink.closest('.SideBar__Root-sc-161w9oi-0, [class*="SideBar__Root-"], [class*="SideBar__Root"]') || document.querySelector('.SideBar__Root-sc-161w9oi-0, [class*="SideBar__Root-"], [class*="SideBar__Root"]');
            var setCollapsed = function(){
                var collapsed = !!(sidebarRoot && sidebarRoot.classList.contains('sidebar-collapsed'));
                if(!collapsed && sidebarRoot){
                    var ariaExpanded = sidebarRoot.getAttribute('aria-expanded');
                    if(ariaExpanded === 'false') collapsed = true;
                    var width = 0;
                    try { width = sidebarRoot.getBoundingClientRect().width; } catch(e) { void e; }
                    if(!collapsed && width > 0 && width < 120) collapsed = true;
                }
                link.classList.toggle('mtm-nav-collapsed', collapsed);
            };
            setCollapsed();
            if(sidebarRoot){
                var collapseObs = new MutationObserver(function(){ setCollapsed(); });
                collapseObs.observe(sidebarRoot, { attributes: true, attributeFilter: ['class', 'style', 'aria-expanded'] });
                window.MTM_SIDENAV_COLLAPSE_OBS = collapseObs;
            }
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
            tries++; ensure(); if(document.getElementById('mtm-obf-master') || tries > 120) clearInterval(intv);
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
            if(document.getElementById('mtm-obf-master')) return;
            scheduleEnsure(200);
        });
        try { ensureObs.observe(document.documentElement || document.body, { childList: true, subtree: true }); } catch(e) { void e; }
    })();

    // Test harness hooks (only populated when window.__MTM_OBF_TEST__ is truthy).
    if(MTM_TEST_MODE){
        window.MTM_OBF_TEST_API = {
            maskMoneyValue: MTM_maskMoneyValue,
            wrapFirstAmount: MTM_wrapFirstAmount,
            applyState: MTM_applyState,
            scanAndWrap: MTM_scanAndWrap,
            isActive: MTM_isActive,
            ensureSideNav: function(){ try { if(window.MTM_OBF_ENSURE_SIDENAV) window.MTM_OBF_ENSURE_SIDENAV(); } catch(e) { void e; } },
            cfg: MTM_OBF_CFG
        };
    }
})();


