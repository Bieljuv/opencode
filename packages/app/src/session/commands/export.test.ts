import { describe, expect, test } from "bun:test"
import type { SessionInfo, SessionMessageInfo } from "@opencode/client/promise"
import type { ServerApi, ServerRequestOptions } from "@/runtime/server/api"
import type { Platform } from "@/runtime/platform/platform"
import { fetchSessionExport, sanitizeSessionExport, saveSessionExport, sessionExportFilename } from "./export"
import type { SessionExportMessageInfo } from "./export"

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions -- partial fixtures stand in for API records the export only passes through */

describe("sessionExportFilename", () => {
  test.each([
    [{ id: "ses_123", title: "Clone PR in worktree from fork" }, "clone-pr-in-worktree-from-fork.json"],
    [{ id: "ses_123", slug: "my-session-slug" }, "my-session-slug.json"],
    [{ id: "ses_123" }, "ses_123.json"],
  ])("names %o as %s", (session, filename) => {
    expect(sessionExportFilename(session)).toBe(filename)
  })

  test("shortens long titles to fit the filename limit", () => {
    expect(sessionExportFilename({ id: "ses_123", title: "a".repeat(300) })).toBe(`${"a".repeat(250)}.json`)
  })
})

describe("fetchSessionExport", () => {
  test("fetches every native message page with inline media and without exporting cursors", async () => {
    const info = { id: "ses_1", title: "Test Session" } as SessionInfo
    const first = { id: "msg_1", type: "model-selected" } as unknown as SessionExportMessageInfo
    const second = { id: "msg_2", type: "user" } as unknown as SessionExportMessageInfo
    const calls: unknown[] = []

    const api = {
      session: { get: async () => info },
      message: {
        list: async (input: { cursor?: string }, options: ServerRequestOptions) => {
          calls.push([input, options])

          if (!input.cursor) return { data: [first], cursor: { next: "page-2" } }

          return { data: [second], cursor: {} }
        },
      },
    } as unknown as Pick<ServerApi, "session" | "message">

    const result = await fetchSessionExport({ sessionID: "ses_1", api })

    expect(result).toEqual({ info, messages: [first, second] })
    expect(result).not.toHaveProperty("cursor")
    expect(calls).toEqual([
      [
        { sessionID: "ses_1", limit: 200, order: "asc" },
        { mediaRefs: false, signal: expect.any(AbortSignal) },
      ],
      [
        { sessionID: "ses_1", limit: 200, cursor: "page-2" },
        { mediaRefs: false, signal: expect.any(AbortSignal) },
      ],
    ])
  })

  test("cancelling the export aborts every request it sent", async () => {
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
        list: async (input: { cursor?: string }, options: ServerRequestOptions & { signal: AbortSignal }) => {
          signals.push(options.signal)

          return input.cursor ? { data: [], cursor: {} } : { data: [], cursor: { next: "page-2" } }
        },
      },
    } as unknown as Pick<ServerApi, "session" | "message">

    await fetchSessionExport({ sessionID: "ses_1", api, signal: controller.signal })
    controller.abort()

    expect(signals).toHaveLength(3)
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
    } as unknown as Pick<ServerApi, "session" | "message">

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

describe("saveSessionExport", () => {
  test.each([true, false])("writes pretty JSON to the native save dialog and returns %p", async (saved) => {
    const writes: string[][] = []

    const platform: Pick<Platform, "saveFile"> = {
      saveFile: async (options, content) => {
        writes.push([options.defaultPath ?? "", content])

        return saved
      },
    }

    const data = { info: { id: "ses_1" } as SessionInfo, messages: [] }

    expect(await saveSessionExport("session.json", data, platform)).toBe(saved)
    expect(writes).toEqual([["session.json", '{\n  "info": {\n    "id": "ses_1"\n  },\n  "messages": []\n}']])
  })
})
