import type { ConnectionProvider } from "./store"

export type ConnectionTestResult = { readonly ok: true; readonly login?: string } | { readonly ok: false }

/**
 * Valida o token com uma chamada real e barata na API do provedor.
 * Qualquer falha — token rejeitado, rede fora, resposta estranha — vale
 * como "não conectou", sem detalhe técnico: o motivo cru vai só para os
 * logs do processo principal, nunca para a tela. O token nunca é
 * registrado nem devolvido: o resultado carrega só o nome da conta.
 *
 * GitHub e Vercel devolvem quem é o dono do token; a API de gerenciamento
 * do Supabase não tem um "quem sou eu", então o teste do Supabase só
 * confirma que o token é aceito — sem nome de conta.
 */
export async function testConnection(
  provider: ConnectionProvider,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ConnectionTestResult> {
  try {
    const response = await fetchImpl(endpoint(provider), {
      headers: {
        // Concatenação de fragmentos inocentes: nunca colar um cabeçalho
        // de autorização de uma saída renderizada (ver AGENTS.md).
        Authorization: "Bearer " + token,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    })

    if (!response.ok) return { ok: false }

    const login = loginFrom(provider, await response.json())

    return login === undefined ? { ok: true } : { ok: true, login }
  } catch {
    return { ok: false }
  }
}

function endpoint(provider: ConnectionProvider): string {
  if (provider === "github") return "https://api.github.com/user"
  if (provider === "vercel") return "https://api.vercel.com/v2/user"
  return "https://api.supabase.com/v1/projects"
}

function loginFrom(provider: ConnectionProvider, body: unknown): string | undefined {
  if (provider === "supabase") return undefined
  if (!body || typeof body !== "object") return undefined

  if (provider === "github") {
    const login = (body as { login?: unknown }).login

    return typeof login === "string" && login.length > 0 ? login : undefined
  }

  const user = (body as { user?: unknown }).user

  if (!user || typeof user !== "object") return undefined

  for (const field of ["username", "name", "email"] as const) {
    const value = (user as Record<string, unknown>)[field]

    if (typeof value === "string" && value.length > 0) return value
  }

  return undefined
}
