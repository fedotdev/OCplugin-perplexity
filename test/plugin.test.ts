/**
 * Unit tests for opencode-plugin-perplexity.
 *
 * The plugin's $ shell is mocked via input.$ — all other logic (JSON
 * parsing, zod validation, trusted-flag annotation, error mapping)
 * runs for real against the filesystem.
 */
import { describe, it, expect, beforeEach } from "bun:test"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import type { PluginInput, ToolContext } from "@opencode-ai/plugin"

// Import the plugin directly from source (bun handles TS natively)
import { plugin } from "../src/index"

// ---------------------------------------------------------------------------
// Fake shell: satisfies ExecShell structural type used by the plugin.
// ---------------------------------------------------------------------------

type FakeOutput = {
  exitCode: number
  stdout: Buffer
  stderr: Buffer
  text(_enc?: BufferEncoding): string
}

type FakeExecPromise = Promise<FakeOutput> & {
  cwd(_d: string): FakeExecPromise
  quiet(): FakeExecPromise
  nothrow(): FakeExecPromise
  timeout(_ms: number): FakeExecPromise
}

function fakeShellOutput(opts: {
  exitCode?: number
  stdout?: string
  stderr?: string
}): FakeOutput {
  const stdout = opts.stdout ?? ""
  const stderr = opts.stderr ?? ""
  return {
    exitCode: opts.exitCode ?? 0,
    stdout: Buffer.from(stdout, "utf-8"),
    stderr: Buffer.from(stderr, "utf-8"),
    text(_enc?: BufferEncoding): string {
      return stdout
    },
  }
}

/**
 * Build a fake `$` that writes `fileContent` to the tmpFile path captured
 * from the shell template's third positional arg (`--output <tmpFile>`).
 */
function makeFakeShell(
  fileContent: string,
  opts: { exitCode?: number; stderr?: string } = {},
) {
  const output = fakeShellOutput(opts)

  const handler = (
    _strings: TemplateStringsArray,
    ...exprs: readonly unknown[]
  ): FakeExecPromise => {
    // The tmpFile is the only expr that is an absolute path ending in
    // result.json (perplexity-research-<rand>/result.json). Find it.
    const tmpFile = String(
      exprs.find((e) => String(e ?? "").endsWith("result.json")) ?? "",
    )

    // Write the fake CLI output to the tmpFile so the plugin can read it
    const writePromise = tmpFile
      ? fs.writeFile(tmpFile, fileContent, "utf-8").catch(() => {})
      : Promise.resolve()

    const p: Promise<FakeOutput> = writePromise.then(() => output)

    const chainable = Object.assign(p, {
      cwd(_d: string): FakeExecPromise { return chainable },
      quiet(): FakeExecPromise { return chainable },
      nothrow(): FakeExecPromise { return chainable },
      timeout(_ms: number): FakeExecPromise { return chainable },
    })

    return chainable
  }

  return handler as unknown as PluginInput["$"]
}

// ---------------------------------------------------------------------------
// Fake ToolContext
// ---------------------------------------------------------------------------

function fakeToolCtx(dir: string): ToolContext {
  return {
    sessionID: "test-session",
    messageID: "test-msg",
    agent: "build",
    directory: dir,
    worktree: dir,
    abort: new AbortController().signal,
    metadata(_input: { title?: string; metadata?: Record<string, unknown> }) {},
    async ask(_input: { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }) {},
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_RESPONSE = JSON.stringify({
  ok: true,
  question: "Какой ГОСТ описывает автоблокировку?",
  answer_markdown:
    "Автоблокировка описывается в **ГОСТ Р 52651-2006** «Системы сигнализации, централизации, блокировки и телемеханики...»",
  sources: [
    {
      title: "ГОСТ Р 52651-2006 — Стандарт",
      url: "https://ru.wikipedia.org/wiki/Автоблокировка",
      accessed_at: "2026-09-03T10:00:00Z",
    },
    {
      title: "Инструкция по сигнализации",
      url: "https://docs.cnpd.ru/tsb/6212",
      accessed_at: "2026-09-03T10:00:01Z",
    },
  ],
  thread_url: "https://perplexity.ai/thread/abc123",
  elapsed_seconds: 12.5,
  trace_id: "tr-001",
})

const EMPTY_SOURCES_RESPONSE = JSON.stringify({
  ok: true,
  answer_markdown: "Не нашёл источник.",
  sources: [],
  trace_id: "tr-002",
})

const ERROR_RESPONSE_JSON = JSON.stringify({
  ok: false,
  error_code: "AUTH_REQUIRED",
  error_message: "Not logged in to perplexity.ai",
})

const ERROR_RESPONSE_YAML =
  "error:\n  code: BROWSER_CONNECT\n  message: Extension not connected\n"

const SUCCESS_RESPONSE_NO_SOURCES_FIELD = JSON.stringify({
  ok: true,
  answer_markdown: "Ответ без sources.",
  trace_id: "tr-003",
})

const ERROR_RESPONSE_SESSION_BUSY = JSON.stringify({
  ok: false,
  error_code: "SESSION_BUSY",
  error_message: 'Session "site:perplexity" is busy',
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("perplexity_research tool", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "perplexity-test-"))
  })

  // -----------------------------------------------------------------------
  // 1. Successful parse of correct JSON response
  // -----------------------------------------------------------------------
  it("parses a successful CLI response with sources", async () => {
    const h = await plugin(
      { $: makeFakeShell(VALID_RESPONSE), directory: tmpDir } as unknown as PluginInput,
      { logPath: path.join(tmpDir, "trace.jsonl") },
    )
    const toolDef = h.tool!.perplexity_research!

    const result = await toolDef.execute(
      { question: "Какой ГОСТ описывает автоблокировку на железной дороге?", requireSources: true, maxWaitSeconds: 90, allowedDomains: undefined },
      fakeToolCtx(tmpDir),
    )

    expect(typeof result).toBe("object")
    const r = result as { title: string; output: string; metadata: Record<string, unknown> }

    // Output contains the answer
    expect(r.output).toContain("ГОСТ Р 52651-2006")
    // Output contains both sources
    expect(r.output).toContain("ru.wikipedia.org")
    expect(r.output).toContain("docs.cnpd.ru")
    // Metadata has the source objects
    const sources = r.metadata.sources as Array<{ url: string; trusted: boolean }>
    expect(sources).toHaveLength(2)
    expect(sources[0].url).toContain("wikipedia.org")
    expect(r.metadata.traceId).toBe("tr-001")
    // Preamble is present
    expect(r.output).toContain("НЕДОВЕРЕННЫЕ ДАННЫЕ")
  })

  // -----------------------------------------------------------------------
  // 1b. Unwrap opencli row-array envelope ([{...}]) from stdout
  // -----------------------------------------------------------------------
  it("unwraps the opencli row-array envelope from stdout when file is empty", async () => {
    const arrayOnStdout = `[${VALID_RESPONSE}]`
    const h = await plugin(
      {
        $: makeFakeShell("", { stdout: arrayOnStdout }),
        directory: tmpDir,
      } as unknown as PluginInput,
      { logPath: path.join(tmpDir, "trace.jsonl") },
    )
    const toolDef = h.tool!.perplexity_research!

    const result = await toolDef.execute(
      { question: "Какой ГОСТ описывает автоблокировку на железной дороге?", requireSources: true, maxWaitSeconds: 90, allowedDomains: undefined },
      fakeToolCtx(tmpDir),
    )

    const r = result as { output: string; metadata: Record<string, unknown> }
    expect(r.output).toContain("ГОСТ Р 52651-2006")
    expect(r.metadata.traceId).toBe("tr-001")
  })

  // -----------------------------------------------------------------------
  // 2. requireSources=true with empty sources → error
  // -----------------------------------------------------------------------
  it("returns error when requireSources=true and sources are empty", async () => {
    const h = await plugin(
      { $: makeFakeShell(EMPTY_SOURCES_RESPONSE), directory: tmpDir } as unknown as PluginInput,
      {},
    )
    const toolDef = h.tool!.perplexity_research!

    const result = await toolDef.execute(
      { question: "Какой ГОСТ описывает автоблокировку на железной дороге?", requireSources: true, maxWaitSeconds: 90, allowedDomains: undefined },
      fakeToolCtx(tmpDir),
    )

    expect(typeof result).toBe("string")
    const msg = result as string
    expect(msg).toContain("perplexity_research:error")
    expect(msg).toContain("источников")
    expect(msg).toContain("requireSources=true")
  })

  // -----------------------------------------------------------------------
  // 3. Non-zero exit code → friendly error message
  // -----------------------------------------------------------------------
  it("returns friendly error on non-zero exit code with JSON error", async () => {
    const h = await plugin(
      {
        $: makeFakeShell(ERROR_RESPONSE_JSON, { exitCode: 77 }),
        directory: tmpDir,
      } as unknown as PluginInput,
      {},
    )
    const toolDef = h.tool!.perplexity_research!

    const result = await toolDef.execute(
      { question: "Какой ГОСТ описывает автоблокировку на железной дороге?", requireSources: true, maxWaitSeconds: 90, allowedDomains: undefined },
      fakeToolCtx(tmpDir),
    )

    expect(typeof result).toBe("string")
    const msg = result as string
    expect(msg).toContain("perplexity_research:error")
    expect(msg).toContain("Chrome-профиле research")
    expect(msg).toContain("AUTH_REQUIRED")
  })

  it("returns friendly error on non-zero exit code with YAML error", async () => {
    const h = await plugin(
      {
        $: makeFakeShell("", { exitCode: 69, stderr: ERROR_RESPONSE_YAML }),
        directory: tmpDir,
      } as unknown as PluginInput,
      {},
    )
    const toolDef = h.tool!.perplexity_research!

    const result = await toolDef.execute(
      { question: "Какой ГОСТ описывает автоблокировку на железной дороге?", requireSources: true, maxWaitSeconds: 90, allowedDomains: undefined },
      fakeToolCtx(tmpDir),
    )

    expect(typeof result).toBe("string")
    const msg = result as string
    expect(msg).toContain("Browser Bridge не подключён")
    expect(msg).toContain("Chrome-профиле research")
  })

  it("returns friendly error on SESSION_BUSY", async () => {
    const h = await plugin(
      {
        $: makeFakeShell(ERROR_RESPONSE_SESSION_BUSY, { exitCode: 75 }),
        directory: tmpDir,
      } as unknown as PluginInput,
      {},
    )
    const toolDef = h.tool!.perplexity_research!

    const result = await toolDef.execute(
      { question: "Какой ГОСТ описывает автоблокировку на железной дороге?", requireSources: false, maxWaitSeconds: 90, allowedDomains: undefined },
      fakeToolCtx(tmpDir),
    )

    expect(typeof result).toBe("string")
    const msg = result as string
    expect(msg).toContain("Сессия Perplexity занята")
  })

  // -----------------------------------------------------------------------
  // 4. allowedDomains → trusted flags
  // -----------------------------------------------------------------------
  it("annotates trusted flags when allowedDomains is provided", async () => {
    const h = await plugin(
      { $: makeFakeShell(VALID_RESPONSE), directory: tmpDir } as unknown as PluginInput,
      {},
    )
    const toolDef = h.tool!.perplexity_research!

    const result = await toolDef.execute(
      {
        question: "Какой ГОСТ описывает автоблокировку на железной дороге?",
        requireSources: true,
        maxWaitSeconds: 90,
        allowedDomains: ["wikipedia.org"],
      },
      fakeToolCtx(tmpDir),
    )

    expect(typeof result).toBe("object")
    const r = result as { metadata: { sources: Array<{ url: string; trusted: boolean }> } }
    const sources = r.metadata.sources
    expect(sources).toHaveLength(2)

    // wikipedia.org matches → trusted
    expect(sources[0].trusted).toBe(true)
    // docs.cnpd.ru does NOT match → not trusted
    expect(sources[1].trusted).toBe(false)

    // Output shows the warning for untrusted
    const output = (result as { output: string }).output
    expect(output).toContain("домен вне allowedDomains")
  })

  // -----------------------------------------------------------------------
  // 5. requireSources=false + empty sources → success (no error)
  // -----------------------------------------------------------------------
  it("allows empty sources when requireSources=false", async () => {
    const h = await plugin(
      { $: makeFakeShell(EMPTY_SOURCES_RESPONSE), directory: tmpDir } as unknown as PluginInput,
      {},
    )
    const toolDef = h.tool!.perplexity_research!

    const result = await toolDef.execute(
      { question: "Какой ГОСТ описывает автоблокировку на железной дороге?", requireSources: false, maxWaitSeconds: 90, allowedDomains: undefined },
      fakeToolCtx(tmpDir),
    )

    expect(typeof result).toBe("object")
    const r = result as { output: string }
    expect(r.output).toContain("Не нашёл источник")
    expect(r.output).toContain("Источники (0)")
  })

  // -----------------------------------------------------------------------
  // 6. Trace JSONL is written
  // -----------------------------------------------------------------------
  it("writes a trace JSONL entry on success", async () => {
    const logFile = path.join(tmpDir, "trace.jsonl")
    const h = await plugin(
      { $: makeFakeShell(VALID_RESPONSE), directory: tmpDir } as unknown as PluginInput,
      { logPath: logFile },
    )
    const toolDef = h.tool!.perplexity_research!

    await toolDef.execute(
      { question: "Какой ГОСТ описывает автоблокировку на железной дороге?", requireSources: true, maxWaitSeconds: 90, allowedDomains: undefined },
      fakeToolCtx(tmpDir),
    )

    const content = await fs.readFile(logFile, "utf-8")
    const lines = content.trim().split("\n")
    expect(lines.length).toBe(1)

    const entry = JSON.parse(lines[0]) as Record<string, unknown>
    expect(entry.timestamp).toBeDefined()
    expect(entry.cliExitCode).toBe(0)
    expect(entry.sourcesCount).toBe(2)
    expect(entry.traceId).toBe("tr-001")
    expect(typeof entry.elapsedMs).toBe("number")
  })

  // -----------------------------------------------------------------------
  // 7. Malformed JSON from CLI → error
  // -----------------------------------------------------------------------
  it("returns error when CLI output is not valid JSON", async () => {
    const h = await plugin(
      {
        $: makeFakeShell("<html>Perplexity Error Page</html>", { exitCode: 1 }),
        directory: tmpDir,
      } as unknown as PluginInput,
      {},
    )
    const toolDef = h.tool!.perplexity_research!

    const result = await toolDef.execute(
      { question: "Какой ГОСТ описывает автоблокировку на железной дороге?", requireSources: true, maxWaitSeconds: 90, allowedDomains: undefined },
      fakeToolCtx(tmpDir),
    )

    expect(typeof result).toBe("string")
    const msg = result as string
    expect(msg).toContain("perplexity_research:error")
    expect(msg).toContain("Chrome-профиле research")
  })
})
