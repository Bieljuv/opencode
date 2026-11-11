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
 * - gateway (contrato real, deploy 8fe9e7a5): o painel serve a API
 *   OpenAI-compatível em /v1 (chat/completions, models, images/generations)
 *   — nada em /api/gateway. Login e Google devolvem `api_key` em claro SÓ
 *   quando uma chave nova foi gerada (sem chave ou ciclo mensal vencido);
 *   com a chave corrente ainda válida, `api_key` é null e o app mantém a
 *   guardada. A sessão nunca devolve a chave (só `tem_chave_api`,
 *   `key_prefix`, `api_key_renews_at`); `GET /api/auth/cliente/api-key`
 *   devolve a chave em claro só quando gera uma nova naquela chamada.
 *   Nada devolve `gateway_url` — o app usa o default (/v1 ao vivo).
 *   `GET /api/uso` devolve o uso diário `{ usado_percentual, reseta_em }`
 *   com a chave API como Bearer, e o uso semanal em `semanal`
 *   (`{ limite_tokens, usado_tokens, usado_percentual, bloqueado,
 *   liberacao_em, reseta_em }`) quando o cliente tem limite semanal.
 * - a troca chave→sessão (`exchangeApiKey`) ainda não tem endpoint
 *   definido no painel: a função existe com o caminho marcado como
 *   pendente e NÃO é chamada — a sessão de 30 dias cobre o offline.
 * - esqueci-senha: POST /api/auth/cliente/esqueci-senha { email } →
 *   200 { ok: true, mensagem } — SEMPRE genérica, exista o e-mail ou
 *   não; 429 quando o rate limit de recuperação dispara. O painel
 *   gera a senha temporária (12 alfanuméricos), grava o hash dela
 *   como senha do cliente com must_change_password=1 e a envia por
 *   Gmail; e-mail não cadastrado não faz nada e responde igual.
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
  /** Chave API do cliente, quando o painel a devolveu (renovação mensal). */
  readonly apiKey: string | undefined
  /** URL do gateway, quando o painel a reportou. */
  readonly gatewayUrl: string | undefined
}

/** O que a validação da sessão devolve (o token enviado continua valendo). */
export type SessionInfo = {
  readonly mustChange: boolean
  readonly client: ClientProfile
  readonly expires_at: string
  readonly apiKey: string | undefined
  readonly gatewayUrl: string | undefined
  /** Fim do ciclo mensal da chave (`api_key_renews_at`); null = sem chave. */
  readonly apiKeyRenewsAt: string | null
}

/** Uso diário do plano, como o painel expõe em GET /api/uso. */
export type DailyUsage = {
  readonly percent: number
  readonly resetsAt: string
  /** True enquanto o uso diário atingiu o limite e o cliente espera a meia-noite. */
  readonly blocked: boolean
  /** O uso semanal, quando o painel o reporta; undefined = sem limite semanal, a barra some. */
  readonly weekly: WeeklyUsage | undefined
  /** O uso mensal, quando o painel o reporta; undefined = sem limite mensal. */
  readonly monthly: MonthlyUsage | undefined
}

/**
 * Uso mensal do plano, como o painel expõe em `mensal` em GET /api/uso.
 * Só a % e os instantes chegam à interface — nunca a contagem de tokens
 * nem o tamanho do limite.
 */
export type MonthlyUsage = {
  readonly percent: number
  readonly resetsAt: string
  readonly blocked: boolean
  readonly releasesAt: string | undefined
}

/**
 * Uso semanal do plano, como o painel expõe em `semanal` em GET /api/uso.
 * Só a % e os instantes chegam à interface — nunca a contagem de tokens
 * nem o tamanho do limite.
 */
export type WeeklyUsage = {
  readonly percent: number
  readonly resetsAt: string
  readonly blocked: boolean
  readonly releasesAt: string | undefined
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
  api_key: Schema.optional(Schema.NullOr(Schema.String)),
  gateway_url: Schema.optional(Schema.NullOr(Schema.String)),
})

const SessaoResponse = Schema.Struct({
  client: ClientResponse,
  mustChange: Schema.Boolean,
  origin: Schema.String,
  device_id: Schema.String,
  expires_at: Schema.String,
  tem_chave_api: Schema.optional(Schema.Boolean),
  key_prefix: Schema.optional(Schema.NullOr(Schema.String)),
  api_key_renews_at: Schema.optional(Schema.NullOr(Schema.String)),
  api_key: Schema.optional(Schema.NullOr(Schema.String)),
  gateway_url: Schema.optional(Schema.NullOr(Schema.String)),
})

const GoogleResponse = Schema.Struct({
  token: Schema.String,
  mustChange: Schema.Boolean,
  client: ClientResponse,
  trial_ends_at: Schema.NullOr(Schema.String),
  is_trial: Schema.Boolean,
  api_key: Schema.optional(Schema.NullOr(Schema.String)),
  gateway_url: Schema.optional(Schema.NullOr(Schema.String)),
})

const ApiKeyResponse = Schema.Struct({
  api_key: Schema.NullOr(Schema.String),
  key_prefix: Schema.String,
  plan: Schema.String,
  cycle_start_at: Schema.String,
  renews_at: Schema.String,
  gerada_agora: Schema.Boolean,
})

const UsageResponse = Schema.Struct({
  usado_percentual: Schema.Number,
  reseta_em: Schema.String,
  bloqueado: Schema.optional(Schema.Boolean),
})

const WeeklyUsageResponse = Schema.Struct({
  limite_tokens: Schema.NullOr(Schema.Number),
  usado_tokens: Schema.Number,
  usado_percentual: Schema.Number,
  bloqueado: Schema.Boolean,
  liberacao_em: Schema.NullOr(Schema.String),
  reseta_em: Schema.String,
})

const MonthlyUsageResponse = Schema.Struct({
  limite_tokens: Schema.NullOr(Schema.Number),
  usado_tokens: Schema.Number,
  usado_percentual: Schema.Number,
  bloqueado: Schema.Boolean,
  liberacao_em: Schema.NullOr(Schema.String),
  reseta_em: Schema.String,
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
      apiKey: value.api_key ?? undefined,
      gatewayUrl: value.gateway_url ?? undefined,
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

/**
 * Recuperação de senha. O painel responde 200 com a mensagem genérica
 * exista o e-mail ou não, então o 200 é sucesso e qualquer outra coisa
 * é erro — a interface mostra a mensagem genérica existente, nunca o
 * texto do servidor e nunca se o e-mail existe.
 */
export async function forgotPassword(baseUrl: string, email: string): Promise<Result<{ sent: boolean }>> {
  let response: { status: number; json: unknown }

  try {
    response = await call(baseUrl, "/api/auth/cliente/esqueci-senha", {
      method: "POST",
      body: { email },
    })
  } catch {
    return { ok: false, error: { tag: "network" } }
  }

  if (response.status === 200) return { ok: true, value: { sent: true } }

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
    value: {
      mustChange: value.mustChange,
      client: value.client,
      expires_at: value.expires_at,
      apiKey: value.api_key ?? undefined,
      gatewayUrl: value.gateway_url ?? undefined,
      apiKeyRenewsAt: value.api_key_renews_at ?? null,
    },
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
      apiKey: value.api_key ?? undefined,
      gatewayUrl: value.gateway_url ?? undefined,
    },
  }
}

/**
 * Uso diário do plano no painel (GET /api/uso, Bearer = chave API do
 * cliente). Fail-open: qualquer falha ou forma inesperada devolve
 * undefined e a barra simplesmente não renderiza — nada de erro visível.
 * `usado_percentual` é 0–100; `reseta_em` é o instante do reset (meia-noite,
 * America/Sao_Paulo); `bloqueado` diz se o dia estourou (ausente = não).
 * Nunca há contagem de tokens nem tamanho da cota aqui. O objeto `semanal`
 * vem na mesma resposta; um `semanal` malformado ou sem limite esconde só
 * a barra semanal, nunca a diária. O objeto `mensal` vem no mesmo formato
 * do `semanal`; ausente ou malformado, o mensal some sem afetar o resto.
 */
export async function fetchDailyUsage(baseUrl: string, apiKey: string): Promise<DailyUsage | undefined> {
  let response: { status: number; json: unknown }

  try {
    response = await call(baseUrl, "/api/uso", { method: "GET", token: apiKey })
  } catch {
    return undefined
  }

  if (response.status !== 200) return undefined

  const decoded = Schema.decodeUnknownOption(UsageResponse)(response.json)

  if (Option.isNone(decoded)) return undefined

  const value = decoded.value

  if (!Number.isFinite(value.usado_percentual) || value.usado_percentual < 0 || value.usado_percentual > 100)
    return undefined

  return {
    percent: value.usado_percentual,
    resetsAt: value.reseta_em,
    blocked: value.bloqueado ?? false,
    weekly: weeklyUsage(response.json),
    monthly: monthlyUsage(response.json),
  }
}

/** O uso mensal do plano (`mensal` em GET /api/uso), ou undefined. */
function monthlyUsage(json: unknown): MonthlyUsage | undefined {
  const record = (typeof json === "object" && json !== null ? json : {}) as Record<string, unknown>
  const decoded = Schema.decodeUnknownOption(MonthlyUsageResponse)(record.mensal)

  if (Option.isNone(decoded)) return undefined

  const value = decoded.value

  if (!Number.isFinite(value.usado_percentual) || value.usado_percentual < 0 || value.usado_percentual > 100)
    return undefined

  // Sem o `limite_tokens` aqui: o mensal também bloqueia por custo
  // (alert_cost_monthly_usd), e um cliente só com teto de custo tem
  // limite_tokens null com o bloqueio valendo. O painel devolve
  // `mensal: null` quando não há limite mensal nenhum.
  return {
    percent: value.usado_percentual,
    resetsAt: value.reseta_em,
    blocked: value.bloqueado,
    releasesAt: value.liberacao_em ?? undefined,
  }
}

/** O uso semanal do plano (`semanal` em GET /api/uso), ou undefined. */
function weeklyUsage(json: unknown): WeeklyUsage | undefined {
  const record = (typeof json === "object" && json !== null ? json : {}) as Record<string, unknown>
  const decoded = Schema.decodeUnknownOption(WeeklyUsageResponse)(record.semanal)

  if (Option.isNone(decoded)) return undefined

  const value = decoded.value

  if (!Number.isFinite(value.usado_percentual) || value.usado_percentual < 0 || value.usado_percentual > 100)
    return undefined

  if (value.limite_tokens === null || !Number.isFinite(value.limite_tokens) || value.limite_tokens <= 0)
    return undefined

  return {
    percent: value.usado_percentual,
    resetsAt: value.reseta_em,
    blocked: value.bloqueado,
    releasesAt: value.liberacao_em ?? undefined,
  }
}

/**
 * A chave API do cliente (GET /api/auth/cliente/api-key, Bearer = token de
 * sessão). O painel só devolve a chave em claro quando uma NOVA foi gerada
 * nesta chamada (sem chave ou ciclo mensal vencido); com a chave corrente
 * ainda válida, devolve `api_key: null` e o app mantém a guardada — o
 * painel só guarda o hash e não tem como devolver uma chave antiga em
 * claro. É como o app pega a chave nova depois da renovação mensal sem
 * pedir login de novo. Fail-open: qualquer falha ou forma inesperada
 * devolve undefined.
 */
export async function fetchApiKey(baseUrl: string, token: string): Promise<string | undefined> {
  let response: { status: number; json: unknown }

  try {
    response = await call(baseUrl, "/api/auth/cliente/api-key", { method: "GET", token })
  } catch {
    return undefined
  }

  if (response.status !== 200) return undefined

  const decoded = Schema.decodeUnknownOption(ApiKeyResponse)(response.json)

  if (Option.isNone(decoded)) return undefined

  return decoded.value.api_key ?? undefined
}

/**
 * A chave API do cliente depois de uma autenticação: a guardada vale;
 * sem ela — ou com o ciclo mensal vencido — busca uma no painel (o
 * painel só devolve a chave em claro quando gera uma nova nesta chamada).
 * Devolve a chave a guardar, ou undefined quando não há o que guardar
 * (chave corrente válida sem cópia guardada, token revogado, painel fora
 * do ar). Fail-open: sem a chave o app segue sem gateway até a próxima
 * validação da sessão, que tenta de novo.
 */
export async function ensureApiKey(
  baseUrl: string,
  input: { token: string; storedApiKey: string | undefined; renewsDue?: boolean },
): Promise<string | undefined> {
  if (input.storedApiKey !== undefined && !input.renewsDue) return undefined

  return fetchApiKey(baseUrl, input.token)
}

// contrato do painel (pendente): a frente do painel ainda não definiu o
// endpoint de troca chave→sessão — caminho e campos abaixo são PLACEHOLDERS
// e esta função NÃO é chamada. Quando o painel definir, `getStatus()`
// passa a chamá-la quando houver chave guardada sem sessão válida:
// sucesso salva a nova sessão (e a chave, se renovada); falha segue
// logged-out. A sessão de 30 dias já cobre a persistência offline.
const EXCHANGE_PATH = "/api/auth/cliente/trocar-chave" // contrato do painel (pendente)

export async function exchangeApiKey(
  baseUrl: string,
  input: { apiKey: string; deviceId: string },
): Promise<Result<SessionData>> {
  let response: { status: number; json: unknown }

  try {
    response = await call(baseUrl, EXCHANGE_PATH, {
      method: "POST",
      body: { api_key: input.apiKey, origin: "desktop", device_id: input.deviceId },
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
      apiKey: value.api_key ?? undefined,
      gatewayUrl: value.gateway_url ?? undefined,
    },
  }
}
