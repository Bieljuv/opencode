import { createHash, randomBytes } from "node:crypto"

/**
 * ManosTech: login com Google (OAuth 2.0 + PKCE) no navegador do sistema.
 * O retorno volta pelo deep-link `manostech://auth/google`, que o main
 * intercepta antes de chegar ao renderer. O Client ID vem embutido no
 * build (MANOSTECH_GOOGLE_CLIENT_ID); sem ele, o botão não aparece.
 *
 * O painel aceita o ID token do Google (POST /api/auth/google), não o
 * código: o app troca o código pelo id_token no endpoint de token do
 * Google e só então chama o painel.
 */

export const GOOGLE_REDIRECT_URI = "manostech://auth/google"

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"

const EXCHANGE_TIMEOUT_MS = 10_000

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

export function authorizeUrl(input: { clientId: string; state: string; challenge: string }): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth")
  url.searchParams.set("client_id", input.clientId)
  url.searchParams.set("redirect_uri", GOOGLE_REDIRECT_URI)
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
  | { readonly kind: "error" }

/** Só reconhece o retorno do Google; qualquer outro deep-link não é nosso. */
export function parseAuthReturn(url: string): AuthReturn | undefined {
  if (!url.startsWith(`${GOOGLE_REDIRECT_URI}?`) && !url.startsWith(`${GOOGLE_REDIRECT_URI}/?`)) return undefined

  const parsed = new URL(url)
  const error = parsed.searchParams.get("error")

  if (error) return { kind: "error" }

  const code = parsed.searchParams.get("code")
  const state = parsed.searchParams.get("state")

  if (!code || !state) return undefined

  return { kind: "code", code, state }
}

/** Troca o código da autorização pelo ID token no Google (PKCE, sem segredo). */
export async function exchangeCodeForIdToken(
  env: Record<string, string | undefined>,
  input: { clientId: string; code: string; codeVerifier: string },
): Promise<string | undefined> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    client_id: input.clientId,
    code_verifier: input.codeVerifier,
    redirect_uri: GOOGLE_REDIRECT_URI,
  })

  let response: Response

  try {
    response = await fetch(tokenUrl(env), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    })
  } catch {
    return undefined
  }

  if (!response.ok) return undefined

  const json: unknown = await response.json().catch(() => undefined)

  if (typeof json !== "object" || json === null) return undefined

  const idToken = (json as Record<string, unknown>).id_token

  return typeof idToken === "string" && idToken.length > 0 ? idToken : undefined
}
