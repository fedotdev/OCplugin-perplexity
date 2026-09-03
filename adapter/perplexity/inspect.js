// adapter/perplexity/inspect.js
// opencli perplexity inspect "<question>" --keep-tab true
//
// Diagnostic command: navigates to Perplexity, types the question, tries to
// submit, and dumps a detailed state snapshot to --output so we can see the
// real DOM (composer, buttons, answer containers, URL) without guessing.

import { promises as fs } from 'node:fs';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { PERPLEXITY_DOMAIN } from './utils.js';
import {
  ensurePerplexityPage,
  findComposer,
  typePrompt,
  submitPrompt,
  waitForAnswer,
  extractSources,
  getPageUrl,
  isOnLoginWall,
} from './utils.js';

export default cli({
  site: 'perplexity',
  name: 'inspect',
  description: 'Diagnose Perplexity page state (composer, buttons, answer) — debug tool',
  access: 'write',
  domain: PERPLEXITY_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  defaultFormat: 'json',
  args: [
    { name: 'question', required: false, positional: true, help: 'Optional question to type (does not need to submit)' },
    { name: 'output', type: 'string', required: false, help: 'Write JSON diagnostics to this file' },
    { name: 'timeout', type: 'int', required: false, default: 40, help: 'Max seconds to wait after submit' },
    { name: 'click', type: 'string', required: false, help: 'Click a control whose text/aria equals this, then dump menu items' },
  ],
  func: async (page, kwargs) => {
    const q = kwargs.question ? String(kwargs.question) : null;
    const output = kwargs.output ? String(kwargs.output) : null;
    const clickText = kwargs.click ? String(kwargs.click) : null;
    const timeout = Math.max(10, Math.min(120, Number(kwargs.timeout) || 40));

    const state = {
      ok: true,
      url: null,
      login_wall: null,
      composer: null,
      typed: false,
      submit: null,
      answer_len: 0,
      answer_head: '',
      generating: null,
      sources: [],
      buttons: [],
    };

    const snapshotButtons = async () => {
      try {
        const btns = await page.evaluate(function () {
          const out = [];
          const els = document.querySelectorAll('button');
          for (let i = 0; i < Math.min(els.length, 40); i++) {
            const b = els[i];
            const aria = (b.getAttribute('aria-label') || '');
            const txt = (b.innerText || '').trim().slice(0, 40);
            const hasSvg = !!b.querySelector('svg');
            const disabled = b.disabled;
            const visible = b.offsetWidth > 0 && b.offsetHeight > 0;
            out.push({
              aria: aria.slice(0, 60),
              txt,
              hasSvg,
              disabled,
              visible,
            });
          }
          return out;
        });
        state.buttons = btns;
      } catch (err) {
        state.buttons = [{ error: String(err) }];
      }
    };

    try {
      await ensurePerplexityPage(page, { newChat: false });
    } catch (err) {
      state.ok = false;
      state.error = String(err);
      await snapshotButtons();
      if (output) await fs.writeFile(output, JSON.stringify(state, null, 2), 'utf-8');
      return state;
    }

    state.url = await getPageUrl(page);
    state.login_wall = await isOnLoginWall(page);
    state.composer = await findComposer(page).catch(() => null);
    await snapshotButtons();
    // Composer-area tools: mode toggles, incognito shield, etc.
    state.tools = await page.evaluate(dumpComposerToolsFn()).catch(() => []);
    // Whole-page keyword scan for incognito / deep research / shield controls
    state.keywords = await page.evaluate(dumpKeywordsFn()).catch(() => []);

    // If --click given: click the control by visible text/aria, wait, dump menu.
    if (clickText) {
      const clicked = await page.evaluate(clickByTextFn(), clickText).catch((err) => 'ERR:' + err.message);
      state.click_result = String(clicked);
      await page.wait({ time: 0.8 });
      state.menu_items = await page.evaluate(dumpMenusFn()).catch(() => []);
    }

    if (q) {
      try {
        await typePrompt(page, q);
        state.typed = true;
        const typedCheck = await page.evaluate(function () {
          const textareas = document.querySelectorAll('textarea');
          const ceds = document.querySelectorAll('[contenteditable="true"]');
          return {
            textareaValues: Array.from(textareas).map((t) => (t.value || '').slice(0, 60)),
            contenteditableTexts: Array.from(ceds).map((c) => (c.innerText || '').slice(0, 60)),
          };
        });
        state.composer_after_type = typedCheck;
      } catch (err) {
        state.type_error = String(err);
      }

      try {
        await submitPrompt(page, { timeoutMs: 8000 });
        state.submit = 'ok';
      } catch (err) {
        state.submit = String(err);
      }

      try {
        const start = Date.now();
        const answer = await waitForAnswer(page, { timeoutSeconds: timeout, stableMs: 800 });
        state.answer_len = answer.length;
        state.answer_head = answer.slice(0, 500);
        state.answer_elapsed_ms = Date.now() - start;
      } catch (err) {
        state.wait_error = String(err);
      }

      state.url_after = await getPageUrl(page);
      state.sources = await extractSources(page).catch(() => []);
      try {
        state.generating = await page.evaluate(function () {
          const sels = ['button[aria-label*="Stop" i]', '[data-testid="stop-generating"]'];
          for (const s of sels) if (document.querySelector(s)) return true;
          return false;
        });
      } catch {}

      // Whatever text is currently on the page (whole body as fallback)
      try {
        state.body_text_len = await page.evaluate(function () {
          return (document.body.innerText || '').length;
        });
      } catch {}
    }

    if (output) await fs.writeFile(output, JSON.stringify(state, null, 2), 'utf-8');
    return state;
  },
});

// Scan the composer area for mode toggles / shield (incognito) / focus-mode
// buttons. Self-contained (runs inside the browser via page.evaluate).
function dumpComposerToolsFn() {
  return function () {
    const out = [];
    const composer = document.querySelector(
      '[contenteditable="true"][data-lexical-editor], textarea',
    );
    if (!composer) return out;
    // Walk up a few levels from the composer and collect interactive elements.
    let host = composer.parentElement;
    for (let depth = 0; depth < 6 && host; depth++) {
      const els = host.querySelectorAll('button, [role="button"], [role="menuitem"], [role="tab"]');
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        const info = {
          tag: el.tagName,
          role: el.getAttribute('role') || '',
          aria: (el.getAttribute('aria-label') || '').slice(0, 60),
          title: (el.getAttribute('title') || '').slice(0, 60),
          text: (el.innerText || '').trim().slice(0, 40),
          selected: el.getAttribute('aria-selected') || el.getAttribute('aria-checked') || '',
          hasSvg: !!el.querySelector('svg'),
          pressed: el.getAttribute('aria-pressed') || '',
          css: (function () {
            let p = el;
            let path = '';
            for (let d = 0; d < 5 && p && p.nodeType === 1; d++) {
              const cls = (el.classList && el.classList.length)
                ? '.' + Array.from(el.classList).slice(0, 3).join('.')
                : '';
              path = p.tagName.toLowerCase() + cls + '>' + path;
              p = p.parentElement;
            }
            return path.replace(/>$/, '');
          })(),
        };
        const sig = [info.aria, info.title, info.text].join('|');
        if (!out.some((o) => [o.aria, o.title, o.text].join('|') === sig)) {
          out.push(info);
        }
      }
      host = host.parentElement;
    }
    return out;
  };
}

// Whole-page: find elements (buttons/links/menuitems) whose text/aria/title
// mentions incognito, private, deep research, etc. Self-contained.
function dumpKeywordsFn() {
  return function () {
    const needles = [
      'incognito', 'inprivate', 'privat', 'приват', 'глубок', 'deep research',
      'щит', 'shield', 'quick', 'быстр', 'фокус', 'focus mode', 'режим',
    ];
    const out = [];
    const seen = new Set();
    const candidates = document.querySelectorAll(
      'button, a, [role="menuitem"], [role="tab"], [role="switch"], label',
    );
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      const hay = [
        el.getAttribute('aria-label') || '',
        el.getAttribute('title') || '',
        (el.innerText || '').trim(),
      ].join(' ').toLowerCase();
      for (let n = 0; n < needles.length; n++) {
        if (hay.indexOf(needles[n]) !== -1) {
          const sig = [el.tagName, el.getAttribute('aria-label') || '', (el.innerText || '').trim()].join('|');
          if (!seen.has(sig)) {
            seen.add(sig);
            out.push({
              tag: el.tagName,
              role: el.getAttribute('role') || '',
              aria: (el.getAttribute('aria-label') || '').slice(0, 70),
              text: (el.innerText || '').trim().slice(0, 50),
              checked: el.getAttribute('aria-checked') || '',
              title: (el.getAttribute('title') || '').slice(0, 50),
            });
          }
          break;
        }
      }
    }
    return out;
  };
}

// Click an element whose visible text or aria-label equals the needle.
function clickByTextFn() {
  return function (needle) {
    const els = document.querySelectorAll('button, a, [role="menuitem"], [role="tab"], [role="switch"]');
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      const text = (el.innerText || '').trim();
      const aria = el.getAttribute('aria-label') || '';
      if (text === needle || aria === needle) {
        el.click();
        return 'clicked:' + (text || aria);
      }
    }
    // case-insensitive partial
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      const text = (el.innerText || '').trim();
      const aria = el.getAttribute('aria-label') || '';
      if ((text && text.toLowerCase().indexOf(needle.toLowerCase()) !== -1) ||
          (aria && aria.toLowerCase().indexOf(needle.toLowerCase()) !== -1)) {
        el.click();
        return 'clicked-partial:' + (text || aria);
      }
    }
    return 'not-found';
  };
}

// Dump open dropdown/context menus (role=menu, menuitem, option, listbox).
function dumpMenusFn() {
  return function () {
    const out = [];
    const sels = [
      '[role="menu"] [role="menuitem"]',
      '[role="menuitem"]',
      '[role="tabpanel"] [role="tab"]',
      '[role="listbox"] [role="option"]',
      '[role="option"]',
      '[role="switch"]',
      'div[class*="option"][class*="reset"] span',
    ];
    const seen = new Set();
    for (let s = 0; s < sels.length; s++) {
      const els = document.querySelectorAll(sels[s]);
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        const info = {
          role: el.getAttribute('role') || '',
          aria: (el.getAttribute('aria-label') || '').slice(0, 60),
          text: (el.innerText || '').trim().slice(0, 60),
          selected: el.getAttribute('aria-selected') || el.getAttribute('aria-checked') || '',
          tag: el.tagName,
        };
        const sig = info.role + '|' + info.text + '|' + info.aria;
        if (!seen.has(sig)) {
          seen.add(sig);
          out.push(info);
        }
      }
    }
    return out;
  };
}