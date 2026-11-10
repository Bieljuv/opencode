import { describe, expect, test } from "bun:test"
import type { OpenCodeClient, SessionInfo, SessionMessageInfo } from "@opencode/client/promise"
import { fetchSessionExport, sanitizeSessionExport, sessionExportFilename } from "./export"

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions -- partial fixtures stand in for the client methods the export calls */

describe("sessionExportFilename", () => {
  test("shortens long titles to fit the filename limit", () => {
    expect(sessionExportFilename({ id: "ses_123", title: "a".repeat(300) })).toBe(`${"a".repeat(250)}.json`)
  })
})

describe("sanitizeSessionExport", () => {
  const tokens = { input: 120, output: 45, reasoning: 0, cache: { read: 10, write: 0 } }

  test("strips the session model and cost but keeps tokens and times", () => {
    const info = {
      id: "ses_1",
      title: "Test Session",
      model: { id: "mimo-v2.6-flash-free", providerID: "opencode" },
      cost: 0.0101,
      tokens,
      time: { created: 1000, updated: 2000 },
    } as SessionInfo

    const result = sanitizeSessionExport({ info, messages: [] })

    expect(result.info).toMatchObject({
      id: "ses_1",
      title: "Test Session",
      tokens,
      time: { created: 1000, updated: 2000 },
    })
    expect(result.info).not.toHaveProperty("model")
    expect(result.info).not.toHaveProperty("cost")
  })

  test("strips model and cost from messages, drops model switches, keeps the conversation", () => {
    const user = {
      id: "msg_user",
      type: "user",
      text: "Melhore a tela",
      time: { created: 1000 },
      metadata: {
        displayText: "Melhore a tela",
        agent: "build",
        manostechEffort: "automatico",
        model: { modelID: "hy4", providerID: "opencode-go" },
      },
    }

    const assistant = {
      id: "msg_assistant",
      type: "assistant",
      agent: "build",
      model: { id: "mimo-v2.6-flash-free", providerID: "opencode" },
      cost: 0.005,
      tokens,
      time: { created: 1100 },
      content: [{ type: "text", text: "Pronto." }],
    }

    const switched = {
      id: "msg_switch",
      type: "model-switched",
      time: { created: 1200 },
      model: { id: "hy4", providerID: "opencode-go" },
      previous: { id: "deepseek-flash", providerID: "deepseek" },
    }

    const agentSwitched = {
      id: "msg_agent",
      type: "agent-switched",
      time: { created: 1300 },
      agent: "build",
      previous: "plan",
    }

    const compaction = {
      id: "msg_compaction",
      type: "compaction",
      status: "completed",
      reason: "auto",
      model: { id: "nemotron-3.5-super-vl-free", providerID: "opencode" },
      cost: 0.002,
      tokens,
      time: { created: 1400 },
      summary: "Resumo da conversa.",
    }

    const failedCompaction = {
      id: "msg_failed",
      type: "compaction",
      status: "failed",
      reason: "manual",
      cost: 0.001,
      tokens,
      time: { created: 1500 },
      error: { type: "compaction-failed", message: "falhou" },
    }

    const idle = { id: "msg_idle", type: "idle", outcome: "succeeded", time: { created: 1600 } }
    const info = { id: "ses_1", cost: 0.0101 } as SessionInfo
    const messages = [user, assistant, switched, agentSwitched, compaction, failedCompaction, idle] as unknown as SessionMessageInfo[]

    const result = sanitizeSessionExport({ info, messages })

    expect(result.messages).toHaveLength(6)
    expect(result.messages.map((message) => message.id)).toEqual([
      "msg_user",
      "msg_assistant",
      "msg_agent",
      "msg_compaction",
      "msg_failed",
      "msg_idle",
    ])
    expect(result.messages.find((message) => message.id === "msg_user")).toEqual({
      id: "msg_user",
      type: "user",
      text: "Melhore a tela",
      time: { created: 1000 },
      metadata: { displayText: "Melhore a tela", agent: "build", manostechEffort: "automatico" },
    })
    expect(result.messages.find((message) => message.id === "msg_assistant")).toEqual({
      id: "msg_assistant",
      type: "assistant",
      agent: "build",
      tokens,
      time: { created: 1100 },
      content: [{ type: "text", text: "Pronto." }],
    })
    expect(result.messages.find((message) => message.id === "msg_agent")).toEqual({
      id: "msg_agent",
      type: "agent-switched",
      time: { created: 1300 },
      agent: "build",
      previous: "plan",
    })
    expect(result.messages.find((message) => message.id === "msg_compaction")).toEqual({
      id: "msg_compaction",
      type: "compaction",
      status: "completed",
      reason: "auto",
      tokens,
      time: { created: 1400 },
      summary: "Resumo da conversa.",
    })
    expect(result.messages.find((message) => message.id === "msg_failed")).toEqual({
      id: "msg_failed",
      type: "compaction",
      status: "failed",
      reason: "manual",
      tokens,
      time: { created: 1500 },
      error: { type: "compaction-failed", message: "falhou" },
    })
    expect(result.messages.find((message) => message.id === "msg_idle")).toEqual({
      id: "msg_idle",
      type: "idle",
      outcome: "succeeded",
      time: { created: 1600 },
    })

    const json = JSON.stringify(result)

    for (const leaked of [
      "mimo-v2.6-flash-free",
      "nemotron-3.5-super-vl-free",
      "hy4",
      "deepseek-flash",
      "providerID",
      "0.0101",
      "0.005",
      "0.002",
      "0.001",
    ]) {
      expect(json).not.toContain(leaked)
    }

    for (const kept of ["Melhore a tela", "Pronto.", "Resumo da conversa.", "automatico", "build"]) {
      expect(json).toContain(kept)
    }
  })
})

describe("fetchSessionExport", () => {
  test("cancelling the export aborts every request it sent, on every page", async () => {
    const controller = new AbortController()
    const signals: AbortSignal[] = []

    const api = {
      session: {
        get: async (_input: { sessionID: string }, options: { signal: AbortSignal }) => {
          signals.push(options.signal)

          return { id: "ses_1" }
        },
      },
      message: {
        list: async (input: { cursor?: string }, options: { signal: AbortSignal }) => {
          signals.push(options.signal)

          return input.cursor ? { data: [], cursor: {} } : { data: [], cursor: { next: "page-2" } }
        },
      },
    } as unknown as Pick<OpenCodeClient, "session" | "message">

    await fetchSessionExport({ sessionID: "ses_1", api, signal: controller.signal })

    expect(signals.map((signal) => signal.aborted)).toEqual([false, false, false])
    controller.abort()
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true, true])
  })

  test("returns the export already sanitized, with no model, cost or model switch", async () => {
    const info = {
      id: "ses_1",
      model: { id: "mimo-v2.6-flash-free", providerID: "opencode" },
      cost: 0.0101,
    } as SessionInfo

    const assistant = {
      id: "msg_1",
      type: "assistant",
      agent: "build",
      time: { created: 100 },
      model: { id: "mimo-v2.6-flash-free", providerID: "opencode" },
      cost: 0.005,
      content: [{ type: "text", text: "Oi." }],
    } as unknown as SessionMessageInfo

    const switched = {
      id: "msg_2",
      type: "model-switched",
      model: { id: "hy4", providerID: "opencode-go" },
      previous: { id: "deepseek-flash", providerID: "deepseek" },
    } as unknown as SessionMessageInfo

    const api = {
      session: { get: async () => info },
      message: { list: async () => ({ data: [assistant, switched], cursor: {} }) },
    } as unknown as Pick<OpenCodeClient, "session" | "message">

    const result = await fetchSessionExport({ sessionID: "ses_1", api })

    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toEqual({
      id: "msg_1",
      type: "assistant",
      agent: "build",
      time: { created: 100 },
      content: [{ type: "text", text: "Oi." }],
    })
    expect(JSON.stringify(result)).not.toContain("mimo-v2.6-flash-free")
    expect(JSON.stringify(result)).not.toContain("providerID")
    expect(JSON.stringify(result)).not.toContain("0.0101")
  })
})
