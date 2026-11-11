import type { SessionMessageAssistant, SessionMessageInfo } from "../promise"

/**
 * The assistant step whose tokens fill the context window now: the latest one after the last completed
 * compaction and before the revert boundary. Every client shows context usage from this step, so the TUI
 * and the desktop app agree on it.
 */
export function lastAssistantWithUsage(messages: ReadonlyArray<SessionMessageInfo>, boundary?: string) {
  const boundaryIndex = boundary ? messages.findIndex((message) => message.id === boundary) : -1

  if (boundary && boundaryIndex === -1) return undefined
  const end = boundaryIndex === -1 ? messages.length : boundaryIndex

  const compactionIndex = messages.findLastIndex(
    (message, index) => message.type === "compaction" && message.status === "completed" && index < end,
  )

  return messages.findLast(
    (message, index): message is SessionMessageAssistant & { tokens: NonNullable<SessionMessageAssistant["tokens"]> } =>
      message.type === "assistant" && message.tokens !== undefined && index > compactionIndex && index < end,
  )
}

/**
 * The day a timestamp falls on in America/Sao_Paulo, `YYYY-MM-DD` — the
 * same day the daily plan limit resets on. Uses the platform time zone
 * database, so no offset math and no DST edge: midnight in São Paulo is
 * 03:00Z. Mirrors `todayInSaoPaulo` in the desktop main process; the
 * client package cannot import it (dependency direction).
 */
export function saoPauloDayKey(timestampMs: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestampMs))
}

type AssistantWithTokens = SessionMessageAssistant & { tokens: NonNullable<SessionMessageAssistant["tokens"]> }

function isAssistantWithTokens(message: SessionMessageInfo): message is AssistantWithTokens {
  return message.type === "assistant" && message.tokens !== undefined
}

type TokenParts = {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

const zeroParts = (): TokenParts => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })

/** Sums the token parts of assistant messages that already reported usage. */
function sumTokenParts(messages: ReadonlyArray<AssistantWithTokens>): TokenParts {
  return messages.reduce(
    (acc, message) => ({
      input: acc.input + message.tokens.input,
      output: acc.output + message.tokens.output,
      reasoning: acc.reasoning + message.tokens.reasoning,
      cache: {
        read: acc.cache.read + message.tokens.cache.read,
        write: acc.cache.write + message.tokens.cache.write,
      },
    }),
    zeroParts(),
  )
}

function totalOf(parts: TokenParts): number {
  return parts.input + parts.output + parts.reasoning + parts.cache.read + parts.cache.write
}

/**
 * Every token spent on one São Paulo day, across every session that
 * reports it: the sum over that day's assistant messages with tokens,
 * whatever model or provider answered. Spend never comes back — a
 * revert or a compaction does not refund it, and a message counts on
 * the day it was created, never on the day its session was opened.
 * Messages without tokens (a step still running, or a step that never
 * reported usage) count nothing.
 */
export function dayUsageTotal(messages: ReadonlyArray<SessionMessageInfo>, day: string): number {
  return dayUsageBreakdown(messages, day).total
}

/**
 * Every token spent on one São Paulo day, by kind: the parts of the
 * day total — input, output, reasoning and cache, summed over that
 * day's assistant messages with tokens. Same scope as
 * `dayUsageTotal`: `total` here IS that total, so the parts always
 * add up to the number the Context tab shows. `input` is the input
 * that was not served from cache; cached input lives in
 * `cache.read` (served from cache) and `cache.write` (written to
 * it), so nothing is counted twice. Same spend rules as
 * `dayUsageTotal`: no refund on revert or compaction, a message
 * counts on the day it was created, messages without tokens count
 * nothing.
 */
export function dayUsageBreakdown(messages: ReadonlyArray<SessionMessageInfo>, day: string) {
  const spent = sumTokenParts(
    messages.filter(isAssistantWithTokens).filter((message) => saoPauloDayKey(message.time.created) === day),
  )

  return { ...spent, total: totalOf(spent) }
}

/**
 * Every token the session has spent so far: the sum over all assistant steps before the revert
 * boundary, across every model and provider that answered. Spend never comes back — unlike the
 * context window, which only holds the latest step after the last compaction, the total keeps
 * growing when the router switches models or the session compacts. A missing revert boundary
 * counts nothing, like lastAssistantWithUsage returning nothing for it.
 */
export function cumulativeSessionUsage(messages: ReadonlyArray<SessionMessageInfo>, boundary?: string) {
  const boundaryIndex = boundary ? messages.findIndex((message) => message.id === boundary) : -1
  const end = boundary ? (boundaryIndex === -1 ? 0 : boundaryIndex) : messages.length

  const spent = sumTokenParts(messages.slice(0, end).filter(isAssistantWithTokens))

  return { ...spent, total: totalOf(spent) }
}
