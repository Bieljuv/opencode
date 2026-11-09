import { describe, expect, test } from "bun:test"
import { buildEvent, parseClientIdentity, resolveConfig } from "@opencode/core/session/reporter"

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

describe("buildEvent", () => {
  const client = { client_id: "abc", client_email: "a@b.com" }
  const tokens = { input: 100, output: 50, reasoning: 10, cache: { read: 20, write: 5 } }

  test("sums input-side tokens and output-side tokens", () => {
    expect(buildEvent({ model: "openrouter/x", tokens, cost: 0.001, client })).toEqual({
      client_id: "abc",
      client_email: "a@b.com",
      origin: "desktop",
      model: "openrouter/x",
      tokens_in: 125,
      tokens_out: 60,
      cost_usd: 0.001,
    })
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
