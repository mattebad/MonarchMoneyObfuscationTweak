import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const ROUTE_DOMS_DIR = path.join(repoRoot, 'Route DOMs');

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

function detectUserNames(html) {
  const dom = new JSDOM(String(html));
  const { document } = dom.window;
  const names = new Set();

  // Pattern 1: explicit username components (often in sidebar/account menu).
  for (const el of Array.from(document.querySelectorAll('[class*="UserName"]'))) {
    const t = (el.textContent || '').trim();
    if (!t) continue;
    if (t.length > 60) continue;
    // Avoid grabbing currency/ids by mistake.
    if (/\$/.test(t)) continue;
    if (/\d/.test(t)) continue;
    names.add(t);
  }

  // Pattern 2: greeting breadcrumb: "Good afternoon, <Name>!"
  // Example observed in snapshots: "Good afternoon, Matthew!"
  const greetings = ['Good morning,', 'Good afternoon,', 'Good evening,'];
  for (const el of Array.from(document.querySelectorAll('*'))) {
    const t = (el.textContent || '').trim();
    if (!t) continue;
    // Keep this cheap: only inspect short strings that start with "Good ".
    if (t.length > 80) continue;
    if (!t.startsWith('Good ')) continue;
    for (const g of greetings) {
      if (!t.startsWith(g)) continue;
      const m = t.match(/^Good (?:morning|afternoon|evening),\s*([^!]+)!/);
      if (!m) continue;
      const name = (m[1] || '').trim();
      if (!name) continue;
      if (name.length > 60) continue;
      if (/\$/.test(name)) continue;
      if (/\d/.test(name)) continue;
      names.add(name);
    }
  }

  dom.window.close?.();
  return names;
}

function sanitizeHtml(html, namesToRedact) {
  const dom = new JSDOM(String(html));
  const { document, NodeFilter } = dom.window;

  // Remove scripts entirely (can contain embedded data and is irrelevant to DOM-structure tests).
  for (const s of Array.from(document.querySelectorAll('script'))) s.remove();

  const nameRes = Array.from(namesToRedact || []).map((n) => new RegExp(escapeRegExp(n), 'g'));

  // Text-node based redaction.
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

    // Redact non-money sensitive text within FullStory privacy-marked nodes.
    if (inFsExclude && next.indexOf('$') === -1) {
      const trimmed = next.trim();
      if (trimmed && /[A-Za-z0-9]/.test(trimmed)) next = 'REDACTED';
    }
    // Credit score widgets often include the user's name; redact any non-money text within these.
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

function main() {
  const files = readdirSync(ROUTE_DOMS_DIR).filter((f) => f.toLowerCase().endsWith('.html'));
  if (!files.length) {
    console.error(`[sanitize] No .html files found under: ${ROUTE_DOMS_DIR}`);
    process.exit(1);
  }

  const rawByFile = new Map();
  for (const f of files) {
    const p = path.join(ROUTE_DOMS_DIR, f);
    rawByFile.set(f, readFileSync(p, 'utf8'));
  }

  // Detect logged-in user names across all snapshots and redact them everywhere.
  const globalNames = new Set();
  for (const raw of rawByFile.values()) {
    for (const n of detectUserNames(raw)) globalNames.add(n);
  }

  for (const f of files) {
    const p = path.join(ROUTE_DOMS_DIR, f);
    const raw = rawByFile.get(f);
    const sanitized = sanitizeHtml(raw, globalNames);
    writeFileSync(p, sanitized, 'utf8');
    console.log(`[sanitize] Wrote: ${f}`);
  }
}

main();


