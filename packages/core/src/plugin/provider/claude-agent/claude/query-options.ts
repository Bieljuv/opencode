export * as ClaudeQueryOptions from "./query-options.js"

import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider"
import type { Options } from "@anthropic-ai/claude-agent-sdk"
import { ToolHooks } from "../tools/hooks.js"
import type { PendingTools } from "../tools/pending.js"
import { ToolServer } from "../tools/server.js"
import type { ClaudeIO } from "./io.js"

// Claude Code features that duplicate opencode's. opencode's version wins (specs/v2/claude-agent-provider.md, "Turned Off").
// Auto-compact is the exception: opencode's compaction cannot shrink the long-lived Claude process's transcript
// (it only replaces opencode's own record), so Claude compacts itself at the window below instead.
const ISOLATION_ENV = {
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  // Cleared, not "1": a value from the user's shell would otherwise keep auto-compact off, and the SDK settings
  // below are what turn it on. Same clear-pattern as CLAUDE_CODE_SIMPLE below.
  DISABLE_AUTO_COMPACT: undefined,
  CLAUDE_CODE_ENABLE_AWAY_SUMMARY: "0",
  ENABLE_TOOL_SEARCH: "false",
  CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1",
  CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: "1",
  CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: "1",
  // Raised so opencode's own truncation applies instead
  MAX_MCP_OUTPUT_TOKENS: "200000",
  // Skips OAuth, so the subscription would not be used
  CLAUDE_CODE_SIMPLE: undefined,
  // A shell-level effort override would take precedence over OpenCode's live effort settings.
  CLAUDE_CODE_EFFORT_LEVEL: undefined,
  // Caps every OpenCode tool call, which would fail subagents and permission prompts that run longer
  MCP_TOOL_TIMEOUT: undefined,
}

/**
 * The auto-compact window opencode applies to Claude sessions, in tokens. Claude compacts its own long-lived
 * transcript at this window, so a session never needs a manual /autocompact. The window never exceeds 85% of the
 * model's known context window (a small-window model still compacts before it hits the limit) and never goes below
 * the 100k the SDK accepts; an unknown window takes the 500k default.
 */
export const AUTO_COMPACT_WINDOW_TOKENS = 500_000
const AUTO_COMPACT_WINDOW_MIN = 100_000
const AUTO_COMPACT_WINDOW_SHARE = 0.85

export function autoCompactWindowFor(contextWindow: number | undefined): number {
  if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0)
    return AUTO_COMPACT_WINDOW_TOKENS
  return Math.max(
    AUTO_COMPACT_WINDOW_MIN,
    Math.min(AUTO_COMPACT_WINDOW_TOKENS, Math.floor(AUTO_COMPACT_WINDOW_SHARE * contextWindow)),
  )
}

export function connectionEnv(connection: {
  readonly settings?: Readonly<Record<string, unknown>>
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: Readonly<Record<string, unknown>>
}): Record<string, string> {
  const env: Record<string, string> = {}
  const settings = connection.settings ?? {}
  if (typeof settings.baseURL === "string") env.ANTHROPIC_BASE_URL = settings.baseURL
  if (typeof settings.apiKey === "string") env.ANTHROPIC_API_KEY = settings.apiKey
  if (typeof settings.authToken === "string") env.ANTHROPIC_AUTH_TOKEN = settings.authToken
  if (typeof settings.headerTimeout === "number") env.API_TIMEOUT_MS = String(settings.headerTimeout)
  if (typeof settings.chunkTimeout === "number") env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = String(settings.chunkTimeout)
  const headers: string[] = []
  for (const [name, value] of Object.entries(connection.headers ?? {})) {
    headers.push(`${name}: ${value}`)
  }
  if (headers.length > 0) env.ANTHROPIC_CUSTOM_HEADERS = headers.join("\n")
  if (connection.body !== undefined && Object.keys(connection.body).length > 0) {
    env.CLAUDE_CODE_EXTRA_BODY = JSON.stringify(connection.body)
  }
  return env
}

export function base(input: {
  executable: string
  io: ClaudeIO.Interface
  connection?: Readonly<Record<string, string>>
}): Options {
  return {
    pathToClaudeCodeExecutable: input.executable,
    spawnClaudeCodeProcess: input.io.spawn,
    env: { ...input.io.env(), ...input.connection, ...ISOLATION_ENV },
    settingSources: [],
    settings: { disableAllHooks: true },
    // Without summaries, OpenCode has no reasoning text to display
    thinking: { type: "adaptive", display: "summarized" },
    strictMcpConfig: true,
    skills: [],
    tools: [],
    permissionMode: "dontAsk",
    allowedTools: ["mcp__opencode__*"],
    verbatimPrompts: true,
  }
}

export async function session(input: {
  readonly executable: string
  readonly io: ClaudeIO.Interface
  readonly connection?: Readonly<Record<string, string>>
  readonly directory: string
  readonly model: string
  // The model's context window, when the last probe reported it; unknown takes the 500k default.
  readonly contextWindow?: number
  readonly effort?: Options["effort"]
  readonly maxOutputTokens?: number
  readonly system: NonNullable<Options["systemPrompt"]>
  readonly tools: readonly LanguageModelV3FunctionTool[]
  readonly pending: PendingTools.Interface
  // Side calls run without saving a transcript
  readonly persist: boolean
  readonly resume?: string
}): Promise<Options> {
  const options: Options = {
    ...base(input),
    cwd: input.directory,
    model: input.model,
    effort: input.effort,
    systemPrompt: input.system,
    includePartialMessages: true,
    persistSession: input.persist,
    // Auto-compact on, at the window for this model. The SDK loads these into the flag-settings layer (highest
    // priority), so the default survives even though no settings files are loaded (settingSources: []). A
    // /autocompact typed in the session still changes the live window for that session; the default returns on
    // the next session. Opencode's own auto-compaction stays on as a backstop (it fires on opencode's recorded
    // estimate and restarts the process from its own summary when it does).
    settings: {
      disableAllHooks: true,
      autoCompactEnabled: true,
      autoCompactWindow: autoCompactWindowFor(input.contextWindow),
    },
    hooks: ToolHooks.make(input.pending),
    mcpServers: {},
  }
  if (input.maxOutputTokens !== undefined) {
    options.env = { ...options.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(input.maxOutputTokens) }
  }
  if (input.tools.length > 0) options.mcpServers = { opencode: await ToolServer.make(input.tools, input.pending) }
  if (input.resume !== undefined) {
    options.resume = input.resume
    return options
  }
  options.sessionId = crypto.randomUUID()
  return options
}
