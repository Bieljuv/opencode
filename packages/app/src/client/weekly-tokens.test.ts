import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import type { SessionInfo, SessionMessageInfo, SessionMessagesResponse, SessionsResponse } from "@opencode/client/promise"
import type { DailyTokensSource } from "./daily-tokens"
import { fetchWeeklyTokens } from "./weekly-tokens"

const sessionInfo = (id: string, updated: string): SessionInfo => ({
  id,
  projectID: "project",
  location: { directory: "/tmp/project" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: Date.parse(updated), updated: Date.parse(updated) },
})

const assistant = (id: string, created: string, input: number): SessionMessageInfo => ({
  id,
  type: "assistant",
  agent: "build",
  model: { id: "model", providerID: "provider" },
  content: [],
  tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: Date.parse(created) },
})

/** How many list calls the fake source served, per session for messages. */
type FakeCalls = { sessions: number; messages: Record<string, number> }

/** A source scripted with session pages and per-session message pages, counting its calls. */
function fakeSource(input: {
  sessions: SessionsResponse[]
  messages: Record<string, SessionMessagesResponse[]>
  failSessions?: boolean
}): DailyTokensSource & { calls: FakeCalls } {
  const calls: FakeCalls = { sessions: 0, messages: {} }

  return {
    calls,
    session: {
      list: async ({ cursor }: { cursor?: string } = {}) => {
        calls.sessions++

        if (input.failSessions) throw new Error("server down")

        return input.sessions[cursor === undefined ? 0 : Number(cursor)]
      },
    },
    message: {
      list: async ({ sessionID, cursor }: { sessionID: string; cursor?: string }) => {
        calls.messages[sessionID] = (calls.messages[sessionID] ?? 0) + 1

        return input.messages[sessionID][cursor === undefined ? 0 : Number(cursor)]
      },
    },
  }
}

const page = <T>(data: T[], next?: string) => ({
  data,
  cursor: { next: next ?? null },
})

describe("fetchWeeklyTokens", () => {
  afterEach(() => {
    setSystemTime()
  })

  test("sums this week's tokens across every session updated this week", async () => {
    // Wednesday 2026-11-11: the week is Monday 2026-11-09 to Sunday 2026-11-15.
    setSystemTime(Date.parse("2026-11-11T15:00:00Z"))

    const source = fakeSource({
      sessions: [
        page([
          sessionInfo("ses_a", "2026-11-10T14:00:00Z"),
          sessionInfo("ses_b", "2026-11-11T12:00:00Z"),
          sessionInfo("ses_old", "2026-11-08T15:00:00Z"),
        ]),
      ],
      messages: {
        ses_a: [
          page([
            assistant("msg_a", "2026-11-10T14:00:00Z", 100),
            assistant("msg_b", "2026-11-11T13:00:00Z", 50),
          ]),
        ],
        ses_b: [page([assistant("msg_c", "2026-11-11T12:00:00Z", 200)])],
        ses_old: [page([assistant("msg_d", "2026-11-08T15:00:00Z", 999)])],
      },
    })

    // The session not updated this week is never walked, even though it holds tokens.
    expect(await fetchWeeklyTokens(source)).toEqual({ total: 350, week: "2026-11-09" })
    expect(source.calls.messages.ses_old).toBeUndefined()
  })

  test("counts Monday 00:00 in São Paulo and not the Sunday before", async () => {
    setSystemTime(Date.parse("2026-11-11T15:00:00Z"))

    const source = fakeSource({
      sessions: [page([sessionInfo("ses_a", "2026-11-10T14:00:00Z")])],
      messages: {
        ses_a: [
          page([
            assistant("msg_monday", "2026-11-09T03:00:00Z", 40),
            assistant("msg_sunday", "2026-11-09T02:59:59Z", 500),
          ]),
        ],
      },
    })

    expect(await fetchWeeklyTokens(source)).toEqual({ total: 40, week: "2026-11-09" })
  })

  test("stops paging a session at the first message from an earlier week", async () => {
    setSystemTime(Date.parse("2026-11-11T15:00:00Z"))

    const source = fakeSource({
      sessions: [page([sessionInfo("ses_a", "2026-11-10T14:00:00Z")])],
      messages: {
        ses_a: [
          page(
            [
              assistant("msg_this_week", "2026-11-10T14:00:00Z", 40),
              assistant("msg_last_week", "2026-11-09T02:59:59Z", 500),
            ],
            "1",
          ),
          page([assistant("msg_older", "2026-11-08T14:00:00Z", 700)]),
        ],
      },
    })

    expect(await fetchWeeklyTokens(source)).toEqual({ total: 40, week: "2026-11-09" })
    expect(source.calls.messages.ses_a).toBe(1)
  })

  test("counts nothing when no session was updated this week", async () => {
    setSystemTime(Date.parse("2026-11-11T15:00:00Z"))

    const source = fakeSource({
      sessions: [page([sessionInfo("ses_old", "2026-11-08T15:00:00Z")])],
      messages: {
        ses_old: [page([assistant("msg_d", "2026-11-08T15:00:00Z", 999)])],
      },
    })

    expect(await fetchWeeklyTokens(source)).toEqual({ total: 0, week: "2026-11-09" })
    expect(source.calls.messages.ses_old).toBeUndefined()
  })

  test("rejects when the server cannot answer, so the caller falls back", async () => {
    setSystemTime(Date.parse("2026-11-11T15:00:00Z"))

    const source = fakeSource({ sessions: [], messages: {}, failSessions: true })

    await expect(fetchWeeklyTokens(source)).rejects.toThrow("server down")
  })
})
