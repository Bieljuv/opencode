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
  return messages
    .filter(isAssistantWithTokens)
    .filter((message) => saoPauloDayKey(message.time.created) === day)
    .reduce(
      (total, message) =>
        total +
        message.tokens.input +
        message.tokens.output +
        message.tokens.reasoning +
        message.tokens.cache.read +
        message.tokens.cache.write,
      0,
    )
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

  const spent = messages
    .slice(0, end)
    .filter(
      (message): message is SessionMessageAssistant & { tokens: NonNullable<SessionMessageAssistant["tokens"]> } =>
        message.type === "assistant" && message.tokens !== undefined,
    )
    .reduce(
      (acc, message) => ({
        input: acc.input + message.tokens.input,
        output: acc.output + message.tokens.output,
        reasoning: acc.reasoning + message.tokens.reasoning,
        cache: {
          read: acc.cache.read + message.tokens.cache.read,
          write: acc.cache.write + message.tokens.cache.write,
        },
      }),
      { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    )

  return {
    ...spent,
    total: spent.input + spent.output + spent.reasoning + spent.cache.read + spent.cache.write,
  }
}
