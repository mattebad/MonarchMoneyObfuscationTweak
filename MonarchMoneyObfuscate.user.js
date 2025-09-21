// ==UserScript==
// @name         Monarch Money - Obfuscate Balances
// @namespace    https://tampermonkey.net/
// @version      1.2.0
// @description  Obfuscate dollar amounts on Monarch Money Dashboard/Accounts/Transactions/Objectives/Plan with performant observers
// @match        https://app.monarchmoney.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=monarchmoney.com
// @grant        none
// ==/UserScript==

(function(){
    'use strict';

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

    // [ MT: Obfuscate Dollar Amounts — scoped to /dashboard, /accounts, /transactions, /objectives, /plan ]
    // Injects minimal CSS used by the masking spans and the sidebar toggle; idempotent.
    (function MTM_Obfuscation_InitCSS(){
        if (document.getElementById('mtm-obf-css')) return;
        const css = '\n.mtm-amount-wrap{position:relative;display:inline-block;margin-right:.25em}\nbody.mt-obfuscate-on .fs-mask .recharts-yAxis .recharts-text tspan{opacity:0}\n.mtm-nav-eye-btn{display:flex;align-items:center;gap:12px;cursor:pointer;color:inherit;background:transparent;border:0;width:100%;padding:8px 10px;border-radius:8px;text-align:left}\n.mtm-nav-eye-btn:hover{background:rgba(255,255,255,.06)}\n.mtm-nav-eye-btn .mtm-iconwrap{display:flex;align-items:center;justify-content:center;width:40px;height:40px}\n.mtm-nav-eye-btn .mtm-icon{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px}\n.mtm-nav-eye-btn .mtm-icon svg{width:20px;height:20px;display:block}\n/* Ensure our custom link matches Monarch layout when expanded */\n#mtm-obf-master{position:sticky;bottom:8px;transition:none!important;display:flex;align-items:center;padding:8px 12px;min-height:40px;color:inherit;text-decoration:none}\n#mtm-obf-master .LinkIcon-sc-1qcij8x-0{width:16px;height:16px;margin-right:12px;position:relative;display:inline-flex;align-items:center;justify-content:center}\n.mtm-nav-collapsed .mtm-label{display:none}\n.sidebar-collapsed #mtm-obf-master{height:40px!important;padding-top:0!important;padding-bottom:0!important;transition:none!important}\n.sidebar-collapsed #mtm-obf-master .NavBarLink__Title-sc-1xv1ifc-2{display:none!important}\n.sidebar-collapsed #mtm-obf-master .LinkIcon-sc-1qcij8x-0{width:40px!important;height:40px!important;margin:0 auto!important}\n';
        const style = document.createElement('style');
        style.id = 'mtm-obf-css';
        style.textContent = css;
        document.head.appendChild(style);
    })();

    // Central configuration: allowed routes, scan containers, and elements to skip.
    const MTM_OBF_CFG = {
        routeAllow: [/^\/dashboard(?:\/|$)/, /^\/accounts(?:\/|$)/, /^\/transactions(?:\/|$)/, /^\/objectives(?:\/|$)/, /^\/plan(?:\/|$)/],
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

    // Precompiled regexes to avoid re-allocation on hot paths
    const MTM_RE_MONEY = /\$\s*[\d,.]+|\(\$\s*[\d,.]+\)|-\$\s*[\d,.]+/g;
    const MTM_RE_FIRST_SIMPLE = /\$\s*[\d,.]+/;
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
        for (var i=0;i<entries.length;i++){
            var entry = entries[i];
            if(entry.isIntersecting){
                MTM_enqueue(entry.target);
                try { window.MTM_IO.unobserve(entry.target); } catch(e) { void e; }
            }
        }
        MTM_scheduleProcessQueue();
    },{root: null, rootMargin: '200px', threshold: 0}) : null);
    // Watch helper: observes element visibility or falls back to immediate queueing.
    function MTM_watch(el){
        if(!el) return;
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
        if(window.MTM_SEEN && window.MTM_SEEN.has(el)) return false;
        if(el.querySelector && (el.querySelector('.mtm-amount'))) return false;
        if(el.closest && el.closest('.mtm-amount-wrap')) return false;
        return true;
    }
    // Enqueue a candidate element for masked wrapping; skips already processed/masked hosts.
    function MTM_enqueue(el){
        if(!MTM_shouldProcess(el)) return;
        window.MTM_OBF_PENDING.add(el);
    }
    // Processes the pending queue within a frame time budget to avoid long tasks.
    function MTM_processPendingQueue(){
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
                if(el.querySelector && el.querySelector('.mtm-amount')){ try{ window.MTM_SEEN.add(el);}catch(e){ void e; } }
                else {
                    if(MTM_wrapFirstAmount(el)) { processed+=1; }
                }
            }
            if(processed >= cap || (performance.now() - start) > budgetMs) break;
            step = it.next();
        }
        if(window.MTM_OBF_PENDING.size > 0){
            requestAnimationFrame(MTM_processPendingQueue);
        } else {
            window.MTM_OBF_SCHEDULED = false;
        }
    }
    // Schedules queue processing on the next animation frame once.
    function MTM_scheduleProcessQueue(){
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
    // Finds DOM roots to scan/observe, limited to known containers for performance.
    function MTM_findScopes() {
        const roots = MTM_OBF_CFG.containerAllow.map(sel => Array.from(document.querySelectorAll(sel))).flat();
        return roots.length ? roots : [document];
    }
    // Masks any dollar amounts within a string to a normalized $*,***.** shape.
    function MTM_maskMoneyValue(s){
        return String(s).replace(MTM_RE_MONEY, function(m){
            // Standardize to $*,***.** while keeping sign and parentheses
            var isNeg = m.trim().startsWith('-$');
            var isParen = /^\(\$/.test(m.trim());
            var masked = '$*,***.**';
            if(isNeg) masked = '-'+masked;
            if(isParen) masked = '('+masked+')';
            return masked;
        });
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
    }
    // Wraps the first $ amount found within an element into .mtm-amount span; returns true if wrapped.
    function MTM_wrapFirstAmount(el){
        if(!el) return false;
        if(MTM_OBF_CFG.skipSelectors.some(function(sel){ return el.matches(sel) || el.closest(sel); })) return false;
        // Locate the first '$' using a TreeWalker; supports both simple and spanning cases.
        var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
        var startNode = null, endNode = null, startOffset = 0, endOffset = 0;
        while(walker.nextNode()){
            var txt = walker.currentNode.nodeValue || '';
            var sIdx = txt.indexOf('$');
            if(sIdx !== -1){
                // Simple confirm for money after the '$'
                var trail = txt.slice(sIdx);
                if(MTM_RE_FIRST_SIMPLE.test(trail)){
                    startNode = walker.currentNode;
                    startOffset = sIdx;
                    break;
                }
            }
        }
        if(!startNode) return false;
        // Continue from startNode to find end of amount
        var remain = startNode.nodeValue.slice(startOffset);
        var m2 = remain.match(MTM_RE_FIRST_SIMPLE);
        if(m2){ endNode = startNode; endOffset = startOffset + m2[0].length; }
        else {
            // Walk forward to find remaining part if the amount spans nodes
            endNode = startNode; endOffset = startNode.nodeValue.length;
            while(walker.nextNode()){
                var t2 = walker.currentNode.nodeValue || '';
                var mm = t2.match(/^[\d,.]+/);
                if(mm){ endNode = walker.currentNode; endOffset = mm[0].length; if(mm[0].indexOf('.') !== -1) break; }
                else { break; }
            }
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
    // Scans allowed containers (or a given root) and wraps simple currency occurrences once.
    function MTM_scanAndWrap(root){
        if (!MTM_isRouteAllowed() || !MTM_isObfEnabled()) return;
        const scopes = root ? [root] : MTM_findScopes();
        scopes.forEach(function(scope){
            var candidates = Array.from(scope.querySelectorAll('.fs-exclude'));
            candidates.forEach(function(el){ if(MTM_shouldProcess(el)) { MTM_watch(el); } });
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
                    return /\$/.test(el.textContent || '') && !el.closest('.mtm-amount-wrap');
                });
                for (var di=0; di<dash.length && di<300; di++) { MTM_watch(dash[di]); }
            }
        });
    }
    // MutationObserver wiring: enqueues relevant added/updated nodes and batches processing.
    (function MTM_Observer(){
        if (window.MTM_OBF_OBSERVER_API_WIRED) return;
        window.MTM_OBF_OBSERVER_API_WIRED = true;

        // Starts scoped observers if masking is enabled and route is allowed.
        window.MTM_startObserver = function(){
            window.MTM_stopObserver();
            if(!MTM_isObfEnabled() || !MTM_isRouteAllowed()) return;

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
                                if(node.matches && node.matches('.fs-exclude')){ if(MTM_shouldProcess(node)) { if(window.MTM_IO) { MTM_watch(node); } else { MTM_enqueue(node); } } }
                                if(node.querySelectorAll){
                                    var list = node.querySelectorAll('.fs-exclude');
                                    for(var k=0; k<list.length; k++) { if(MTM_shouldProcess(list[k])) { if(window.MTM_IO) { MTM_watch(list[k]); } else { MTM_enqueue(list[k]); } } }
                                }
                                // Also handle dashboard non-fs-exclude currency nodes that load late
                                if(/^\/dashboard(?:\/|$)/.test(path)){
                                    if(node.matches && node.matches(MTM_DASH_SEL)) { if(MTM_shouldProcess(node)) { if(window.MTM_IO) { MTM_watch(node); } else { MTM_enqueue(node); } } }
                                    if(node.querySelectorAll){
                                        var dqs = node.querySelectorAll(MTM_DASH_SEL);
                                        for(var dk=0; dk<dqs.length; dk++){ if(MTM_shouldProcess(dqs[dk])) { if(window.MTM_IO) { MTM_watch(dqs[dk]); } else { MTM_enqueue(dqs[dk]); } } }
                                    }
                                }
                            }
                        } else if(m.type === 'characterData'){
                            var p = m.target && m.target.parentElement;
                            if(p){
                                // Early bail when no '$' in updated text
                                if(m.target && typeof m.target.nodeValue === 'string' && m.target.nodeValue.indexOf('$') === -1) { continue; }
                                var host = p.matches('.fs-exclude') ? p : p.closest('.fs-exclude');
                                if(host && MTM_shouldProcess(host)) { if(window.MTM_IO) { MTM_watch(host); } else { MTM_enqueue(host); } }
                                // Dashboard text nodes updating in place
                                if(!host && /^\/dashboard(?:\/|$)/.test(path)){
                                    var dashHost = p.matches(MTM_DASH_SEL) ? p : p.closest(MTM_DASH_SEL);
                                    if(dashHost && MTM_shouldProcess(dashHost)) { if(window.MTM_IO) { MTM_watch(dashHost); } else { MTM_enqueue(dashHost); } }
                                }
                            }
                        }
                    }
                    MTM_scheduleProcessQueue();
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
        };
        // Restarts observers (used after route transitions and toggles).
        window.MTM_restartObserver = function(){
            window.MTM_stopObserver();
            window.MTM_startObserver();
        };
    })();
    // Hover-to-reveal: shows the original amount on hover, remasks on mouseleave; respects setting.
    (function MTM_wireHoverReveal(){
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
            if(!MTM_isObfEnabled()) return;
            if(scrollTimer) clearTimeout(scrollTimer);
            scrollTimer = setTimeout(function(){ MTM_scanAndWrap(); }, 250);
        }, {passive:true});
    })();

    // Sidebar toggle injection: adds a nav item that flips masking on/off persistently.
    (function MTM_SideNavToggle(){
        if (window.MTM_OBF_SIDENAV_WIRED) return;
        window.MTM_OBF_SIDENAV_WIRED = true;

        function ensure(){
            // Insert as a native nav item at the end of the primary list
            var firstLink = document.querySelector('.SideBar__Content-sc-161w9oi-4 .NavBarLink__Container-sc-1xv1ifc-3, .SideBar__Content .NavBarLink__Container-sc-1xv1ifc-3, .NavBarLink__Container-sc-1xv1ifc-3');
            if(!firstLink) return;
            var navList = firstLink.closest('.FlexItem-sc-1p0zueu-0');
            if(!navList) return;
            if(document.getElementById('mtm-obf-master')) return;

            var link = document.createElement('a');
            link.id = 'mtm-obf-master';
            link.href = '#';
            link.setAttribute('role','button');
            link.className = 'NavLink-sc-1bdi3x9-0 jwNjNr NavBarLink__Container-sc-1xv1ifc-3 dFxBOe NavBarLink-sc-1xv1ifc-4 gmbciN';
            link.setAttribute('data-state','closed');
            // Always keep as last item of the primary group
            link.style.order = '9999';

            var iconWrap = document.createElement('div');
            iconWrap.className = 'Flex-sc-165659u-0 LinkIcon-sc-1qcij8x-0 tRmOx jfWCtJ';
            var iconSpan = document.createElement('span');
            iconSpan.className = 'Icon__MonarchIcon-sc-1ja3cr5-0 hyumnu mtm-eye-icon';
            function setIcon(on){
                iconSpan.innerHTML = on
                    ? '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" stroke="currentColor" stroke-width="2"/><path d="M22 2 2 22" stroke="currentColor" stroke-width="2"/></svg>'
                    : '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/></svg>';
            }
            setIcon(MTM_isObfEnabled());
            iconWrap.appendChild(iconSpan);

            var title = document.createElement('span');
            title.className = 'NavBarLink__Title-sc-1xv1ifc-2';
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
            var sidebarRoot = firstLink.closest('.SideBar__Root-sc-161w9oi-0, [class*="SideBar__Root-"]') || document.querySelector('.SideBar__Root-sc-161w9oi-0, [class*="SideBar__Root-"]');
            var setCollapsed = function(){
                var collapsed = !!(sidebarRoot && sidebarRoot.classList.contains('sidebar-collapsed'));
                link.classList.toggle('mtm-nav-collapsed', collapsed);
            };
            setCollapsed();
            if(sidebarRoot){
                var collapseObs = new MutationObserver(function(){ setCollapsed(); });
                collapseObs.observe(sidebarRoot, { attributes: true, attributeFilter: ['class'] });
                window.MTM_SIDENAV_COLLAPSE_OBS = collapseObs;
            }
        }

        // Try multiple times as sidebar mounts
        var tries = 0; var intv = setInterval(function(){
            tries++; ensure(); if(document.getElementById('mtm-obf-master') || tries > 20) clearInterval(intv);
        }, 500);
    })();
})();


