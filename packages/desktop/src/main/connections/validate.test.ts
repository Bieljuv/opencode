import { describe, expect, test } from "bun:test"
import { testConnection } from "./validate"

// O fetch falso registra a chamada e devolve a resposta programada — o
// que está sob teste é a validação por provedor (endpoint, autenticação,
// leitura do nome da conta, falha sem detalhe), nunca a rede de verdade.
function fakeFetch(status: number, body: unknown, onCall?: (url: string, init: RequestInit) => void) {
  return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    onCall?.(String(url), init ?? {})
    return new Response(JSON.stringify(body), { status })
  }
}

describe("testConnection", () => {
  test("github: token aceito devolve o nome da conta", async () => {
    let seenUrl = ""
    let seenAuth = ""

    const result = await testConnection(
      "github",
      "token-falso",
      fakeFetch(200, { login: "gabriel" }, (url, init) => {
        seenUrl = url
        seenAuth = (init.headers as Record<string, string>).Authorization
      }),
    )

    expect(result).toEqual({ ok: true, login: "gabriel" })
    expect(seenUrl).toBe("https://api.github.com/user")
    expect(seenAuth).toBe("Bearer " + "token-falso")
  })

  test("github: token rejeitado (401) não conecta", async () => {
    const result = await testConnection("github", "token-falso", fakeFetch(401, { message: "Bad credentials" }))

    expect(result).toEqual({ ok: false })
  })

  test("vercel: token aceito devolve o nome da conta", async () => {
    let seenUrl = ""

    const result = await testConnection(
      "vercel",
      "token-falso",
      fakeFetch(200, { user: { username: "manostech" } }, (url) => {
        seenUrl = url
      }),
    )

    expect(result).toEqual({ ok: true, login: "manostech" })
    expect(seenUrl).toBe("https://api.vercel.com/v2/user")
  })

  test("vercel: sem nome na resposta, conecta sem nome de conta", async () => {
    const result = await testConnection("vercel", "token-falso", fakeFetch(200, { user: {} }))

    expect(result).toEqual({ ok: true })
  })

  test("supabase: token aceito conecta sem nome de conta (a API não tem quem-sou-eu)", async () => {
    let seenUrl = ""

    const result = await testConnection(
      "supabase",
      "token-falso",
      fakeFetch(200, [{ id: "projeto-1" }], (url) => {
        seenUrl = url
      }),
    )

    expect(result).toEqual({ ok: true })
    expect(seenUrl).toBe("https://api.supabase.com/v1/projects")
  })

  test("supabase: token rejeitado (403) não conecta", async () => {
    const result = await testConnection("supabase", "token-falso", fakeFetch(403, { message: "Forbidden" }))

    expect(result).toEqual({ ok: false })
  })

  test("rede fora ou resposta estranha vale como não conectado, sem lançar", async () => {
    const throwing = async (): Promise<Response> => {
      throw new Error("rede fora")
    }

    expect(await testConnection("github", "token-falso", throwing)).toEqual({ ok: false })
    expect(await testConnection("github", "token-falso", fakeFetch(200, null))).toEqual({ ok: true })
    expect(await testConnection("github", "token-falso", fakeFetch(500, { message: "erro" }))).toEqual({
      ok: false,
    })
  })
})
