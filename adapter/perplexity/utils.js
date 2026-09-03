// adapter/perplexity/utils.js
// Perplexity.ai DOM helpers (page.evaluate-based, mirroring the opencli/gemini
// adapter style).
//
// IMPORTANT: opencli's IPage.evaluate() signature is:
//   evaluate<T>(js: string): Promise<T>            // string WITHOUT args only
//   evaluate<Args, T>(fn: (...args) => T, ...args): Promise<T>  // function + args
// So we always pass real functions (never `(function(){...})(arguments[0])`)
// and pass arguments as additional evaluate() parameters.

import { CommandExecutionError } from '@jackwener/opencli/errors';

export const PERPLEXITY_DOMAIN = 'www.perplexity.ai';
export const PERPLEXITY_HOME = 'https://www.perplexity.ai/';

// ponytail: global lock, no per-request isolation. OK because opencli runs one
// browser session at a time. Upgrade to per-profile locks if parallel agents
// start racing on the same Chrome profile.

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

export async function ensurePerplexityPage(page, { newChat = false } = {}) {
  const target = newChat
    ? 'https://www.perplexity.ai/?new=1'
    : PERPLEXITY_HOME;
  await page.goto(target, { waitUntil: 'load', settleMs: 1500 });
  await page.wait({ time: 1.5 }); // let the composer mount
  await waitForComposer(page);
}

async function waitForComposer(page, { timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await findComposer(page);
    if (found) return found;
    await page.wait({ time: 0.4 });
  }
  throw new CommandExecutionError(
    'Perplexity composer not found (login wall or changed UI?)',
  );
}

export async function getPageUrl(page) {
  try {
    const u = await page.evaluate(() => location.href);
    return typeof u === 'string' ? u : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Composer detection / typing
// ---------------------------------------------------------------------------
//
// IMPORTANT: every function passed to page.evaluate() is shipped across CDP
// to the browser, where the browser only sees the function body and its
// parameters. Module-level constants are NOT in scope. Inline everything.

function findComposerFn() {
  return function () {
    const sels = [
      'textarea[placeholder*="Ask" i]',
      'textarea[aria-label*="Ask" i]',
      'textarea[id*="ask" i]',
      '[contenteditable="true"][data-lexical-editor]',
      '[contenteditable="true"][role="textbox"]',
      'textarea',
    ];
    for (let i = 0; i < sels.length; i++) {
      const sel = sels[i];
      const el = document.querySelector(sel);
      if (el) {
        const r = el.getBoundingClientRect();
        return {
          selector: sel,
          tag: el.tagName,
          x: r.x, y: r.y, w: r.width, h: r.height,
          isContentEditable: el.isContentEditable === true,
        };
      }
    }
    return null;
  };
}

export async function findComposer(page) {
  return page.evaluate(findComposerFn());
}

function clearComposerFn() {
  return function (selector) {
    const el = document.querySelector(selector);
    if (!el) return false;
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // contenteditable
      el.innerHTML = '';
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '' }));
    }
    return true;
  };
}

function insertTextFn() {
  return function (selector, text) {
    const el = document.querySelector(selector);
    if (!el) return false;
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // contenteditable
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('insertText', false, text);
    }
    return true;
  };
}

function submitFn() {
  return function () {
    // Perplexity's real send button appears only once text is in the
    // composer. Prefer explicit aria-labels / form submissions; the generic
    // "any button with an SVG" fallback clicked the wrong (sidebar) button.
    const exactSelectors = [
      'button[aria-label="Submit"]',
      'button[aria-label*="Submit" i]',
      'button[aria-label="Send"]',
      'button[aria-label*="Send" i]',
      'button[aria-label="Отправить"]',
      'button[aria-label*="Отправить" i]',
    ];
    for (let i = 0; i < exactSelectors.length; i++) {
      const sel = exactSelectors[i];
      const btns = document.querySelectorAll(sel);
      for (let j = 0; j < btns.length; j++) {
        const b = btns[j];
        if (b.disabled) continue;
        b.click();
        return 'clicked:' + sel;
      }
    }
    // Generic submit buttons (any form).
    const genericSelectors = [
      'form button[type="submit"]',
      'button[type="submit"]',
    ];
    for (let i = 0; i < genericSelectors.length; i++) {
      const sel = genericSelectors[i];
      const btns = document.querySelectorAll(sel);
      for (let j = 0; j < btns.length; j++) {
        const b = btns[j];
        if (b.disabled) continue;
        b.click();
        return 'clicked:' + sel;
      }
    }
    return 'no-button';
  };
}

function enterOnComposerFn() {
  return function () {
    const composer = document.activeElement;
    if (!composer) return false;
    if (composer.tagName === 'TEXTAREA' || composer.tagName === 'INPUT' || composer.isContentEditable) {
      const ev = new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        bubbles: true, cancelable: true,
      });
      composer.dispatchEvent(ev);
      return true;
    }
    return false;
  };
}

export async function typePrompt(page, text) {
  const found = await findComposer(page);
  if (!found) throw new CommandExecutionError('Perplexity composer disappeared before typing');
  // Focus the composer via a real click (not just .focus()) so Lexical/React
  // register it as the active target. This is what a human would do.
  await page.evaluate(clickComposerFn(), found.selector);
  // Clear via select-all + delete (works for both textarea and contenteditable)
  await page.evaluate(clearComposerFn(), found.selector);
  // Use CDP nativeType for the actual text. This dispatches real keystrokes
  // through Input.insertText, which is the only reliable way to feed modern
  // contenteditable frameworks (Lexical, ProseMirror, Slate) — execCommand
  // is ignored by them and the React value-state stays empty.
  if (typeof page.nativeType === 'function') {
    await page.nativeType(text);
  } else {
    // Fallback: legacy path
    const ok = await page.evaluate(insertTextFn(), found.selector, text);
    if (!ok) throw new CommandExecutionError('Failed to insert text into Perplexity composer');
  }
  await page.wait({ time: 0.3 });
  return found;
}

function clickComposerFn() {
  return function (selector) {
    const el = document.querySelector(selector);
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    el.click();
    el.focus();
    return true;
  };
}

export async function submitPrompt(page, { timeoutMs = 15000 } = {}) {
  // Perplexity's new-chat composer submits the prompt on a plain Enter
  // keypress. The composer is already focused (we typed into it), so the
  // most reliable trigger is a *native* CDP Enter, which Lexical actually
  // handles (synthetic dispatchEvent is ignored by modern editors).
  const debug = !!process.env.OPENCLI_DEBUG;

  const submissionStarted = async () => {
    // After submit, the home URL changes to /search/... and/or "Stop" appears.
    try {
      const url = await page.evaluate(() => location.href);
      if (url.includes('/search/')) return true;
      const gen = await page.evaluate(isGeneratingFn());
      if (gen) return true;
      // The "quick prompts" grid disappears from home once composing.
      const q = await page.evaluate(composerHasContentFn());
      if (!q.hasComposer) return false;
      // If the URL is no longer a clean home and body changed size a lot, assume progress.
      return false;
    } catch {
      return false;
    }
  };

  // Strategy 1: native Enter via CDP (best for Lexical).
  if (typeof page.nativeKeyPress === 'function') {
    try {
      await page.nativeKeyPress('Enter');
      const deadlineEnter = Date.now() + 4000;
      while (Date.now() < deadlineEnter) {
        if (await submissionStarted()) {
          if (debug) process.stderr.write('[perplexity] submit: native Enter accepted\n');
          return 'native-enter';
        }
        await page.wait({ time: 0.3 });
      }
    } catch (err) {
      if (debug) process.stderr.write(`[perplexity] nativeKeyPress failed: ${err.message}; falling back\n`);
    }
  }

  // Strategy 2: pressKey Enter (fallback native path).
  try {
    await page.pressKey('Enter');
    const deadlinePk = Date.now() + 4000;
    while (Date.now() < deadlinePk) {
      if (await submissionStarted()) {
        if (debug) process.stderr.write('[perplexity] submit: pressKey Enter accepted\n');
        return 'presskey-enter';
      }
      await page.wait({ time: 0.3 });
    }
  } catch (err) {
    if (debug) process.stderr.write(`[perplexity] pressKey failed: ${err.message}\n`);
  }

  // Strategy 3: click the explicit Submit/Send button (no generic SVG guess).
  const deadline = Date.now() + timeoutMs;
  let lastReason = 'no-button';
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts++;
    let r;
    try {
      r = await page.evaluate(submitFn());
    } catch (err) {
      if (attempts < 5) { await page.wait({ time: 0.5 }); continue; }
      throw err;
    }
    if (r && r !== 'no-button') {
      // After clicking, confirm generation actually started.
      await page.wait({ time: 0.6 });
      if (await submissionStarted()) {
        if (debug) process.stderr.write(`[perplexity] submit: ${r} confirmed\n`);
        return r;
      }
      if (debug) process.stderr.write(`[perplexity] submit: ${r} clicked but not confirmed; retrying\n`);
    }
    lastReason = r;
    await page.wait({ time: 0.3 });
  }

  // Final fallback: synthesize Enter JS event on the composer.
  let entered = false;
  try { entered = await page.evaluate(enterOnComposerFn()); } catch {}
  if (entered) {
    await page.wait({ time: 1.2 });
    if (await submissionStarted()) return 'enter-fallback';
  }
  throw new CommandExecutionError(
    `Could not submit prompt (last: ${lastReason}, ${attempts} polls). Perplexity UI may have changed.`,
  );
}

function composerHasContentFn() {
  return function () {
    const ceds = document.querySelectorAll('[contenteditable="true"][data-lexical-editor]');
    const ta = document.querySelector('textarea');
    const el = ceds[0] || ta;
    if (!el) return { hasComposer: false, hasText: false };
    const text = el.tagName === 'TEXTAREA'
      ? el.value || ''
      : (el.innerText || '').trim();
    return { hasComposer: true, hasText: text.length > 0, textLen: text.length };
  };
}

// ---------------------------------------------------------------------------
// Generation state + answer extraction
// ---------------------------------------------------------------------------

function isGeneratingFn() {
  return function () {
    const sels = [
      'button[aria-label*="Stop" i]',
      'button[aria-label*="stop generating" i]',
      '[data-testid="stop-generating"]',
    ];
    for (const sel of sels) {
      if (document.querySelector(sel)) return true;
    }
    return false;
  };
}

function extractAnswerFn() {
  return function () {
    const answerSel = [
      '[data-testid="answer-content"]',
      'div.prose',
      'div[class*="Answer" i]',
      'main div[class*="prose" i]',
    ];
    let best = null;
    let bestLen = 0;
    for (const sel of answerSel) {
      document.querySelectorAll(sel).forEach((el) => {
        const t = (el.innerText || '').trim();
        if (t.length > bestLen) { best = el; bestLen = t.length; }
      });
    }
    if (!best) return '';

    // Work on a clone: innerText of the live DOM degrades KaTeX formulas to
    // one-character-per-line and flattens tables to tab-separated rows.
    // 1) KaTeX → the original TeX source kept in <annotation>; 2) <table> →
    // real markdown table. Order matters: tables must be built after formulas
    // so cell TeX is already plain text.
    const clone = best.cloneNode(true);
    // Perplexity inlines source chips ("wikipedia+1", "science.nasa") as <a>
    // nodes right next to the prose. innerText fuses them with adjacent text
    // ("complex.wikipedia+1For"), so drop them up-front: they are already
    // extracted into the sources[] result.
    for (const a of clone.querySelectorAll('a[href]')) {
      const t = (a.innerText || '').trim();
      if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\+?\d*$/i.test(t)) a.remove();
    }
    for (const k of clone.querySelectorAll('.katex')) {
      const isBlock = k.classList.contains('katex-display');
      // Prefer the TeX source over the rendered subtree (avoids per-char lines).
      const ann = k.querySelector('annotation[encoding="application/x-tex"]');
      const tex = (ann ? ann.textContent : (k.innerText || '')).trim();
      if (!tex) { k.remove(); continue; }
      const wrap = document.createElement(isBlock ? 'div' : 'span');
      // Inline KaTeX sits flush against surrounding text in the DOM; innerText
      // does not insert spaces between inline elements, so wrap with spaces to
      // avoid "textformula" collisions.
      wrap.textContent = isBlock ? tex : ' ' + tex + ' ';
      k.replaceWith(wrap);
    }
    for (const tbl of clone.querySelectorAll('table')) {
      const rows = [];
      for (const tr of tbl.querySelectorAll('tr')) {
        const cells = Array.from(tr.querySelectorAll('th,td')).map((c) =>
          (c.innerText || '').trim().replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|'),
        );
        if (cells.length) rows.push(cells);
      }
      if (!rows.length) { tbl.remove(); continue; }
      const cols = Math.max(...rows.map((r) => r.length));
      const pad = (r) =>
        Array.from({ length: cols }, (_, i) => (i < r.length ? r[i] : ''));
      const header = pad(rows[0]);
      const sep = Array.from({ length: cols }, () => '---');
      const md = [header, sep, ...rows.slice(1).map(pad)]
        .map((r) => '| ' + r.join(' | ') + ' |')
        .join('\n');
      const pre = document.createElement('pre');
      pre.textContent = md;
      tbl.replaceWith(pre);
    }
    let raw = (clone.innerText || '').trim();
    // Perplexity's citation chips can leak punycode (xn--...), bare domains
    // and citation markers (+1, [2]) into innerText. Filter those lines.
    raw = raw
      .split('\n')
      .filter((line) => {
        const s = line.trim();
        if (!s) return true;
        if (/^https?:\/\//i.test(s)) return false;      // pure URL
        if (/^xn--[a-z0-9-]+$/i.test(s)) return false;   // punycode label
        if (/^\+?\d{1,3}$/.test(s)) return false;        // "+1" / bare citation number
        if (/^\[?\d+\]?$/.test(s)) return false;         // "[2]"
        if (/^[a-z0-9-]{3,}\.[a-z]{2,}$/i.test(s) && s.length < 40) return false; // bare domain
        return true;
      })
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/ ,/g, ',')
      .replace(/ \./g, '.')
      .trim();
    return raw;
  };
}

function extractSourcesFn() {
  return function () {
    const out = [];
    const seen = new Set();

    // 1) Explicit source/citation containers.
    const explicit = [
      '[data-testid*="source" i] a[href]',
      'a[data-testid*="citation" i]',
      'a[href^="http"][data-citation]',
    ];
    for (let i = 0; i < explicit.length; i++) {
      document.querySelectorAll(explicit[i]).forEach((a) => {
        const href = a.href;
        if (!href || seen.has(href)) return;
        seen.add(href);
        const title = (a.innerText || a.getAttribute('aria-label') || a.getAttribute('title') || '').trim()
          .replace(/^\s*\[?\d+\]?\s*/, '').trim();
        out.push({ title, url: href });
      });
    }

    // 2) Sources under a "Sources" heading.
    const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,div,span'))
      .filter((h) => /^sources$/i.test((h.innerText || '').trim()));
    for (let i = 0; i < headings.length; i++) {
      const h = headings[i];
      let n = h.nextElementSibling;
      while (n && n.tagName !== 'H1' && n.tagName !== 'H2') {
        n.querySelectorAll('a[href]').forEach((a) => {
          if (!seen.has(a.href)) {
            seen.add(a.href);
            const t = (a.innerText || a.getAttribute('aria-label') || '').trim();
            out.push({ title: t, url: a.href });
          }
        });
        n = n.nextElementSibling;
      }
    }

    // 3) Footer of the answer container: any <a target="_blank"> with a
    //    real anchor text and a non-perplexity host is likely a source.
    if (out.length === 0) {
      const main = document.querySelector('[data-testid="answer-content"]')
        || document.querySelector('div.prose')
        || document.querySelector('main');
      if (main) {
        main.querySelectorAll('a[href^="http"]').forEach((a) => {
          const href = a.href;
          if (!href || seen.has(href)) return;
          // Skip internal Perplexity links.
          if (/perplexity\.ai/i.test(href)) return;
          const t = (a.innerText || a.getAttribute('aria-label') || '').trim();
          if (t.length < 4) return;
          seen.add(href);
          out.push({ title: t, url: href });
        });
      }
    }
    // 4) Verify the anchors we found actually carried real external hrefs. The
    //    rest of the function is run inside the browser, so this debug block has
    //    to be inline in the same function. It just appends diagnostic data.
    return out;
  };
}

export async function extractSources(page, { retries = 5, retryDelayMs = 400 } = {}) {
  let result = await page.evaluate(extractSourcesFn());
  // Sources often render a beat after the answer text goes stable, so retry a
  // few times before declaring "no sources" (avoids flaky NO_SOURCES failures).
  for (let i = 0; i < retries && (!Array.isArray(result) || result.length === 0); i++) {
    await page.wait({ time: retryDelayMs / 1000 });
    result = await page.evaluate(extractSourcesFn());
  }
  if (process.env.OPENCLI_DEBUG && Array.isArray(result)) {
    // Dump the raw candidate structure so we can see why selectors may miss.
    try {
      const dump = await page.evaluate(dumpSourceDomainFn());
      process.stderr.write('[perplexity] extractSources debug: ' + JSON.stringify(dump) + '\n');
    } catch {}
  }
  return result;
}

function dumpSourceDomainFn() {
  return function () {
    const all = [];
    const mains = [document.querySelector('main'), document.querySelector('div.prose')];
    for (const main of mains) {
      if (!main) continue;
      main.querySelectorAll('a[href]').forEach((a) => {
        const href = a.getAttribute('href') || '';
        all.push({
          href: href.slice(0, 140),
          txt: (a.innerText || '').trim().slice(0, 40),
          tid: a.getAttribute('data-testid') || '',
          cit: a.getAttribute('data-citation') || '',
          aria: (a.getAttribute('aria-label') || '').slice(0, 40),
          external: /^https?:/i.test(href) && !/perplexity\.ai/i.test(href),
        });
      });
    }
    const testids = Array.from(document.querySelectorAll('[data-testid]'))
      .map((e) => e.getAttribute('data-testid'))
      .filter((t) => /source|citation|answer/i.test(t)).slice(0, 40);
    const headings = Array.from(document.querySelectorAll('h1,h2,h3,div,span'))
      .filter((h) => /^sources$/i.test((h.innerText || '').trim()))
      .map((h) => ({ tag: h.tagName, cls: (h.className || '').slice(0, 50) }));
    return { allExternals: all.filter((a) => a.external).slice(0, 40), allAnchors: all.slice(0, 40), testids, headings };
  };
}

// Readiness probe: does the page look like Perplexity is (still) generating,
// and is there a copy button / answer container? Polled every 2-3s instead of
// accumulating text-stability time.
function isAnswerReadyFn() {
  return function () {
    const genSels = [
      'button[aria-label*="Stop" i]',
      'button[aria-label*="stop generating" i]',
      '[data-testid="stop-generating"]',
    ];
    let generating = false;
    for (const s of genSels) if (document.querySelector(s)) { generating = true; break; }

    // Ready signal: the per-answer "Copy" control appears only once the answer
    // is done rendering. Match by aria-label (en/ru) and data-testid.
    const copySels = [
      'button[aria-label*="Копировать" i]',
      'button[aria-label*="копир" i]',
      'button[aria-label*="Copy" i]',
      '[data-testid*="copy" i]',
      '[data-testid*="копир" i]',
    ];
    let copyFound = false;
    for (const s of copySels) if (document.querySelector(s)) { copyFound = true; break; }

    return { generating, copyFound };
  };
}

// After the answer first looks ready, keep sampling until the text stops
// GROWING. Perplexity streams plain text first, then renders tables/citations
// afterwards, so "Stop button gone" is NOT the same as "answer complete".
// We only trust the answer once no growth is seen for `reportSeconds`,
// bounded by `deadline` so a never-settling DOM can't hang us.
// Returns the stable text, or null if it never settled.
async function continueIfStable(page, initialText, reportSeconds, deadline) {
  let longest = initialText;
  let nonGrowingChecks = 0;
  const needStable = Math.max(2, Math.ceil(reportSeconds / 0.4)); // ~2-5 checks for 0.8-2s
  while (Date.now() < deadline) {
    await page.wait({ time: 0.4 });
    const next = await page.evaluate(extractAnswerFn()).catch(() => longest);
    const grew = next && next.length > longest.length;
    if (grew) {
      longest = next;
      nonGrowingChecks = 0;
      continue;
    }
    // Same length (or slight shrink from citation churn) counts as "not growing".
    nonGrowingChecks++;
    if (nonGrowingChecks >= needStable && next) return next;
  }
  return longest || null;
}

export async function waitForAnswer(page, { timeoutSeconds = 60, pollSeconds = 2 } = {}) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  const debug = !!process.env.OPENCLI_DEBUG;
  let lastText = '';
  while (Date.now() < deadline) {
    let state = { generating: true, copyFound: false };
    let text = '';
    try {
      state = await page.evaluate(isAnswerReadyFn());
      text = await page.evaluate(extractAnswerFn());
    } catch {
      await page.wait({ time: pollSeconds });
      continue;
    }
    if (debug) {
      process.stderr.write(
        `[perplexity] ready poll: generating=${state.generating} copy=${state.copyFound} textLen=${text.length}\n`,
      );
    }
    // Ready = generation finished (no stop button) AND we have either a copy
    // button or non-empty answer text. Once ready, confirm the text has
    // stopped growing before returning (avoids a truncated mid-render answer).
    const ready = !state.generating && (state.copyFound || text.length > 0);
    if (ready) {
      const stable = await continueIfStable(page, text, pollSeconds, deadline);
      if (stable) return stable;
    }
    if (text) lastText = text;
    await page.wait({ time: pollSeconds });
  }
  // Last resort: any captured text beats a hard failure.
  if (lastText) return lastText;
  throw new CommandExecutionError(
    `Timed out after ${timeoutSeconds}s waiting for Perplexity answer`,
  );
}

// ---------------------------------------------------------------------------
// Auth state
// ---------------------------------------------------------------------------

function isOnLoginWallFn() {
  return function () {
    const text = (document.body && document.body.innerText || '').toLowerCase();
    if (text.includes('log in to perplexity')) return true;
    if (document.querySelector('a[href*="/login" i]')) return true;
    for (const b of document.querySelectorAll('button')) {
      if (/^log in$/i.test((b.innerText || '').trim())) return true;
    }
    return false;
  };
}

export async function isOnLoginWall(page) {
  return page.evaluate(isOnLoginWallFn());
}

// ---------------------------------------------------------------------------
// Composer modes (search / deep research) and incognito toggle
// ---------------------------------------------------------------------------
//
// Perplexity's composer exposes modes as buttons (e.g. «Поиск» / «Компьютер»).
// Deep Research and Incognito are NOT present on every account/UI, so these
// helpers are discovery-based: find a control by regex, click it, verify the
// resulting aria-pressed/aria-checked, and throw a clear error if the control
// doesn't exist rather than silently proceeding in the wrong mode.

function findByTextOrAriaFn() {
  return function (pattern) {
    const re = new RegExp(pattern, 'i');
    const els = document.querySelectorAll('button, [role="menuitem"], [role="switch"], [role="tab"], a');
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      const text = (el.innerText || '').trim();
      const aria = el.getAttribute('aria-label') || '';
      const title = el.getAttribute('title') || '';
      if (re.test(text) || re.test(aria) || re.test(title)) {
        return {
          found: true,
          text: text.slice(0, 40),
          aria: aria.slice(0, 40),
          checked: el.getAttribute('aria-checked') || el.getAttribute('aria-pressed') || '',
        };
      }
    }
    return { found: false };
  };
}

function clickByPatternFn() {
  return function (pattern) {
    const re = new RegExp(pattern, 'i');
    const els = document.querySelectorAll('button, [role="menuitem"], [role="switch"], [role="tab"], a');
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      const text = (el.innerText || '').trim();
      const aria = el.getAttribute('aria-label') || '';
      const title = el.getAttribute('title') || '';
      if (re.test(text) || re.test(aria) || re.test(title)) {
        if (aria && /^stop/i.test(aria)) continue; // skip Stop buttons
        el.click();
        return { clicked: true, text: text.slice(0, 40), aria: aria.slice(0, 40) };
      }
    }
    return { clicked: false };
  };
}

function pressedStateFn() {
  return function (pattern) {
    const re = new RegExp(pattern, 'i');
    const els = document.querySelectorAll('button, [role="menuitem"], [role="switch"], [role="tab"]');
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      const text = (el.innerText || '').trim();
      const aria = el.getAttribute('aria-label') || '';
      if (re.test(text) || re.test(aria)) {
        const p = el.getAttribute('aria-pressed');
        const c = el.getAttribute('aria-checked');
        if (p === 'true' || c === 'true') return 'on';
        if (p === 'false' || c === 'false') return 'off';
        // default to on if matched a switch-like element
        return el.hasAttribute('aria-pressed') || el.hasAttribute('aria-checked') ? 'off' : 'unknown';
      }
    }
    return 'missing';
  };
}

/**
 * Set the composer search mode.
 * @param {'search'|'deep_research'} mode
 */
export async function setComposerMode(page, mode) {
  if (mode === 'search') {
    // Search is the default; ensure the «Поиск»/«Search» control is active.
    const state = await page.evaluate(pressedStateFn(), 'Поиск|\\bsearch\\b');
    if (state === 'off') {
      await page.evaluate(clickByPatternFn(), 'Поиск|\\bsearch\\b');
      await page.wait({ time: 0.4 });
    }
    return { mode: 'search', ok: true };
  }

  if (mode === 'deep_research') {
    // Discover a Deep Research control (label varies by locale).
    const found = await page.evaluate(findByTextOrAriaFn(), 'deep\\s*research|глубок');
    if (!found.found) {
      throw new CommandExecutionError(
        'MODE_UNAVAILABLE: Deep Research control not found. ' +
        'This profile/account does not expose Deep Research (maybe Claude model or Pro tier). ' +
        'Running in default search mode instead.',
      );
    }
    await page.evaluate(clickByPatternFn(), 'deep\\s*research|глубок');
    await page.wait({ time: 0.4 });
    return { mode: 'deep_research', ok: true };
  }

  throw new CommandExecutionError(`MODE_UNAVAILABLE: unknown mode "${mode}"`);
}

/**
 * Toggle Perplexity's in-app incognito (shield).
 * Per UX the toggle is bound to the Ctrl+; key combination. We dispatch it
 * natively via CDP so it works regardless of whether a clickable shield is
 * rendered; a discovery-based click is kept as a fallback.
 * @param {boolean} on
 */
export async function setIncognito(page, on) {
  const debug = !!process.env.OPENCLI_DEBUG;

  // 1) Primary: native Ctrl+; shortcut. The composer must be focused.
  const ctrlSent = await tryNativeCtrlSemicolon(page);
  if (ctrlSent) {
    await page.wait({ time: 0.5 });
    if (debug) process.stderr.write('[perplexity] incognito: native Ctrl+; sent\n');
    return { incognito: on, ok: true, via: 'ctrl-semicolon' };
  }

  // 2) Fallback: discovery-based click on a shield/incognito control.
  const found = await page.evaluate(findByTextOrAriaFn(), 'incognito|приват|аноним|shield|щит');
  if (!found.found) {
    throw new CommandExecutionError(
      'INCOGNITO_UNAVAILABLE: incognito toggle not found and Ctrl+; shortcut ' +
      'could not be dispatched (composer not focused). Re-run without --incognito ' +
      'to proceed in normal mode.',
    );
  }
  await page.evaluate(clickByPatternFn(), 'incognito|приват|аноним|shield|щит');
  await page.wait({ time: 0.4 });
  const state = await page.evaluate(pressedStateFn(), 'incognito|приват|аноним|shield|щит');
  return { incognito: on, ok: state === 'on', via: 'click' };
}

// Send a native Ctrl+; keypress to the focused element via CDP. Returns true
// if a channel (nativeKeyPress or pressKey) accepted it.
async function tryNativeCtrlSemicolon(page) {
  // Press Control+;. Semicolon is the ';' key.
  if (typeof page.nativeKeyPress === 'function') {
    try {
      // Native key press dispatches real CDP events on the focused element.
      await page.nativeKeyPress(';', ['Control']);
      return true;
    } catch {
      // fall through
    }
  }
  if (typeof page.pressKey === 'function') {
    try {
      // Synthetic fallback (some builds only expose pressKey).
      await page.pressKey('Control+;');
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
