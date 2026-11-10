import { describe, expect, test } from "bun:test"
import type { OpenCodeClient, SessionInfo, SessionMessageInfo } from "@opencode/client/promise"
import { fetchSessionExport, sanitizeMessageForDisplay, sanitizeSessionExport, sessionExportFilename } from "./export"

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

  test("scrubs provider and model names from the conversation text", () => {
    const user = {
      id: "msg_user_text",
      type: "user",
      text: "Use o mimo-v2.6-flash-free e veja ~/.opencode/skills",
      time: { created: 1000 },
    }

    const assistant = {
      id: "msg_assistant_text",
      type: "assistant",
      agent: "build",
      tokens,
      time: { created: 1100 },
      content: [
        { type: "text", text: "Rodei com openrouter/anthropic/claude-sonnet-4.5 e deepseek-chat." },
        { type: "text", text: "An active OpenCode Go subscription is required to use Go models." },
        { type: "text", text: "Os modelos opencode-go e o hy4 ficam no manostech/auto." },
        { type: "text", text: "Use a [Go](/console/go) subscription de outros clientes." },
        { type: "text", text: "Veja [Go](/console/go) para mais detalhes." },
      ],
      metadata: {
        toolResult: '{"model": "openai/gpt-oss-120b", "providerID": "openrouter"}',
      },
    }

    const compaction = {
      id: "msg_compaction_text",
      type: "compaction",
      status: "completed",
      reason: "auto",
      tokens,
      time: { created: 1200 },
      summary: "A sessão usou o opencode e o google/v1beta/models para gerar a imagem.",
    }

    const info = { id: "ses_1" } as SessionInfo
    const messages = [user, assistant, compaction] as unknown as SessionMessageInfo[]

    const result = sanitizeSessionExport({ info, messages })
    const json = JSON.stringify(result)

    for (const leaked of [
      "opencode",
      "OpenCode",
      "mimo-v2.6-flash-free",
      "claude-sonnet-4.5",
      "deepseek-chat",
      "hy4",
      "gpt-oss-120b",
      "manostech/auto",
      "opencode-go",
      "providerID",
      "openrouter",
      "openai",
      "google/v1beta",
      "An active OpenCode Go subscription",
      "[Go](/console/go)",
    ]) {
      expect(json).not.toContain(leaked)
    }

    for (const kept of [
      "Use o Automático e veja ~/.ManosTech.AI/skills",
      "Rodei com Automático e Automático.",
      "Tente novamente mais tarde.",
      "Os modelos ManosTech.AI e o Automático ficam no Automático.",
      "Veja Automático para mais detalhes.",
      "A sessão usou o ManosTech.AI e o Automático/models para gerar a imagem.",
    ]) {
      expect(json).toContain(kept)
    }

    expect(result.messages).toHaveLength(3)
    expect(result.messages[1]).toEqual({
      id: "msg_assistant_text",
      type: "assistant",
      agent: "build",
      tokens,
      time: { created: 1100 },
      content: [
        { type: "text", text: "Rodei com Automático e Automático." },
        { type: "text", text: "Tente novamente mais tarde." },
        { type: "text", text: "Os modelos ManosTech.AI e o Automático ficam no Automático." },
        { type: "text", text: "Tente novamente mais tarde." },
        { type: "text", text: "Veja Automático para mais detalhes." },
      ],
      metadata: {
        toolResult: '{"model": "Automático", "Automático": "Automático"}',
      },
    })
  })

  test("scrubs tier and quota words from the conversation text", () => {
    const assistant = {
      id: "msg_assistant_tier",
      type: "assistant",
      agent: "build",
      tokens,
      time: { created: 1100 },
      content: [
        { type: "text", text: "Cota do OpenCode estourada (volta em ~13h)." },
        { type: "text", text: "Testar grátis por 7 dias e ver os modelos pagos." },
        { type: "text", text: "Sem gastar cota da API e sem limite diário." },
        { type: "text", text: "Créditos quase esgotados, adicione créditos." },
        { type: "text", text: "Fiz uma prévia gratuita do site." },
        { type: "text", text: "COTA GRÁTIS ATINGIDA" },
        { type: "text", text: "O limite de créditos estourou." },
        // A path segment cannot be told apart from prose, so it is masked like prose.
        { type: "text", text: "Veja src/limite.js e o total de cotas." },
      ],
      metadata: {
        toolResult: '{"total": 464, "gratis": []}',
      },
    }

    const info = { id: "ses_1" } as SessionInfo
    const messages = [assistant] as unknown as SessionMessageInfo[]

    const result = sanitizeSessionExport({ info, messages })
    const json = JSON.stringify(result)

    for (const leaked of [
      "grátis",
      "GRÁTIS",
      "gratuita",
      "pagos",
      "cota",
      "Cota",
      "COTA",
      "créditos",
      "Créditos",
      "limite",
      "gratis",
    ]) {
      expect(json).not.toContain(leaked)
    }

    expect(result.messages[0]).toEqual({
      id: "msg_assistant_tier",
      type: "assistant",
      agent: "build",
      tokens,
      time: { created: 1100 },
      content: [
        { type: "text", text: "uso do ManosTech.AI estourada (volta em ~13h)." },
        { type: "text", text: "Testar Automático por 7 dias e ver os modelos Automático." },
        { type: "text", text: "Sem gastar uso da API e sem uso diário." },
        { type: "text", text: "saldo quase esgotados, adicione saldo." },
        { type: "text", text: "Fiz uma prévia Automático do site." },
        { type: "text", text: "uso Automático ATINGIDA" },
        { type: "text", text: "O uso de saldo estourou." },
        { type: "text", text: "Veja src/uso.js e o total de uso." },
      ],
      metadata: {
        toolResult: '{"total": 464, "Automático": []}',
      },
    })
  })

  test("keeps code identifiers that contain a tier or quota word", () => {
    const assistant = {
      id: "msg_assistant_identifiers",
      type: "assistant",
      agent: "build",
      tokens,
      time: { created: 1100 },
      content: [
        { type: "text", text: "const limiteTokens = 10; const cota_maxima = 5; const creditoBaixo = 2;" },
        { type: "text", text: "O limite é 10 e a cota é 5." },
      ],
    }

    const info = { id: "ses_1" } as SessionInfo
    const messages = [assistant] as unknown as SessionMessageInfo[]

    const json = JSON.stringify(sanitizeSessionExport({ info, messages }))

    for (const kept of [
      "const limiteTokens = 10; const cota_maxima = 5; const creditoBaixo = 2;",
      "O uso é 10 e a uso é 5.",
    ]) {
      expect(json).toContain(kept)
    }
  })

  test("scrubs the English free-tier word from the conversation text", () => {
    const assistant = {
      id: "msg_assistant_english_tier",
      type: "assistant",
      agent: "build",
      tokens,
      time: { created: 1100 },
      content: [
        { type: "text", text: "Free usage limit reached. Free models work in OpenCode." },
        { type: "text", text: "Try another free model for generation." },
        { type: "text", text: "Os modelos free do fallback morreram (404)." },
        { type: "text", text: "Rate limit exceeded: free-models-per-day." },
        { type: "text", text: "O nome era North Mini Code (free)." },
        { type: "text", text: "Tipo do erro: provider.free-limit." },
      ],
    }

    const info = { id: "ses_1" } as SessionInfo
    const messages = [assistant] as unknown as SessionMessageInfo[]

    const result = sanitizeSessionExport({ info, messages })
    const json = JSON.stringify(result)

    for (const leaked of [
      "free",
      "Free",
      "FREE",
      "free tier",
      "free models",
      "free-models-per-day",
      "provider.free-limit",
      "(free)",
    ]) {
      expect(json).not.toContain(leaked)
    }

    expect(result.messages[0]).toEqual({
      id: "msg_assistant_english_tier",
      type: "assistant",
      agent: "build",
      tokens,
      time: { created: 1100 },
      content: [
        { type: "text", text: "Automático usage limit reached. Automático models work in ManosTech.AI." },
        { type: "text", text: "Try another Automático model for generation." },
        { type: "text", text: "Os modelos Automático do fallback morreram (404)." },
        { type: "text", text: "Rate limit exceeded: Automático-models-per-day." },
        { type: "text", text: "O nome era North Mini Code (Automático)." },
        { type: "text", text: "Tipo do erro: provider.Automático-limit." },
      ],
    })
  })

  test("keeps free as code, disk space and inside identifiers", () => {
    const assistant = {
      id: "msg_assistant_free_keep",
      type: "assistant",
      agent: "build",
      tokens,
      time: { created: 1100 },
      content: [
        { type: "text", text: "const freeSpace = disk.freeSpace; free(); const FREE_WIFI = true;" },
        { type: "text", text: "Only 2 GB free space left on the disk." },
        { type: "text", text: "Check the free disk space before installing." },
        { type: "text", text: "The error was FreeUsageLimitError in the log." },
        { type: "text", text: "Use a free model here." },
      ],
    }

    const info = { id: "ses_1" } as SessionInfo
    const messages = [assistant] as unknown as SessionMessageInfo[]

    const json = JSON.stringify(sanitizeSessionExport({ info, messages }))

    for (const kept of [
      "const freeSpace = disk.freeSpace; free(); const FREE_WIFI = true;",
      "Only 2 GB free space left on the disk.",
      "Check the free disk space before installing.",
      "The error was FreeUsageLimitError in the log.",
      "Use a Automático model here.",
    ]) {
      expect(json).toContain(kept)
    }
  })

  test("keeps the free-tier word inside image data", () => {
    const blob = `${"A".repeat(100)}free${"B".repeat(100)}`

    const assistant = {
      id: "msg_assistant_blob_free",
      type: "assistant",
      agent: "build",
      tokens,
      time: { created: 1100 },
      content: [
        { type: "text", text: blob },
        { type: "text", text: "use a free model" },
      ],
    }

    const info = { id: "ses_1" } as SessionInfo
    const messages = [assistant] as unknown as SessionMessageInfo[]

    const result = sanitizeSessionExport({ info, messages })

    expect(result.messages[0]).toEqual({
      id: "msg_assistant_blob_free",
      type: "assistant",
      agent: "build",
      tokens,
      time: { created: 1100 },
      content: [
        { type: "text", text: blob },
        { type: "text", text: "use a Automático model" },
      ],
    })
  })

  test("keeps tier and quota words inside image data", () => {
    const blob = `${"A".repeat(100)}cota${"B".repeat(100)}`

    const assistant = {
      id: "msg_assistant_blob_tier",
      type: "assistant",
      agent: "build",
      tokens,
      time: { created: 1100 },
      content: [
        { type: "text", text: blob },
        { type: "text", text: "a cota estourou" },
      ],
    }

    const info = { id: "ses_1" } as SessionInfo
    const messages = [assistant] as unknown as SessionMessageInfo[]

    const result = sanitizeSessionExport({ info, messages })

    expect(result.messages[0]).toEqual({
      id: "msg_assistant_blob_tier",
      type: "assistant",
      agent: "build",
      tokens,
      time: { created: 1100 },
      content: [
        { type: "text", text: blob },
        { type: "text", text: "a uso estourou" },
      ],
    })
  })

  test("keeps a web search and file paths that only look like a model reference", () => {
    const assistant = {
      id: "msg_assistant_keep",
      type: "assistant",
      agent: "build",
      tokens,
      time: { created: 1100 },
      content: [
        { type: "text", text: "Vou buscar no Google e ver api/leads e chat/completions." },
        {
          type: "text",
          text: "Arquivo em C:/Users/ManosTech/AppData/Local/Temp/opencode/previas-test/gerar.js",
        },
        { type: "text", text: "Resposta em application/json de public/app.js." },
      ],
    }

    const info = { id: "ses_1" } as SessionInfo
    const messages = [assistant] as unknown as SessionMessageInfo[]

    const json = JSON.stringify(sanitizeSessionExport({ info, messages }))

    for (const kept of [
      "buscar no Google",
      "api/leads",
      "chat/completions",
      "C:/Users/ManosTech/AppData/Local/Temp/ManosTech.AI/previas-test/gerar.js",
      "application/json",
      "public/app.js",
    ]) {
      expect(json).toContain(kept)
    }
  })

  test("keeps image data that happens to contain a model word", () => {
    const blob = `${"A".repeat(100)}+GLm2+${"B".repeat(100)}`

    const assistant = {
      id: "msg_assistant_blob",
      type: "assistant",
      agent: "build",
      tokens,
      time: { created: 1100 },
      content: [
        { type: "text", text: blob },
        { type: "text", text: "o modelo hy4 respondeu" },
      ],
    }

    const info = { id: "ses_1" } as SessionInfo
    const messages = [assistant] as unknown as SessionMessageInfo[]

    const result = sanitizeSessionExport({ info, messages })

    expect(result.messages[0]).toEqual({
      id: "msg_assistant_blob",
      type: "assistant",
      agent: "build",
      tokens,
      time: { created: 1100 },
      content: [
        { type: "text", text: blob },
        { type: "text", text: "o modelo Automático respondeu" },
      ],
    })
  })
})

describe("sanitizeMessageForDisplay", () => {
  const tokens = { input: 120, output: 45, reasoning: 0, cache: { read: 10, write: 0 } }

  test("shows the conversation without the model, provider or cost", () => {
    const assistant = {
      id: "msg_raw",
      type: "assistant",
      agent: "build",
      model: { id: "mimo-v2.6-flash-free", providerID: "opencode", variant: "default" },
      cost: 0.005,
      tokens,
      time: { created: 1794319025363 },
      content: [
        { type: "reasoning", text: "The company is NOT on Google Maps." },
        { type: "text", text: "A empresa não existe no Google Maps." },
      ],
    } as unknown as SessionMessageInfo

    const result = sanitizeMessageForDisplay(assistant)

    expect(result).toEqual({
      id: "msg_raw",
      type: "assistant",
      agent: "build",
      tokens,
      time: { created: 1794319025363 },
      content: [
        { type: "reasoning", text: "The company is NOT on Google Maps." },
        { type: "text", text: "A empresa não existe no Google Maps." },
      ],
    })

    const json = JSON.stringify(result)

    for (const leaked of ["mimo-v2.6-flash-free", "providerID", "opencode", "OpenCode", "0.005"]) {
      expect(json).not.toContain(leaked)
    }
  })

  test("scrubs a provider named inside the message text", () => {
    const assistant = {
      id: "msg_raw_text",
      type: "assistant",
      agent: "build",
      tokens,
      time: { created: 1100 },
      content: [{ type: "text", text: "Rodei no opencode com o mimo-v2.6-flash-free e o providerID era opencode." }],
    } as unknown as SessionMessageInfo

    const result = sanitizeMessageForDisplay(assistant)
    const json = JSON.stringify(result)

    expect(json).toContain("Rodei no ManosTech.AI com o Automático e o Automático era ManosTech.AI.")

    for (const leaked of ["mimo-v2.6-flash-free", "providerID", "opencode", "OpenCode"]) {
      expect(json).not.toContain(leaked)
    }
  })

  test("omits a model switch from the raw view", () => {
    const switched = {
      id: "msg_raw_switch",
      type: "model-switched",
      time: { created: 1200 },
      model: { id: "hy4", providerID: "opencode-go" },
      previous: { id: "deepseek-flash", providerID: "deepseek" },
    } as unknown as SessionMessageInfo

    expect(sanitizeMessageForDisplay(switched)).toBeUndefined()
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
