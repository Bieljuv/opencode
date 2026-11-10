import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "../src/promise"
import { cumulativeSessionUsage, lastAssistantWithUsage } from "../src/solid/usage"

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
