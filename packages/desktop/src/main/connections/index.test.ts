import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { SecretBackend } from "../client-auth/secrets"
import { createSettingsStore } from "../storage/store"
import {
  disconnectConnection,
  getConnectionStatuses,
  saveConnection,
  setConnectionPermission,
  testStoredConnection,
} from "./index"
import { loadConnectionToken } from "./store"

const fakeBackend: SecretBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (plainText) => Buffer.from(plainText, "utf8").reverse(),
  decryptString: (encrypted) => Buffer.from(encrypted).reverse().toString("utf8"),
}

function tempStore() {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "opencode-connections-")), "opencode.settings")

  return createSettingsStore(file)
}

function fakeFetch(status: number, body: unknown) {
  return async (): Promise<Response> => new Response(JSON.stringify(body), { status })
}

describe("connections service", () => {
  test("conectar: token rejeitado não é guardado", async () => {
    const store = tempStore()

    const result = await saveConnection(store, "github", "token-ruim", fakeFetch(401, { message: "Bad credentials" }))

    expect(result).toEqual({ ok: false })
    expect(getConnectionStatuses(store)).toEqual([
      { provider: "github", connected: false, permission: "ask" },
      { provider: "vercel", connected: false, permission: "ask" },
      { provider: "supabase", connected: false, permission: "ask" },
    ])
  })

  test("conectar: token vazio não é guardado nem validado", async () => {
    const store = tempStore()
    let calls = 0

    const result = await saveConnection(store, "github", "   ", async () => {
      calls += 1
      return new Response("{}", { status: 200 })
    })

    expect(result).toEqual({ ok: false })
    expect(calls).toBe(0)
    expect(loadConnectionToken(store, "github", fakeBackend)).toBeUndefined()
  })

  test("conectar: token aceito é guardado com o nome da conta", async () => {
    const store = tempStore()

    const result = await saveConnection(store, "github", "token-falso", fakeFetch(200, { login: "gabriel" }))

    expect(result).toEqual({ ok: true, login: "gabriel", envChanged: true })
    expect(loadConnectionToken(store, "github", fakeBackend)).toBe("token-falso")
    expect(getConnectionStatuses(store)).toContainEqual({
      provider: "github",
      connected: true,
      login: "gabriel",
      permission: "ask",
    })
  })

  test("conectar de novo com a mesma conta não muda o ambiente do servidor", async () => {
    const store = tempStore()

    await saveConnection(store, "github", "token-falso", fakeFetch(200, { login: "gabriel" }))
    const result = await saveConnection(store, "github", "token-falso", fakeFetch(200, { login: "gabriel" }))

    expect(result).toEqual({ ok: true, login: "gabriel", envChanged: false })
  })

  test("testar: revalida o token guardado e atualiza o nome da conta", async () => {
    const store = tempStore()

    await saveConnection(store, "github", "token-falso", fakeFetch(200, { login: "gabriel" }))
    const result = await testStoredConnection(store, "github", fakeFetch(200, { login: "gabriel-novo" }))

    expect(result).toEqual({ ok: true, login: "gabriel-novo", envChanged: true })
    expect(getConnectionStatuses(store)).toContainEqual({
      provider: "github",
      connected: true,
      login: "gabriel-novo",
      permission: "ask",
    })
  })

  test("testar: sem token guardado, não conecta", async () => {
    const store = tempStore()

    expect(await testStoredConnection(store, "vercel", fakeFetch(200, { user: { username: "x" } }))).toEqual({
      ok: false,
    })
  })

  test("desconectar: apaga o token e a permissão volta ao padrão", async () => {
    const store = tempStore()

    await saveConnection(store, "vercel", "token-falso", fakeFetch(200, { user: { username: "manostech" } }))
    setConnectionPermission(store, "vercel", "allow")
    disconnectConnection(store, "vercel")

    expect(getConnectionStatuses(store)).toContainEqual({
      provider: "vercel",
      connected: false,
      permission: "ask",
    })
    expect(loadConnectionToken(store, "vercel", fakeBackend)).toBeUndefined()
  })
})
