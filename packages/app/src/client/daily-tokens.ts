import type {
  MessageListInput,
  SessionListInput,
  SessionMessagesResponse,
  SessionsResponse,
} from "@opencode/client/promise"
import type { DailyTokens } from "@opencode/plugin/gui"
import { dayUsageTotal, saoPauloDayKey } from "@opencode/client/solid"

/**
 * The two list calls the day total reads. The full client satisfies it;
 * the narrow shape exists so the function takes only what it uses.
 */
export type DailyTokensSource = {
  session: { list(input?: SessionListInput): Promise<SessionsResponse> }
  message: { list(input: MessageListInput): Promise<SessionMessagesResponse> }
}

const PAGE = 200

/**
 * ManosTech: tokens spent today (America/Sao_Paulo) across every session
 * on one server — the real day accumulation, from the server's own
 * session data. The plan bar only ever saw gateway usage; the direct
 * work never reached it, so the footer read 0% with millions of tokens
 * spent. This counts the spend itself, session by session.
 *
 * Only sessions updated today can hold today's messages, and message
 * pages come newest first, so the walk stops at the first message from
 * another day. Archived sessions count too: archiving a session does
 * not refund the tokens it spent today. Only the total and the day
 * leave this module — never which model or provider answered, and
 * never a limit or a quota. Rejects when the server cannot answer;
 * the caller falls back to the session total then.
 */
export async function fetchDailyTokens(client: DailyTokensSource): Promise<DailyTokens> {
  const today = saoPauloDayKey(Date.now())
  const sessions = await listSessionsToday(client, today)
  let total = 0

  for (const session of sessions) {
    total += await sumSessionToday(client, session.id, today)
  }

  return { total, date: today }
}

async function listSessionsToday(client: DailyTokensSource, today: string) {
  const sessions: SessionsResponse["data"] = []
  let cursor: string | undefined

  do {
    const page = await client.session.list({ limit: PAGE, order: "desc", cursor })
    sessions.push(...page.data.filter((session) => saoPauloDayKey(session.time.updated) === today))
    cursor = page.cursor.next ?? undefined
  } while (cursor)

  return sessions
}

async function sumSessionToday(client: DailyTokensSource, sessionID: string, today: string): Promise<number> {
  let total = 0
  let cursor: string | undefined

  do {
    const page = await client.message.list({ sessionID, limit: PAGE, order: "desc", cursor })
    total += dayUsageTotal(page.data, today)
    cursor = page.cursor.next ?? undefined

    if (page.data.some((message) => saoPauloDayKey(message.time.created) < today)) break
  } while (cursor)

  return total
}
