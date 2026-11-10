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
