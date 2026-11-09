import { Option, Schema } from "effect"

/**
 * ManosTech: cliente HTTP do Painel Gerenciador para a conta do cliente.
 * Tudo aqui é validado na borda (o painel pode responder qualquer coisa);
 * erros viram um `ClientError` tipado e a interface escolhe o texto em
 * pt-BR pela chave i18n — nunca se mostra texto cru do servidor.
 *
 * Base: https://painel-manostech.manostech.workers.dev, sobrescrita por
 * MANOSTECH_PANEL_URL (só para testes locais com um painel falso).
 *
 * Formas ao vivo (painel, deploy b15b91a0):
 * - login devolve { token, mustChange, client } — sem expires_at e sem
 *   trial; o fim do teste só vem no login com Google e na sessão guardada.
 * - /sessao devolve { client, mustChange, origin, device_id, expires_at }
 *   — sem token (o enviado continua valendo) e sem trial.
 * - trocar-senha com o token: { nova_senha } → { ok: true }.
 * - Google: o app troca o código pelo id_token no próprio Google e manda
 *   { token: id_token, origin, device_id } ao painel.
 * - fim do teste: 403 { erro: "teste_expirado" }.
 */

export const PANEL_BASE_URL = "https://painel-manostech.manostech.workers.dev"

const REQUEST_TIMEOUT_MS = 10_000

export type TrialStatus = "trial" | "paid" | "trial-expired"

export type ClientProfile = {
  readonly id: string
  readonly name: string
  readonly email: string
  readonly plan: string
  readonly ai_mode: string
}

/** A sessão guardada no app. trial_ends_at null = conta paga (ou sem teste). */
export type SessionData = {
  readonly token: string
  readonly mustChange: boolean
  readonly client: ClientProfile
  readonly trial_ends_at: string | null
  readonly expires_at: string | null
}

/** O que a validação da sessão devolve (o token enviado continua valendo). */
export type SessionInfo = {
  readonly mustChange: boolean
  readonly client: ClientProfile
  readonly expires_at: string
}

export type ClientErrorTag =
  | "invalid-credentials"
  | "account-inactive"
  | "trial-expired"
  | "password-too-short"
  | "email-in-use"
  | "google-unavailable"
  | "network"
  | "unknown"

export type ClientError = {
  readonly tag: ClientErrorTag
  readonly trial_ends_at?: string
}

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ClientError }

const ClientResponse = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  email: Schema.String,
  plan: Schema.String,
  ai_mode: Schema.String,
})

const LoginResponse = Schema.Struct({
  token: Schema.String,
  mustChange: Schema.Boolean,
  client: ClientResponse,
})

const SessaoResponse = Schema.Struct({
  client: ClientResponse,
  mustChange: Schema.Boolean,
  origin: Schema.String,
  device_id: Schema.String,
  expires_at: Schema.String,
})

const GoogleResponse = Schema.Struct({
  token: Schema.String,
  mustChange: Schema.Boolean,
  client: ClientResponse,
  trial_ends_at: Schema.NullOr(Schema.String),
  is_trial: Schema.Boolean,
})

export async function login(
  baseUrl: string,
  input: { email: string; password: string; deviceId: string },
): Promise<Result<SessionData>> {
  let response: { status: number; json: unknown }

  try {
    response = await call(baseUrl, "/api/auth/cliente/login", {
      method: "POST",
      body: { email: input.email, senha: input.password, origin: "desktop", device_id: input.deviceId },
    })
  } catch {
    return { ok: false, error: { tag: "network" } }
  }

  if (response.status !== 200) return { ok: false, error: errorFromResponse(response.status, response.json) }

  const decoded = Schema.decodeUnknownOption(LoginResponse)(response.json)

  if (Option.isNone(decoded)) return { ok: false, error: { tag: "unknown" } }

  const value = decoded.value

  return {
    ok: true,
    value: {
      token: value.token,
      mustChange: value.mustChange,
      client: value.client,
      trial_ends_at: null,
      expires_at: null,
    },
  }
}

/** O estado do teste a partir do fim informado pelo servidor. */
export function trialStatus(trialEndsAt: string | null, nowMs: number): TrialStatus {
  if (!trialEndsAt) return "paid"

  return Date.parse(trialEndsAt) > nowMs ? "trial" : "trial-expired"
}

export function panelBaseUrl(env: Record<string, string | undefined>): string {
  return env.MANOSTECH_PANEL_URL ?? PANEL_BASE_URL
}

function errorFromResponse(status: number, body: unknown): ClientError {
  const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>
  const erro = typeof record.erro === "string" ? record.erro : undefined
  const codigo = typeof record.codigo === "string" ? record.codigo : undefined
  const trialEndsAt = typeof record.trial_ends_at === "string" ? record.trial_ends_at : undefined

  if (status === 403 && (erro === "teste_expirado" || codigo === "trial_expirado")) {
    if (trialEndsAt) return { tag: "trial-expired", trial_ends_at: trialEndsAt }

    return { tag: "trial-expired" }
  }
  if (status === 403 && codigo === "conta_inativa") return { tag: "account-inactive" }
  if (status === 409) return { tag: "email-in-use" }
  if (status === 401) return { tag: "invalid-credentials" }
  if (status === 400) return { tag: "password-too-short" }

  return { tag: "unknown" }
}

async function call(
  baseUrl: string,
  path: string,
  init: { method: string; token?: string; body?: unknown },
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method,
    headers: {
      "content-type": "application/json",
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const json: unknown = await response.json().catch(() => undefined)

  return { status: response.status, json }
}

export async function changePassword(
  baseUrl: string,
  input: { token: string; next: string },
): Promise<Result<{ mustChange: boolean }>> {
  let response: { status: number; json: unknown }

  try {
    response = await call(baseUrl, "/api/auth/cliente/trocar-senha", {
      method: "POST",
      token: input.token,
      body: { nova_senha: input.next },
    })
  } catch {
    return { ok: false, error: { tag: "network" } }
  }

  // A troca com o token devolve só { ok: true }; a sessão continua válida
  // e o mustChange já vem zerado na próxima validação.
  if (response.status === 200) return { ok: true, value: { mustChange: false } }

  return { ok: false, error: errorFromResponse(response.status, response.json) }
}

export async function validateSession(baseUrl: string, token: string): Promise<Result<SessionInfo>> {
  let response: { status: number; json: unknown }

  try {
    response = await call(baseUrl, "/api/auth/cliente/sessao", { method: "GET", token })
  } catch {
    return { ok: false, error: { tag: "network" } }
  }

  if (response.status !== 200) return { ok: false, error: errorFromResponse(response.status, response.json) }

  const decoded = Schema.decodeUnknownOption(SessaoResponse)(response.json)

  if (Option.isNone(decoded)) return { ok: false, error: { tag: "unknown" } }

  const value = decoded.value

  return {
    ok: true,
    value: { mustChange: value.mustChange, client: value.client, expires_at: value.expires_at },
  }
}

export async function logout(baseUrl: string, token: string): Promise<void> {
  try {
    await call(baseUrl, "/api/auth/cliente/logout", { method: "POST", token })
  } catch {
    // Sair é local: o servidor só é avisado quando alcança.
  }
}

/**
 * Login com Google: o id_token já verificado no app (troca do código no
 * Google) vira sessão no painel. 401 aqui é o token do Google rejeitado.
 */
export async function googleLogin(
  baseUrl: string,
  input: { idToken: string; deviceId: string },
): Promise<Result<SessionData>> {
  let response: { status: number; json: unknown }

  try {
    response = await call(baseUrl, "/api/auth/google", {
      method: "POST",
      body: { token: input.idToken, origin: "desktop", device_id: input.deviceId },
    })
  } catch {
    return { ok: false, error: { tag: "network" } }
  }

  if (response.status !== 200) {
    const error = errorFromResponse(response.status, response.json)

    if (error.tag === "invalid-credentials") return { ok: false, error: { tag: "google-unavailable" } }

    return { ok: false, error }
  }

  const decoded = Schema.decodeUnknownOption(GoogleResponse)(response.json)

  if (Option.isNone(decoded)) return { ok: false, error: { tag: "unknown" } }

  const value = decoded.value

  return {
    ok: true,
    value: {
      token: value.token,
      mustChange: value.mustChange,
      client: value.client,
      trial_ends_at: value.trial_ends_at,
      expires_at: null,
    },
  }
}
