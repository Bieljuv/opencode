import type { SessionsResponse } from "@opencode/client/promise"
import type { WeeklyTokens } from "@opencode/plugin/gui"
import { saoPauloWeekKey, weekUsageBreakdown } from "@opencode/client/solid"
import type { DailyTokensSource } from "./daily-tokens"

const PAGE = 200

/**
 * ManosTech: tokens spent this week (America/Sao_Paulo) across every
 * session on one server — the real week accumulation, from the
 * server's own session data. The week runs Monday 00:00 to Sunday
 * 23:59 in São Paulo and the total persists all week, resetting only
 * at the week turn; it is the same local accumulation as the day
 * total, over the week instead of the day.
 *
 * Only sessions updated this week can hold this week's messages, and
 * message pages come newest first, so the walk stops at the first
 * message from an earlier week. Archived sessions count too:
 * archiving a session does not refund the tokens it spent this week.
 * Only the total and the week leave this module — never which model
 * or provider answered, and never a limit or a quota. Rejects when
 * the server cannot answer; the caller falls back to the day total
 * then.
 */
export async function fetchWeeklyTokens(client: DailyTokensSource): Promise<WeeklyTokens> {
  const week = saoPauloWeekKey(Date.now())
  const sessions = await listSessionsThisWeek(client, week)
  let total = 0

  for (const session of sessions) {
    total += await sumSessionThisWeek(client, session.id, week)
  }

  return { total, week }
}

async function listSessionsThisWeek(client: DailyTokensSource, week: string) {
  const sessions: SessionsResponse["data"] = []
  let cursor: string | undefined

  do {
    const page = await client.session.list({ limit: PAGE, order: "desc", cursor })
    sessions.push(...page.data.filter((session) => saoPauloWeekKey(session.time.updated) === week))
    cursor = page.cursor.next ?? undefined
  } while (cursor)

  return sessions
}

async function sumSessionThisWeek(client: DailyTokensSource, sessionID: string, week: string) {
  let total = 0
  let cursor: string | undefined

  do {
    const page = await client.message.list({ sessionID, limit: PAGE, order: "desc", cursor })
    total += weekUsageBreakdown(page.data, week).total
    cursor = page.cursor.next ?? undefined

    if (page.data.some((message) => saoPauloWeekKey(message.time.created) < week)) break
  } while (cursor)

  return total
}
