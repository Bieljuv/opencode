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

/**
 * The Monday (America/Sao_Paulo) of the week a timestamp falls in,
 * `YYYY-MM-DD` — the same week the weekly plan limit counts on. The
 * week runs Monday 00:00 to Sunday 23:59 in São Paulo. Computed from
 * the São Paulo calendar date, so no offset math and no DST edge:
 * the weekday comes from the date itself, and subtracting whole days
 * from a calendar date is exact.
 */
export function saoPauloWeekKey(timestampMs: number): string {
  const [year, month, date] = saoPauloDayKey(timestampMs).split("-").map(Number)
  const weekday = new Date(Date.UTC(year, month - 1, date)).getUTCDay()
  const mondayOffset = (weekday + 6) % 7

  return new Date(Date.UTC(year, month - 1, date - mondayOffset)).toISOString().slice(0, 10)
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
 * Every token spent in one São Paulo week, across every session that
 * reports it: the sum over that week's assistant messages with
 * tokens, whatever model or provider answered. The week runs Monday
 * 00:00 to Sunday 23:59 in America/Sao_Paulo, and a message counts
 * in the week it was created. Same spend rules as `dayUsageTotal`:
 * no refund on revert or compaction, messages without tokens count
 * nothing.
 */
export function weekUsageTotal(messages: ReadonlyArray<SessionMessageInfo>, week: string): number {
  return weekUsageBreakdown(messages, week).total
}

/**
 * Every token spent in one São Paulo week, by kind: the parts of the
 * week total — input, output, reasoning and cache, summed over that
 * week's assistant messages with tokens. Same scope as
 * `weekUsageTotal`: `total` here IS that total, so the parts always
 * add up to the number the Context tab shows.
 */
export function weekUsageBreakdown(messages: ReadonlyArray<SessionMessageInfo>, week: string) {
  const spent = sumTokenParts(
    messages.filter(isAssistantWithTokens).filter((message) => saoPauloWeekKey(message.time.created) === week),
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
