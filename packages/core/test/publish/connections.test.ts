import { describe, expect, test } from "bun:test"
import {
  formatPublishConnectionsBlock,
  readPublishConnections,
} from "@opencode/core/publish/connections"

describe("readPublishConnections", () => {
  test("sem o aplicativo, nada disponível e tudo desconectado", () => {
    const status = readPublishConnections({})

    expect(status.available).toBe(false)
    expect(status.github.connected).toBe(false)
    expect(status.vercel.connected).toBe(false)
    expect(status.supabase.connected).toBe(false)
    expect(formatPublishConnectionsBlock(status)).toBe("")
  })

  test("lê conectado + nome da conta do ambiente do desktop", () => {
    const status = readPublishConnections({
      MANOSTECH_CONNECTIONS_AVAILABLE: "1",
      MANOSTECH_CONN_GITHUB_CONNECTED: "1",
      MANOSTECH_CONN_GITHUB_LOGIN: "gabriel",
      MANOSTECH_CONN_SUPABASE_CONNECTED: "1",
    })

    expect(status.available).toBe(true)
    expect(status.github).toEqual({ provider: "github", connected: true, login: "gabriel" })
    expect(status.vercel).toEqual({ provider: "vercel", connected: false })
    expect(status.supabase).toEqual({ provider: "supabase", connected: true })
  })

  test("uma variável de token no ambiente nunca vale como conexão", () => {
    const status = readPublishConnections({
      MANOSTECH_CONNECTIONS_AVAILABLE: "1",
      MANOSTECH_CONN_GITHUB_TOKEN: "token-falso",
    })

    expect(status.github.connected).toBe(false)
  })
})

describe("formatPublishConnectionsBlock", () => {
  test("lista as três conexões com o estado de cada uma, em linguagem simples", () => {
    const block = formatPublishConnectionsBlock(
      readPublishConnections({
        MANOSTECH_CONNECTIONS_AVAILABLE: "1",
        MANOSTECH_CONN_GITHUB_CONNECTED: "1",
        MANOSTECH_CONN_GITHUB_LOGIN: "gabriel",
        MANOSTECH_CONN_VERCEL_CONNECTED: "1",
      }),
    )

    expect(block).toContain("## Conexões da conta do cliente")
    expect(block).toContain("- GitHub: conectado como gabriel")
    expect(block).toContain("- Vercel: conectado")
    expect(block).toContain("- Supabase: não conectado")
    expect(block).toContain('barra lateral, seção "Conexões"')
    expect(block).not.toContain("token")
  })
})
