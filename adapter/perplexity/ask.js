// adapter/perplexity/ask.js
// opencli perplexity ask "<question>" --format json --output <file>
//
// Returns (and optionally writes) the JSON envelope the opencode-plugin-perplexity
// consumes:
//   { ok, question, answer_markdown, sources, thread_url, elapsed_seconds, trace_id }
//
// On recoverable errors (login wall, session busy) we write the same envelope
// shape with ok:false and a structured error_code, then throw so the CLI
// exits non-zero. The --output file is the canonical artifact the plugin reads.

import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { PERPLEXITY_DOMAIN } from './utils.js';
import {
  ensurePerplexityPage,
  typePrompt,
  submitPrompt,
  waitForAnswer,
  extractSources,
  isOnLoginWall,
  getPageUrl,
  setComposerMode,
  setIncognito,
} from './utils.js';

function normalizeBooleanFlag(value) {
  if (typeof value === 'boolean') return value;
  const s = String(value ?? '').trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}

function nowSec() { return Date.now() / 1000; }

async function writeEnvelope(output, envelope) {
  if (!output) return;
  await fs.writeFile(output, JSON.stringify(envelope, null, 2), 'utf-8');
}

function requirePositiveInt(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    throw new ArgumentError(`--${label} must be a positive integer`);
  }
  return value;
}

export default cli({
  site: 'perplexity',
  name: 'ask',
  description: 'Send a prompt to Perplexity and return the answer with sources',
  access: 'write',
  domain: PERPLEXITY_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  defaultFormat: 'json',
  args: [
    { name: 'question', required: true, positional: true, help: 'Prompt to send' },
    { name: 'output', type: 'string', required: false, help: 'Write JSON envelope to this file' },
    { name: 'timeout', type: 'int', required: false, default: 90, help: 'Max seconds to wait (default: 90)' },
    { name: 'requireSources', type: 'boolean', required: false, default: false, help: 'Fail if no sources returned' },
    { name: 'new', type: 'boolean', required: false, default: false, help: 'Start a new thread (default: false)' },
    { name: 'mode', type: 'string', required: false, default: 'search', help: 'Composer mode: search or deep_research' },
    { name: 'incognito', type: 'boolean', required: false, default: true, help: 'Enable Perplexity in-app incognito (default: on)' },
  ],
  func: async (page, kwargs) => {
    const traceId = randomUUID();
    const startSec = nowSec();
    const question = String(kwargs.question ?? '').trim();
    if (!question) throw new ArgumentError('question cannot be empty');
    if (question.length < 10) throw new ArgumentError('question must be at least 10 characters');
    if (question.length > 4000) throw new ArgumentError('question must be at most 4000 characters');

    const timeout = requirePositiveInt(Number(kwargs.timeout), 'timeout');
    const requireSources = normalizeBooleanFlag(kwargs.requireSources);
    const newChat = normalizeBooleanFlag(kwargs.new);
    const mode = String(kwargs.mode ?? 'search').trim().toLowerCase();
    if (mode !== 'search' && mode !== 'deep_research') {
      throw new ArgumentError('--mode must be "search" or "deep_research"');
    }
    const incognito = normalizeBooleanFlag(kwargs.incognito);
    const output = kwargs.output ? String(kwargs.output) : null;

    async function fail(code, message) {
      const envelope = {
        ok: false,
        trace_id: traceId,
        error_code: code,
        error_message: message,
        elapsed_seconds: Math.round((nowSec() - startSec) * 10) / 10,
      };
      try { await writeEnvelope(output, envelope); } catch {}
      await closeWindow();
      throw new CommandExecutionError(`${code}: ${message}`);
    }

    // OpenCLI keeps the Perplexity window open for persistent sessions
    // (resolveKeepTab forces keepTab=true for siteSession:'persistent'), so the
    // runtime does NOT close the automation window itself. After we answer, the
    // persistent container tab is left at "about:blank" instead of being closed.
    // We have to physically close that tab. Order matters:
    //   1) capture the bound target id (page.getActivePage) BEFORE any close
    //      call clears it,
    //   2) page.closeTab(target)  - physically close the Perplexity/about:blank
    //      tab by its explicit target,
    //   3) page.closeWindow()     - release the session's tab lease (closes the
    //      container window if it's empty; does not kill the user's browser).
    // closeTab WITHOUT an explicit target uses the cached _page, which
    // closeWindow() clears first - so we must pass the id explicitly first.
    const keepTabOpen = String(kwargs.keepTab ?? '').trim().toLowerCase() === 'true';
    async function closeWindow() {
      if (keepTabOpen) return;

      // Capture the bound target id before closeWindow/closeTab can clear it.
      let activePageId;
      if (typeof page.getActivePage === 'function') {
        try { activePageId = page.getActivePage(); } catch {}
      }

      // 3) Release the session lease (turn the container window, not the user's).
      if (typeof page.closeWindow === 'function') {
        try { await page.closeWindow(); process.stderr.write('[perplexity] closeWindow: ok\n'); }
        catch (err) { process.stderr.write('[perplexity] closeWindow failed: ' + (err?.message ?? String(err)) + '\n'); }
      }

      // 1+2) Physically close the tab we drove, using the captured target id.
      if (typeof page.closeTab === 'function') {
        // Try the explicit active-page id first; fall back to a bare closeTab().
        if (typeof activePageId === 'string' && activePageId) {
          try { await page.closeTab(activePageId); process.stderr.write('[perplexity] closeTab(active): ok\n'); return; }
          catch (err) { process.stderr.write('[perplexity] closeTab(active) failed: ' + (err?.message ?? String(err)) + '\n'); }
        }
        try { await page.closeTab(); process.stderr.write('[perplexity] closeTab: ok\n'); return; }
        catch (err) { process.stderr.write('[perplexity] closeTab(#1) failed: ' + (err?.message ?? String(err)) + '\n'); }
      }

      // 2) Fallback: enumerate tabs and close the Perplexity one by target.
      try {
        if (typeof page.tabs === 'function') {
          const tabs = (await page.tabs()) ?? [];
          const target = tabs.find((t) =>
            String(t?.url ?? '').includes('perplexity.ai'),
          );
          if (target) {
            const id = target.page ?? target.targetId ?? target.id;
            process.stderr.write('[perplexity] closeTab(#2) closing tab: ' + JSON.stringify({ url: target?.url, id }) + '\n');
            if (typeof id === 'string' && id) await page.closeTab(id);
            else process.stderr.write('[perplexity] closeTab(#2): tab has no page/target id\n');
            process.stderr.write('[perplexity] closeTab(#2): ok\n');
            return;
          }
          process.stderr.write('[perplexity] closeTab(#2): no perplexity tab found among ' + tabs.length + ' tab(s)\n');
        }
      } catch (err) {
        process.stderr.write('[perplexity] closeTab(#2) failed: ' + (err?.message ?? String(err)) + '\n');
      }
    }

    try {
      await ensurePerplexityPage(page, { newChat });
    } catch (err) {
      return fail('BROWSER_CONNECT', err?.message ?? String(err));
    }

    if (await isOnLoginWall(page)) {
      return fail('AUTH_REQUIRED', 'Perplexity is showing a login wall. Sign in to perplexity.ai in this Chrome profile and retry.');
    }

    // Apply composer mode before typing; incognito is applied AFTER typing so
    // that the Ctrl+; shortcut hits the focused composer.
    try {
      await setComposerMode(page, mode);
    } catch (err) {
      const msg = err?.message ?? String(err);
      if (msg.includes('MODE_UNAVAILABLE')) {
        return fail('MODE_UNAVAILABLE', msg);
      }
      return fail('MODE_SETUP_FAILED', msg);
    }

    try {
      await typePrompt(page, question);

      if (incognito) {
        const res = await setIncognito(page, true);
        if (!res.ok) {
          return fail('INCOGNITO_UNAVAILABLE', 'Incognito could not be enabled. Re-run without --incognito to proceed in normal mode.');
        }
      }

      await submitPrompt(page);
    } catch (err) {
      return fail('COMPOSE_FAILED', err?.message ?? String(err));
    }

    let answer = '';
    try {
      // The user's --timeout maps to the outer Bridge command timeout as
      // timeout+30s. Reserve ~20s headroom for typing/submit overhead so the
      // adapter ALWAYS settles (writes the envelope) before the Bridge cuts us
      // off with a TIMEOUT — which would lose the already-generated answer.
      const waitBudget = Math.max(15, timeout - 20);
      answer = await waitForAnswer(page, { timeoutSeconds: waitBudget });
    } catch (err) {
      return fail('TIMEOUT', err?.message ?? String(err));
    }

    let sources = [];
    try { sources = await extractSources(page); } catch {}

    if (requireSources && (!Array.isArray(sources) || sources.length === 0)) {
      return fail('NO_SOURCES', 'Perplexity returned no sources. Re-run with --require-sources=false to accept the answer anyway.');
    }

    const envelope = {
      ok: true,
      trace_id: traceId,
      question,
      mode,
      incognito,
      answer_markdown: answer,
      sources: sources.map((s) => ({
        title: String(s?.title ?? '').trim(),
        url: String(s?.url ?? '').trim(),
        accessed_at: new Date().toISOString(),
      })),
      thread_url: await getPageUrl(page),
      elapsed_seconds: Math.round((nowSec() - startSec) * 10) / 10,
    };

    await writeEnvelope(output, envelope);
    await closeWindow();
    return envelope;
  },
});
