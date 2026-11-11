import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "../src/promise"
import { cumulativeSessionUsage, dayUsageBreakdown, dayUsageTotal, lastAssistantWithUsage, saoPauloDayKey } from "../src/solid/usage"

const assistant = (id: string, input: number): SessionMessageInfo => ({
  id,
  type: "assistant",
  agent: "build",
  model: { id: "model", providerID: "provider" },
  content: [],
  tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0 },
})

const spent = (
  id: string,
  model: { id: string; providerID: string },
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } },
): SessionMessageInfo => ({
  id,
  type: "assistant",
  agent: "build",
  model,
  content: [],
  tokens,
  time: { created: 0 },
})

const on = (id: string, created: string, input: number): SessionMessageInfo => ({
  ...spent(id, { id: "model", providerID: "provider" }, { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }),
  time: { created: Date.parse(created) },
})

describe("lastAssistantWithUsage", () => {
  test("tracks usage across undo and redo boundaries", () => {
    const messages = [assistant("msg_z", 10), assistant("msg_a", 30)]

    expect(lastAssistantWithUsage(messages)?.tokens.input).toBe(30)
    expect(lastAssistantWithUsage(messages, "msg_a")?.tokens.input).toBe(10)
    expect(lastAssistantWithUsage(messages, "msg_missing")).toBeUndefined()
    expect(lastAssistantWithUsage(messages)?.tokens.input).toBe(30)
  })

  test("resets usage at completed compaction until the next assistant reports it", () => {
    const compaction: SessionMessageInfo = {
      id: "msg_compaction",
      type: "compaction",
      status: "completed",
      reason: "manual",
      summary: "Current state",
      time: { created: 0 },
    }

    const messages = [assistant("msg_before", 30), compaction]

    expect(lastAssistantWithUsage(messages)).toBeUndefined()

    messages.push(assistant("msg_after", 5))
    expect(lastAssistantWithUsage(messages)?.tokens.input).toBe(5)
  })
})

describe("saoPauloDayKey", () => {
  test("cuts the day at midnight in São Paulo, not UTC", () => {
    // 23:59:59 in São Paulo is still the previous day; 00:00 is the next.
    expect(saoPauloDayKey(Date.parse("2026-11-10T02:59:59Z"))).toBe("2026-11-09")
    expect(saoPauloDayKey(Date.parse("2026-11-10T03:00:00Z"))).toBe("2026-11-10")
    expect(saoPauloDayKey(Date.parse("2026-11-11T02:59:59Z"))).toBe("2026-11-10")
    expect(saoPauloDayKey(Date.parse("2026-11-10T15:00:00Z"))).toBe("2026-11-10")
  })
})

describe("dayUsageTotal", () => {
  test("sums only the day's assistant messages, across models", () => {
    const messages = [
      spent(
        "msg_a",
        { id: "model-a", providerID: "provider-a" },
        { input: 10_000, output: 500, reasoning: 100, cache: { read: 200, write: 50 } },
      ),
      spent(
        "msg_b",
        { id: "model-b", providerID: "provider-b" },
        { input: 12_000, output: 600, reasoning: 200, cache: { read: 300, write: 100 } },
      ),
    ].map((message) => ({ ...message, time: { created: Date.parse("2026-11-10T15:00:00Z") } }))

    expect(dayUsageTotal(messages, "2026-11-10")).toBe(24_050)
  })

  test("ignores messages from another São Paulo day", () => {
    const messages = [
      on("msg_yesterday", "2026-11-10T02:59:59Z", 100_000),
      on("msg_today", "2026-11-10T03:00:00Z", 40),
    ]

    expect(dayUsageTotal(messages, "2026-11-10")).toBe(40)
  })

  test("ignores assistant messages without tokens and user messages", () => {
    const withoutTokens: SessionMessageInfo = { ...on("msg_empty", "2026-11-10T15:00:00Z", 0), tokens: undefined }
    const user: SessionMessageInfo = {
      id: "msg_user",
      type: "user",
      time: { created: Date.parse("2026-11-10T15:00:00Z") },
    }
    const messages = [withoutTokens, user, on("msg_spent", "2026-11-10T15:00:00Z", 40)]

    expect(dayUsageTotal(messages, "2026-11-10")).toBe(40)
  })

  test("keeps spend from before a completed compaction", () => {
    const compaction: SessionMessageInfo = {
      id: "msg_compaction",
      type: "compaction",
      status: "completed",
      reason: "manual",
      summary: "Current state",
      time: { created: Date.parse("2026-11-10T15:00:00Z") },
    }
    const messages = [
      on("msg_before", "2026-11-10T14:00:00Z", 30),
      compaction,
      on("msg_after", "2026-11-10T16:00:00Z", 5),
    ]

    // Compaction frees the context window; it does not refund the tokens already spent.
    expect(dayUsageTotal(messages, "2026-11-10")).toBe(35)
  })

  test("returns zero for an empty list or a day with no messages", () => {
    expect(dayUsageTotal([], "2026-11-10")).toBe(0)
    expect(dayUsageTotal([on("msg_a", "2026-11-10T15:00:00Z", 40)], "2026-11-11")).toBe(0)
  })
})

describe("dayUsageBreakdown", () => {
  test("parts add up to the day total, in the same scope", () => {
    const messages = [
      spent(
        "msg_a",
        { id: "model-a", providerID: "provider-a" },
        { input: 10_000, output: 500, reasoning: 100, cache: { read: 200, write: 50 } },
      ),
      spent(
        "msg_b",
        { id: "model-b", providerID: "provider-b" },
        { input: 12_000, output: 600, reasoning: 200, cache: { read: 300, write: 100 } },
      ),
    ].map((message) => ({ ...message, time: { created: Date.parse("2026-11-10T15:00:00Z") } }))

    const breakdown = dayUsageBreakdown(messages, "2026-11-10")

    // The parts are the day total's own parts: a total of 24_050 with
    // parts summing to something else is the mismatch the Context tab showed.
    expect(breakdown.total).toBe(24_050)
    expect(breakdown.total).toBe(dayUsageTotal(messages, "2026-11-10"))
    expect(breakdown.input).toBe(22_000)
    expect(breakdown.output).toBe(1_100)
    expect(breakdown.reasoning).toBe(300)
    expect(breakdown.cache.read).toBe(500)
    expect(breakdown.cache.write).toBe(150)
  })

  test("ignores messages from another São Paulo day in every part", () => {
    const messages = [
      on("msg_yesterday", "2026-11-10T02:59:59Z", 100_000),
      on("msg_today", "2026-11-10T03:00:00Z", 40),
    ]

    const breakdown = dayUsageBreakdown(messages, "2026-11-10")

    expect(breakdown.total).toBe(40)
    expect(breakdown.input).toBe(40)
    expect(breakdown.output).toBe(0)
    expect(breakdown.cache.read).toBe(0)
  })

  test("returns zero parts for an empty list or a day with no messages", () => {
    expect(dayUsageBreakdown([], "2026-11-10")).toEqual({
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    })
    expect(dayUsageBreakdown([on("msg_a", "2026-11-10T15:00:00Z", 40)], "2026-11-11").total).toBe(0)
  })
})

describe("cumulativeSessionUsage", () => {
  test("sums tokens across turns answered by different models", () => {
    const messages = [
      spent(
        "msg_a",
        { id: "model-a", providerID: "provider-a" },
        { input: 10_000, output: 500, reasoning: 100, cache: { read: 200, write: 50 } },
      ),
      spent(
        "msg_b",
        { id: "model-b", providerID: "provider-b" },
        { input: 12_000, output: 600, reasoning: 200, cache: { read: 300, write: 100 } },
      ),
    ]

    const usage = cumulativeSessionUsage(messages)

    // The total is the sum of both turns, never just the last model's own tokens (13_200).
    expect(usage.total).toBe(24_050)
    expect(usage.input).toBe(22_000)
    expect(usage.output).toBe(1_100)
    expect(usage.reasoning).toBe(300)
    expect(usage.cache.read).toBe(500)
    expect(usage.cache.write).toBe(150)
  })

  test("keeps spend from before a completed compaction", () => {
    const compaction: SessionMessageInfo = {
      id: "msg_compaction",
      type: "compaction",
      status: "completed",
      reason: "manual",
      summary: "Current state",
      time: { created: 0 },
    }

    const messages = [assistant("msg_before", 30), compaction, assistant("msg_after", 5)]

    // Compaction frees the context window; it does not refund the tokens already spent.
    expect(cumulativeSessionUsage(messages).total).toBe(35)
  })

  test("ignores assistant messages without tokens", () => {
    const withoutTokens: SessionMessageInfo = { ...assistant("msg_empty", 0), tokens: undefined }
    const messages = [withoutTokens, assistant("msg_spent", 40)]

    expect(cumulativeSessionUsage(messages).total).toBe(40)
  })

  test("respects the revert boundary", () => {
    const messages = [assistant("msg_a", 10), assistant("msg_b", 30)]

    expect(cumulativeSessionUsage(messages, "msg_b").total).toBe(10)
    expect(cumulativeSessionUsage(messages, "msg_missing").total).toBe(0)
  })

  test("returns zero totals for an empty session", () => {
    const usage = cumulativeSessionUsage([])

    expect(usage).toEqual({
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    })
  })
})
