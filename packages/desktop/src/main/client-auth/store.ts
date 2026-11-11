import { randomUUID } from "node:crypto"
import { Option, Schema } from "effect"
import { getStore } from "../storage/store"
import {
  MANOSTECH_CLIENT_API_KEY_KEY,
  MANOSTECH_CLIENT_DEVICE_ID_KEY,
  MANOSTECH_CLIENT_SESSION_KEY,
  MANOSTECH_GATEWAY_URL_KEY,
  MANOSTECH_USAGE_WARNED_KEY,
  MANOSTECH_USAGE_WEEKLY_WARNED_KEY,
} from "../storage/keys"
import { decryptSecret, encryptSecret } from "./secrets"
import type { SessionData } from "./panel"

/**
 * ManosTech: a sessão do cliente vive no store do processo principal
 * (`opencode.settings`), que só o main lê — o renderer nunca toca no
 * arquivo e nunca vê o token. O token é de 30 dias e revogável no servidor.
 * O token é guardado criptografado com o `safeStorage` do Electron (ver
 * `./secrets`); valor antigo em texto claro continua valendo e é
 * re-criptografado na próxima escrita.
 */

const StoredSession = Schema.Struct({
  token: Schema.String,
  expires_at: Schema.NullOr(Schema.String),
  mustChange: Schema.Boolean,
  client: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    email: Schema.String,
    plan: Schema.String,
    ai_mode: Schema.String,
  }),
  trial_ends_at: Schema.NullOr(Schema.String),
})

export type StoredSession = Schema.Schema.Type<typeof StoredSession>

/** Guarda a sessão criptografando o token; o resto (id, e-mail, plano) não é segredo. */
function persistSession(session: StoredSession): void {
  getStore().set(MANOSTECH_CLIENT_SESSION_KEY, { ...session, token: encryptSecret(session.token) })
}

export function saveSession(session: SessionData): void {
  persistSession({
    token: session.token,
    expires_at: session.expires_at,
    mustChange: session.mustChange,
    client: session.client,
    trial_ends_at: session.trial_ends_at,
  })
}

export function loadSession(): StoredSession | undefined {
  const decoded = Schema.decodeUnknownOption(StoredSession)(getStore().get(MANOSTECH_CLIENT_SESSION_KEY))

  if (Option.isNone(decoded)) return undefined

  // Valor criptografado que não descriptografa (outro usuário/máquina,
  // arquivo corrompido) vale como sessão ausente: o login resolve.
  const token = decryptSecret(decoded.value.token)

  if (token === undefined) return undefined

  return { ...decoded.value, token }
}

export function updateSession(patch: Partial<Pick<StoredSession, "mustChange" | "expires_at" | "trial_ends_at">>): void {
  const current = loadSession()

  if (!current) return

  persistSession({ ...current, ...patch })
}

export function clearSession(): void {
  getStore().delete(MANOSTECH_CLIENT_SESSION_KEY)
}

/**
 * ManosTech gateway: a chave API do cliente, guardada no mesmo store do
 * processo principal — o renderer nunca a vê. O painel a renova todo mês e
 * a devolve em claro no login e em GET /api/auth/cliente/api-key, só quando
 * gera uma nova; a validação da sessão só informa o fim do ciclo.
 * Ausente = mantém a guardada, presente = atualiza. A chave é guardada
 * criptografada com o `safeStorage` (ver `./secrets`); valor antigo em
 * texto claro continua valendo e é re-criptografado na próxima escrita.
 */
export function saveApiKey(apiKey: string): void {
  getStore().set(MANOSTECH_CLIENT_API_KEY_KEY, encryptSecret(apiKey))
}

export function loadApiKey(): string | undefined {
  const current = getStore().get(MANOSTECH_CLIENT_API_KEY_KEY)

  if (typeof current !== "string" || current.length === 0) return undefined

  const apiKey = decryptSecret(current)

  return apiKey !== undefined && apiKey.length > 0 ? apiKey : undefined
}

export function clearApiKey(): void {
  getStore().delete(MANOSTECH_CLIENT_API_KEY_KEY)
}

/** A URL do gateway reportada pelo painel, quando houver — o painel não reporta nenhuma, e o default (/v1) vale. */
export function saveGatewayUrl(url: string): void {
  getStore().set(MANOSTECH_GATEWAY_URL_KEY, url)
}

export function loadGatewayUrl(): string | undefined {
  const current = getStore().get(MANOSTECH_GATEWAY_URL_KEY)

  return typeof current === "string" && current.length > 0 ? current : undefined
}

export function clearGatewayUrl(): void {
  getStore().delete(MANOSTECH_GATEWAY_URL_KEY)
}

/**
 * O dia (America/Sao_Paulo) em que a barra avisou dos 85% do uso diário.
 * O aviso aparece uma vez por dia: sem data guardada para hoje, a barra
 * mostra a linha e marca; com a data, silencia até o próximo reset.
 */
export function loadUsageWarnedDay(): string | undefined {
  const current = getStore().get(MANOSTECH_USAGE_WARNED_KEY)

  return typeof current === "string" && current.length > 0 ? current : undefined
}

export function saveUsageWarnedDay(day: string): void {
  getStore().set(MANOSTECH_USAGE_WARNED_KEY, day)
}

export function clearUsageWarnedDay(): void {
  getStore().delete(MANOSTECH_USAGE_WARNED_KEY)
}

/**
 * O ciclo semanal em que a barra avisou dos 75% do uso semanal (a
 * chave do ciclo: o início dele, ou a virada da semana quando o
 * painel não reporta o início). O aviso aparece uma vez por ciclo:
 * sem a chave do ciclo corrente guardada, a barra mostra a linha e
 * marca; com ela, silencia até o próximo ciclo.
 */
export function loadWeeklyWarnedCycle(): string | undefined {
  const current = getStore().get(MANOSTECH_USAGE_WEEKLY_WARNED_KEY)

  return typeof current === "string" && current.length > 0 ? current : undefined
}

export function saveWeeklyWarnedCycle(cycle: string): void {
  getStore().set(MANOSTECH_USAGE_WEEKLY_WARNED_KEY, cycle)
}

export function clearWeeklyWarnedCycle(): void {
  getStore().delete(MANOSTECH_USAGE_WEEKLY_WARNED_KEY)
}

/** Um id estável por instalação; um login novo no mesmo aparelho vence o anterior. */
export function deviceId(): string {
  const store = getStore()
  const current = store.get(MANOSTECH_CLIENT_DEVICE_ID_KEY)

  if (typeof current === "string" && current.length > 0) return current

  const next = randomUUID()
  store.set(MANOSTECH_CLIENT_DEVICE_ID_KEY, next)

  return next
}
