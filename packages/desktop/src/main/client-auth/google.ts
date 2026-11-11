import { createHash, randomBytes } from "node:crypto"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { nativeLocale, nativeT } from "../native/translations"

/**
 * ManosTech: login com Google (OAuth 2.0 + PKCE) no navegador do sistema.
 * O retorno volta por loopback (RFC 8252): o main abre um listener curto
 * em 127.0.0.1 com porta efêmera e o Google devolve o código lá. Clientes
 * OAuth Desktop não têm campo de redirect URI no Console — nenhum esquema
 * próprio pode ser registrado — então o retorno por deep-link não funciona
 * (redirect_uri_mismatch). O Client ID vem embutido no build
 * (MANOSTECH_GOOGLE_CLIENT_ID); sem ele, o botão não aparece.
 *
 * O painel aceita o ID token do Google (POST /api/auth/google), não o
 * código: o app troca o código pelo id_token no endpoint de token do
 * Google e só então chama o painel. O Client ID e o segredo vêm
 * embutidos no build (MANOSTECH_GOOGLE_CLIENT_ID /
 * MANOSTECH_GOOGLE_CLIENT_SECRET); sem o ID, o botão não aparece; sem
 * o segredo, a troca do código é rejeitada (400 invalid_request) — o
 * endpoint de token exige o segredo para clientes Desktop.
 */

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"

const LOOPBACK_PATH = "/auth/google"

const EXCHANGE_TIMEOUT_MS = 10_000

// O listener morre sozinho se o usuário abandonar o login no navegador;
// o mesmo prazo do fluxo pendente em client-auth.
const LOOPBACK_TIMEOUT_MS = 10 * 60_000

const base64url = (buffer: Buffer) => buffer.toString("base64url")

function tokenUrl(env: Record<string, string | undefined>): string {
  return env.MANOSTECH_GOOGLE_TOKEN_URL ?? GOOGLE_TOKEN_URL
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(64))
  const challenge = base64url(createHash("sha256").update(verifier).digest())

  return { verifier, challenge }
}

export function createState(): string {
  return randomBytes(32).toString("hex")
}

/** O redirect do fluxo: loopback com porta efêmera, o único que o Google aceita para Desktop. */
export function loopbackRedirectUri(port: number): string {
  return `http://127.0.0.1:${port}${LOOPBACK_PATH}`
}

export function authorizeUrl(input: {
  clientId: string
  state: string
  challenge: string
  redirectUri: string
}): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth")
  url.searchParams.set("client_id", input.clientId)
  url.searchParams.set("redirect_uri", input.redirectUri)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("scope", "openid email profile")
  url.searchParams.set("state", input.state)
  url.searchParams.set("code_challenge", input.challenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("access_type", "offline")
  url.searchParams.set("prompt", "select_account")

  return url.toString()
}

export type AuthReturn =
  | { readonly kind: "code"; readonly code: string; readonly state: string }
  | { readonly kind: "error"; readonly state?: string }

/** Só reconhece o retorno do Google no loopback; qualquer outra origem não é nossa. */
export function parseAuthReturn(url: string): AuthReturn | undefined {
  let parsed: URL

  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }

  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") return undefined
  if (parsed.pathname !== LOOPBACK_PATH && parsed.pathname !== `${LOOPBACK_PATH}/`) return undefined

  const error = parsed.searchParams.get("error")

  if (error) {
    const state = parsed.searchParams.get("state")
    return state ? { kind: "error", state } : { kind: "error" }
  }

  const code = parsed.searchParams.get("code")
  const state = parsed.searchParams.get("state")

  if (!code || !state) return undefined

  return { kind: "code", code, state }
}

/** O motivo da troca falhada: rede (inclui o timeout), rejeição do Google ou resposta sem ID token. */
export type ExchangeFailure =
  | { readonly reason: "network"; readonly error: string }
  | { readonly reason: "rejected"; readonly status: number; readonly error: string | undefined }
  | { readonly reason: "bad-response" }

export type ExchangeResult =
  | { readonly ok: true; readonly idToken: string }
  | { readonly ok: false; readonly failure: ExchangeFailure }

/** Troca o código da autorização pelo ID token no Google (PKCE + o client_secret quando o build tem um). */
export async function exchangeCodeForIdToken(
  env: Record<string, string | undefined>,
  input: {
    clientId: string
    clientSecret?: string
    code: string
    codeVerifier: string
    redirectUri: string
  },
): Promise<ExchangeResult> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    client_id: input.clientId,
    code_verifier: input.codeVerifier,
    redirect_uri: input.redirectUri,
    ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
  })

  let response: Response

  try {
    response = await fetch(tokenUrl(env), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    })
  } catch (error) {
    return {
      ok: false,
      failure: { reason: "network", error: error instanceof Error ? error.name : "unknown" },
    }
  }

  if (!response.ok) {
    const json: unknown = await response.json().catch(() => undefined)
    const record = (typeof json === "object" && json !== null ? json : {}) as Record<string, unknown>
    // Só o código de erro OAuth (invalid_grant, invalid_client...): nunca
    // a descrição, que pode ecoar o pedido.
    const error = typeof record.error === "string" ? record.error : undefined

    return { ok: false, failure: { reason: "rejected", status: response.status, error } }
  }

  const json: unknown = await response.json().catch(() => undefined)

  if (typeof json !== "object" || json === null) return { ok: false, failure: { reason: "bad-response" } }

  const idToken = (json as Record<string, unknown>).id_token

  return typeof idToken === "string" && idToken.length > 0
    ? { ok: true, idToken }
    : { ok: false, failure: { reason: "bad-response" } }
}

export type LoopbackListener = {
  readonly redirectUri: string
  readonly code: Promise<AuthReturn>
  readonly close: () => void
}

/**
 * Abre o listener loopback do login Google e devolve o redirect_uri do
 * fluxo com a promessa do código. O listener só aceita o retorno com o
 * state esperado; qualquer outro pedido recebe 400/404 e o fluxo continua
 * esperando. Depois de resolver (código, erro ou tempo esgotado) ele se
 * fecha sozinho; close() aborta antes disso. Rejeita se o loopback não
 * puder ser aberto.
 */
export async function startLoopbackListener(expectedState: string): Promise<LoopbackListener> {
  let resolveCode!: (value: AuthReturn) => void
  const code = new Promise<AuthReturn>((resolve) => {
    resolveCode = resolve
  })

  let settled = false
  let timeout: ReturnType<typeof setTimeout> | undefined

  const server = createServer((request, response) => {
    const parsed = parseAuthReturn(`http://127.0.0.1${request.url ?? "/"}`)

    if (!parsed) {
      response.writeHead(404)
      response.end()
      return
    }

    if (
      (parsed.kind === "code" && parsed.state !== expectedState) ||
      (parsed.kind === "error" && parsed.state && parsed.state !== expectedState)
    ) {
      response.writeHead(400)
      response.end()
      return
    }

    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    response.end(loopbackPage(parsed.kind), () => settle(parsed))
  })

  function settle(result: AuthReturn): void {
    if (settled) return
    settled = true
    clearTimeout(timeout)
    server.close()
    resolveCode(result)
  }

  timeout = setTimeout(() => settle({ kind: "error" }), LOOPBACK_TIMEOUT_MS)
  // O timeout não segura o processo: o app pode fechar sem esperar o login.
  timeout.unref()

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject)
      resolve()
    })
  })

  server.on("error", () => settle({ kind: "error" }))

  const address = server.address() as AddressInfo

  return {
    redirectUri: loopbackRedirectUri(address.port),
    code,
    close: () => settle({ kind: "error" }),
  }
}

function loopbackPage(kind: "code" | "error"): string {
  const title = nativeT(
    kind === "code" ? "desktop.google.loopback.success.title" : "desktop.google.loopback.error.title",
  )
  const message = nativeT(
    kind === "code" ? "desktop.google.loopback.success.message" : "desktop.google.loopback.error.message",
  )
  const lang = nativeLocale() === "br" ? "pt-BR" : "en"

  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${title}</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#040814;color:#e8edf7}main{text-align:center;padding:2rem}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;color:#9aa7bd}</style></head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`
}
