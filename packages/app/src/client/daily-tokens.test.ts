import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import type { SessionInfo, SessionMessageInfo, SessionMessagesResponse, SessionsResponse } from "@opencode/client/promise"
import { fetchDailyTokens, type DailyTokensSource } from "./daily-tokens"

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

describe("fetchDailyTokens", () => {
  afterEach(() => {
    setSystemTime()
  })

  test("sums today's tokens across every session updated today", async () => {
    setSystemTime(Date.parse("2026-11-10T15:00:00Z"))

    const source = fakeSource({
      sessions: [
        page([
          sessionInfo("ses_delivery", "2026-11-10T14:00:00Z"),
          sessionInfo("ses_caca", "2026-11-10T13:00:00Z"),
          sessionInfo("ses_old", "2026-11-09T15:00:00Z"),
        ]),
      ],
      messages: {
        ses_delivery: [
          page([
            assistant("msg_a", "2026-11-10T14:00:00Z", 100),
            assistant("msg_b", "2026-11-10T13:00:00Z", 50),
          ]),
        ],
        ses_caca: [page([assistant("msg_c", "2026-11-10T12:00:00Z", 200)])],
        ses_old: [page([assistant("msg_d", "2026-11-09T15:00:00Z", 999)])],
      },
    })

    // The session not updated today is never walked, even though it holds tokens.
    expect(await fetchDailyTokens(source)).toEqual({
      total: 350,
      date: "2026-11-10",
      breakdown: { input: 350, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    expect(source.calls.messages.ses_old).toBeUndefined()
  })

  test("returns the day's breakdown with the total, in the same scope", async () => {
    setSystemTime(Date.parse("2026-11-10T15:00:00Z"))

    const spent: SessionMessageInfo = {
      id: "msg_full",
      type: "assistant",
      agent: "build",
      model: { id: "model", providerID: "provider" },
      content: [],
      tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 10 } },
      time: { created: Date.parse("2026-11-10T14:00:00Z") },
    }

    const source = fakeSource({
      sessions: [page([sessionInfo("ses_a", "2026-11-10T14:00:00Z")])],
      messages: { ses_a: [page([spent, assistant("msg_b", "2026-11-10T13:00:00Z", 50)])] },
    })

    // The parts are the total's own parts: 100+20+5+30+10 + 50 = 215, and they add up to it.
    expect(await fetchDailyTokens(source)).toEqual({
      total: 215,
      date: "2026-11-10",
      breakdown: { input: 150, output: 20, reasoning: 5, cache: { read: 30, write: 10 } },
    })
  })

  test("pages the session list until the cursor ends", async () => {
    setSystemTime(Date.parse("2026-11-10T15:00:00Z"))

    const source = fakeSource({
      sessions: [
        page([sessionInfo("ses_a", "2026-11-10T14:00:00Z")], "1"),
        page([sessionInfo("ses_b", "2026-11-10T14:00:00Z")]),
      ],
      messages: {
        ses_a: [page([assistant("msg_a", "2026-11-10T14:00:00Z", 10)])],
        ses_b: [page([assistant("msg_b", "2026-11-10T14:00:00Z", 20)])],
      },
    })

    expect(await fetchDailyTokens(source)).toEqual({
      total: 30,
      date: "2026-11-10",
      breakdown: { input: 30, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    expect(source.calls.sessions).toBe(2)
  })

  test("stops paging a session at the first message from another day", async () => {
    setSystemTime(Date.parse("2026-11-10T15:00:00Z"))

    const source = fakeSource({
      sessions: [page([sessionInfo("ses_a", "2026-11-10T14:00:00Z")])],
      messages: {
        ses_a: [
          page(
            [
              assistant("msg_today", "2026-11-10T14:00:00Z", 40),
              assistant("msg_yesterday", "2026-11-10T02:59:59Z", 500),
            ],
            "1",
          ),
          page([assistant("msg_older", "2026-11-09T14:00:00Z", 700)]),
        ],
      },
    })

    expect(await fetchDailyTokens(source)).toEqual({
      total: 40,
      date: "2026-11-10",
      breakdown: { input: 40, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    expect(source.calls.messages.ses_a).toBe(1)
  })

  test("counts nothing when no session was updated today", async () => {
    setSystemTime(Date.parse("2026-11-10T15:00:00Z"))

    const source = fakeSource({
      sessions: [page([sessionInfo("ses_old", "2026-11-09T15:00:00Z")])],
      messages: {
        ses_old: [page([assistant("msg_d", "2026-11-09T15:00:00Z", 999)])],
      },
    })

    expect(await fetchDailyTokens(source)).toEqual({
      total: 0,
      date: "2026-11-10",
      breakdown: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    expect(source.calls.messages.ses_old).toBeUndefined()
  })

  test("rejects when the server cannot answer, so the caller falls back", async () => {
    setSystemTime(Date.parse("2026-11-10T15:00:00Z"))

    const source = fakeSource({ sessions: [], messages: {}, failSessions: true })

    await expect(fetchDailyTokens(source)).rejects.toThrow("server down")
  })
})
