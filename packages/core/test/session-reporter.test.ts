import { describe, expect, test } from "bun:test"
import { Money } from "@opencode/schema/money"
import { Effect, Logger } from "effect"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  GATEWAY_MODEL_ID,
  buildEvent,
  configSkipReason,
  makeReporter,
  parseClientIdentity,
  report,
  resolveConfig,
} from "@opencode/core/session/reporter"
import { withEnv } from "./fixture/env"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe("resolveConfig", () => {
  test("needs the secret and the client file", () => {
    expect(resolveConfig({})).toBeUndefined()
    expect(resolveConfig({ MANOSTECH_INGEST_SECRET: "s" })).toBeUndefined()
    expect(resolveConfig({ MANOSTECH_CLIENT_FILE: "/tmp/c.json" })).toBeUndefined()
  })

  test("defaults to the panel ingest URL", () => {
    expect(resolveConfig({ MANOSTECH_INGEST_SECRET: "s", MANOSTECH_CLIENT_FILE: "/tmp/c.json" })).toEqual({
      url: "https://painel-manostech.manostech.workers.dev/api/ingest",
      secret: "s",
      clientFile: "/tmp/c.json",
    })
  })

  test("a custom ingest URL wins over the default", () => {
    expect(
      resolveConfig({
        MANOSTECH_INGEST_SECRET: "s",
        MANOSTECH_CLIENT_FILE: "/tmp/c.json",
        MANOSTECH_INGEST_URL: "http://127.0.0.1:9999/api/ingest",
      })?.url,
    ).toBe("http://127.0.0.1:9999/api/ingest")
  })
})

describe("parseClientIdentity", () => {
  test("accepts a valid identity file", () => {
    expect(parseClientIdentity(JSON.stringify({ client_id: "abc", client_email: "Cliente@Exemplo.com" }))).toEqual({
      client_id: "abc",
      client_email: "cliente@exemplo.com",
    })
  })

  test("rejects malformed JSON, missing fields and a bad email", () => {
    expect(parseClientIdentity("not json")).toBeUndefined()
    expect(parseClientIdentity(JSON.stringify({ client_id: "abc" }))).toBeUndefined()
    expect(parseClientIdentity(JSON.stringify({ client_email: "a@b.com" }))).toBeUndefined()
    expect(parseClientIdentity(JSON.stringify({ client_id: "", client_email: "a@b.com" }))).toBeUndefined()
    expect(parseClientIdentity(JSON.stringify({ client_id: "abc", client_email: "not-an-email" }))).toBeUndefined()
    expect(parseClientIdentity(JSON.stringify({ client_id: "abc", client_email: "a@b.com", extra: 1 }))).toEqual({
      client_id: "abc",
      client_email: "a@b.com",
    })
  })
})

describe("configSkipReason", () => {
  test("without the secret the reason is sem segredo", () => {
    expect(configSkipReason({})).toBe("sem segredo")
    expect(configSkipReason({ MANOSTECH_CLIENT_FILE: "/tmp/c.json" })).toBe("sem segredo")
  })

  test("with a secret but no client file the reason is sem arquivo de identidade", () => {
    expect(configSkipReason({ MANOSTECH_INGEST_SECRET: "s" })).toBe("sem arquivo de identidade")
  })

  test("a full config has no skip reason", () => {
    expect(configSkipReason({ MANOSTECH_INGEST_SECRET: "s", MANOSTECH_CLIENT_FILE: "/tmp/c.json" })).toBeUndefined()
  })
})

describe("report", () => {
  const tokens = { input: 100, output: 50, reasoning: 10, cache: { read: 20, write: 5 } }
  const noUsage = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

  // Captures the info-level lines the reporter writes; the reason travels
  // as the second message part, never a secret, token, key or identity.
  // (Effect.logInfo(msg, {...}) keeps the context in the message, and the
  // file formatter flattens it to `motivo="..."` in opencode.log.)
  function captureLogs() {
    const lines: Array<{ level: string; message: unknown }> = []
    const logger = Logger.map(Logger.formatStructured, (entry) => {
      lines.push({ level: entry.level, message: entry.message })
    })
    return { lines, logger }
  }

  test("without a config it never fails the step", async () => {
    await Effect.runPromise(
      withEnv(
        { MANOSTECH_INGEST_SECRET: undefined, MANOSTECH_CLIENT_FILE: undefined, MANOSTECH_INGEST_URL: undefined },
        () => report({ model: "manostech/auto", tokens, cost: Money.USD.make(0.001) }),
      ),
    )
  })

  test("a missing identity file logs sem arquivo de identidade once", async () => {
    const { lines, logger } = captureLogs()
    // A fresh reporter per test: the once-per-reason guard is instance
    // state, so a rerun of this file must see the log again.
    const reporter = makeReporter()
    const dir = mkdtempSync(path.join(tmpdir(), "opencode-reporter-"))
    const missing = path.join(dir, "ausente.json")
    const run = () =>
      Effect.runPromise(
        withEnv(
          { MANOSTECH_INGEST_SECRET: "s", MANOSTECH_CLIENT_FILE: missing, MANOSTECH_INGEST_URL: undefined },
          () =>
            reporter.report({ model: "manostech/auto", tokens, cost: Money.USD.make(0.001) }).pipe(
              Effect.provide(Logger.layer([logger])),
            ),
        ),
      )

    await run()
    expect(lines).toEqual([
      {
        level: "INFO",
        message: ["relatório de uso desligado", { motivo: "sem arquivo de identidade" }],
      },
    ])
    await run()
    expect(lines).toHaveLength(1)
  })

  test("a step with no usage logs sem uso once", async () => {
    const { lines, logger } = captureLogs()
    const reporter = makeReporter()
    const dir = mkdtempSync(path.join(tmpdir(), "opencode-reporter-"))
    const file = path.join(dir, "cliente.json")
    writeFileSync(file, JSON.stringify({ client_id: "abc", client_email: "a@b.com" }))
    const run = () =>
      Effect.runPromise(
        withEnv(
          { MANOSTECH_INGEST_SECRET: "s", MANOSTECH_CLIENT_FILE: file, MANOSTECH_INGEST_URL: undefined },
          () =>
            reporter.report({ model: "manostech/auto", tokens: noUsage, cost: Money.USD.zero }).pipe(
              Effect.provide(Logger.layer([logger])),
            ),
        ),
      )

    await run()
    expect(lines).toEqual([
      { level: "INFO", message: ["relatório de uso desligado", { motivo: "sem uso" }] },
    ])
    await run()
    expect(lines).toHaveLength(1)
  })

  test("a step with usage sends one event to the panel and logs nothing", async () => {
    const received: Array<{ body: unknown; authorization: string | null }> = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        received.push({
          body: await request.json().catch(() => undefined),
          authorization: request.headers.get("authorization"),
        })
        return Response.json({ ok: true })
      },
    })
    try {
      const dir = mkdtempSync(path.join(tmpdir(), "opencode-reporter-"))
      const file = path.join(dir, "cliente.json")
      writeFileSync(file, JSON.stringify({ client_id: "abc", client_email: "a@b.com" }))
      const { lines, logger } = captureLogs()
      await Effect.runPromise(
        withEnv(
          {
            MANOSTECH_INGEST_SECRET: "s",
            MANOSTECH_CLIENT_FILE: file,
            MANOSTECH_INGEST_URL: `http://127.0.0.1:${server.port}/api/ingest`,
          },
          () =>
            report({ model: "openrouter/x", tokens, cost: Money.USD.make(0.001) }).pipe(
              Effect.provide(Logger.layer([logger])),
            ),
        ),
      )
      expect(received).toHaveLength(1)
      expect(received[0]?.authorization).toBe("Bearer s")
      expect(received[0]?.body).toEqual({
        client_id: "abc",
        client_email: "a@b.com",
        origin: "desktop",
        model: "openrouter/x",
        event_id: expect.any(String),
        tokens_in: 125,
        tokens_out: 60,
        cost_usd: 0.001,
      })
      expect(lines).toEqual([])
    } finally {
      server.stop()
    }
  })
})

describe("buildEvent", () => {
  const client = { client_id: "abc", client_email: "a@b.com" }
  const tokens = { input: 100, output: 50, reasoning: 10, cache: { read: 20, write: 5 } }

  test("sums input-side tokens and output-side tokens", () => {
    const event = buildEvent({ model: "openrouter/x", tokens, cost: 0.001, client })
    expect(event).toMatchObject({
      client_id: "abc",
      client_email: "a@b.com",
      origin: "desktop",
      model: "openrouter/x",
      tokens_in: 125,
      tokens_out: 60,
      cost_usd: 0.001,
    })
  })

  test("every event carries a unique event_id UUID", () => {
    const first = buildEvent({ model: "openrouter/x", tokens, cost: 0.001, client })
    const second = buildEvent({ model: "openrouter/x", tokens, cost: 0.001, client })
    expect(first?.event_id).toMatch(UUID_PATTERN)
    expect(second?.event_id).toMatch(UUID_PATTERN)
    expect(second?.event_id).not.toBe(first?.event_id)
  })

  test("a step served by the gateway sends nothing (the gateway already measures it)", () => {
    expect(GATEWAY_MODEL_ID).toBe("manostech/auto")
    expect(buildEvent({ model: GATEWAY_MODEL_ID, tokens, cost: 0.001, client })).toBeUndefined()
    expect(buildEvent({ model: "manostech/auto", tokens, cost: 0, client })).toBeUndefined()
  })

  test("a free model still reports its tokens with zero cost", () => {
    expect(buildEvent({ model: "openrouter/x-free", tokens, cost: 0, client })?.cost_usd).toBe(0)
    expect(buildEvent({ model: "openrouter/x-free", tokens, cost: 0, client })?.tokens_in).toBe(125)
  })

  test("a step with no usage at all sends nothing", () => {
    expect(
      buildEvent({
        model: "openrouter/x",
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0,
        client,
      }),
    ).toBeUndefined()
  })
})
