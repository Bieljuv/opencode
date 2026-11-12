import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { SecretBackend } from "../client-auth/secrets"
import { createSettingsStore } from "../storage/store"
import {
  clearConnection,
  connectionLoginKey,
  connectionPermissionKey,
  connectionServerEnv,
  connectionTokenKey,
  CONNECTION_PROVIDERS,
  loadAllConnectionStatuses,
  loadConnectionPermission,
  loadConnectionStatus,
  loadConnectionToken,
  saveConnectionLogin,
  saveConnectionPermission,
  saveConnectionToken,
  type ConnectionProvider,
} from "./store"

// Backend falso só para o teste: inverte os bytes, como no teste do
// codec de segredos. O que está sob teste é o envelope e o ciclo de vida
// do token — não a cifra do sistema, que pertence ao Electron.
const fakeBackend: SecretBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (plainText) => Buffer.from(plainText, "utf8").reverse(),
  decryptString: (encrypted) => Buffer.from(encrypted).reverse().toString("utf8"),
}

function tempStore() {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "opencode-connections-")), "opencode.settings")

  return createSettingsStore(file)
}

describe("connection store keys", () => {
  test.each(CONNECTION_PROVIDERS)("the persisted keys keep their names (%s)", (provider) => {
    expect(connectionTokenKey(provider)).toBe(`manostech.conn.${provider}.token`)
    expect(connectionLoginKey(provider)).toBe(`manostech.conn.${provider}.login`)
    expect(connectionPermissionKey(provider)).toBe(`manostech.conn.${provider}.permission`)
  })
})

describe("connection store", () => {
  test.each(CONNECTION_PROVIDERS)("save → status: token guardado criptografado, nunca em claro (%s)", (provider) => {
    const store = tempStore()

    saveConnectionToken(store, provider, "token-falso", fakeBackend)

    const stored = store.get(connectionTokenKey(provider))
    expect(typeof stored).toBe("string")
    expect(stored).not.toBe("token-falso")
    expect(stored).not.toContain("token-falso")
    expect(loadConnectionToken(store, provider, fakeBackend)).toBe("token-falso")
    expect(loadConnectionStatus(store, provider, fakeBackend)).toEqual({
      provider,
      connected: true,
      permission: "ask",
    })
  })

  test.each(CONNECTION_PROVIDERS)("um token novo esquece o nome da conta até o próximo teste (%s)", (provider) => {
    const store = tempStore()

    saveConnectionToken(store, provider, "token-1", fakeBackend)
    saveConnectionLogin(store, provider, "conta-1")
    expect(loadConnectionStatus(store, provider, fakeBackend).login).toBe("conta-1")

    saveConnectionToken(store, provider, "token-2", fakeBackend)
    expect(loadConnectionStatus(store, provider, fakeBackend)).toEqual({
      provider,
      connected: true,
      permission: "ask",
    })
  })

  test.each(CONNECTION_PROVIDERS)("desconectar apaga token, conta e permissão (%s)", (provider) => {
    const store = tempStore()

    saveConnectionToken(store, provider, "token-falso", fakeBackend)
    saveConnectionLogin(store, provider, "conta-1")
    saveConnectionPermission(store, provider, "allow")
    clearConnection(store, provider)

    expect(loadConnectionStatus(store, provider, fakeBackend)).toEqual({
      provider,
      connected: false,
      permission: "ask",
    })
    expect(store.get(connectionTokenKey(provider))).toBeUndefined()
    expect(store.get(connectionLoginKey(provider))).toBeUndefined()
    expect(store.get(connectionPermissionKey(provider))).toBeUndefined()
  })

  test("permissão: padrão é pedir sempre, valor inválido guardado volta ao padrão", () => {
    const store = tempStore()
    const provider: ConnectionProvider = "github"

    expect(loadConnectionPermission(store, provider)).toBe("ask")
    saveConnectionPermission(store, provider, "block")
    expect(loadConnectionPermission(store, provider)).toBe("block")
    store.set(connectionPermissionKey(provider), "sempre")
    expect(loadConnectionPermission(store, provider)).toBe("ask")
  })

  test("todas as conexões começam desconectadas", () => {
    const store = tempStore()

    expect(loadAllConnectionStatuses(store, fakeBackend)).toEqual([
      { provider: "github", connected: false, permission: "ask" },
      { provider: "vercel", connected: false, permission: "ask" },
      { provider: "supabase", connected: false, permission: "ask" },
    ])
  })

  test("connectionServerEnv: só estado e nome da conta — nunca o token", () => {
    const store = tempStore()

    saveConnectionToken(store, "github", "token-falso", fakeBackend)
    saveConnectionLogin(store, "github", "conta-1")
    saveConnectionToken(store, "supabase", "token-falso", fakeBackend)

    const env = connectionServerEnv(loadAllConnectionStatuses(store, fakeBackend))

    expect(env).toEqual({
      MANOSTECH_CONNECTIONS_AVAILABLE: "1",
      MANOSTECH_CONN_GITHUB_CONNECTED: "1",
      MANOSTECH_CONN_GITHUB_LOGIN: "conta-1",
      MANOSTECH_CONN_SUPABASE_CONNECTED: "1",
    })
    expect(JSON.stringify(env)).not.toContain("token-falso")
  })
})
