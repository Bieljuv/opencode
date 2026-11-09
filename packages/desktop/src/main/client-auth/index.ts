export * as ManosTechClientAuth from "./index"

import { ManosTechClientChanged } from "../../shared/ipc-rpc/events"
import { MANOSTECH_GOOGLE_CLIENT_ID } from "../constants"
import { openExternalURL } from "../files"
import { emitIpcEvent } from "../ipc-events"
import { getMainWindows } from "../windows"
import { authorizeUrl, createPkce, createState, exchangeCodeForIdToken, parseAuthReturn } from "./google"
import { connectGatewayCredential, disconnectGatewayCredential, isGatewayActive, todayInSaoPaulo } from "./gateway"
import * as Panel from "./panel"
import { clearClientIdentity, writeClientIdentity } from "./reporter-file"
import {
  clearApiKey,
  clearGatewayUrl,
  clearSession,
  clearUsageWarnedDay,
  deviceId,
  loadApiKey,
  loadGatewayUrl,
  loadSession,
  loadUsageWarnedDay,
  saveApiKey,
  saveGatewayUrl,
  saveSession,
  saveUsageWarnedDay,
  updateSession,
} from "./store"

/**
 * ManosTech: conta do cliente no app desktop. O processo principal é o
 * dono da sessão: ele fala com o painel, guarda o token e avisa o renderer
 * quando algo muda. O renderer só desenha as telas e chama os RPCs.
 *
 * Regras: sessão de 30 dias; sem sessão válida o app pede login; a troca
 * de senha é obrigatória no primeiro login; o teste de 3h bloqueia quando
 * acaba; sem rede e com sessão guardada, o app confia na sessão (a conta
 * paga nunca é trancada por uma falha do painel).
 */

export type ClientStatus =
  | { readonly state: "logged-out" }
  | {
      readonly state: "ready"
      readonly client: { name: string; email: string }
      readonly trialEndsAt: string | null
      readonly gatewayActive: boolean
    }
  | { readonly state: "must-change"; readonly client: { name: string; email: string } }
  | { readonly state: "trial-expired"; readonly trialEndsAt: string | null }

export type ClientUsage = {
  readonly percent: number
  readonly resetsAt: string
  readonly warnedToday: boolean
}

export type LoginResult =
  | { readonly ok: true; readonly status: ClientStatus }
  | { readonly ok: false; readonly error: Panel.ClientError }

type PendingGoogle = {
  readonly verifier: string
  readonly state: string
  readonly startedAt: number
}

let pendingGoogle: PendingGoogle | undefined

const GOOGLE_FLOW_TTL_MS = 10 * 60_000

/** O par chave→URL que o sidecar já aceitou; vazio = reconectar na próxima chance. */
let gatewayConnectedFor: { apiKey: string; gatewayUrl: string } | undefined

let usageCache: { at: number; value: Panel.DailyUsage | undefined } | undefined

const USAGE_CACHE_MS = 60_000

function statusFromSession(session: Panel.SessionData): ClientStatus {
  if (session.mustChange) return { state: "must-change", client: { name: session.client.name, email: session.client.email } }
  if (Panel.trialStatus(session.trial_ends_at, Date.now()) === "trial-expired")
    return { state: "trial-expired", trialEndsAt: session.trial_ends_at }

  return {
    state: "ready",
    client: { name: session.client.name, email: session.client.email },
    trialEndsAt: session.trial_ends_at,
    gatewayActive: gatewayActive(),
  }
}

function storedStatus(nowMs: number): ClientStatus {
  const stored = loadSession()

  if (!stored) return { state: "logged-out" }

  if (stored.mustChange) return { state: "must-change", client: { name: stored.client.name, email: stored.client.email } }
  if (Panel.trialStatus(stored.trial_ends_at, nowMs) === "trial-expired")
    return { state: "trial-expired", trialEndsAt: stored.trial_ends_at }

  return {
    state: "ready",
    client: { name: stored.client.name, email: stored.client.email },
    trialEndsAt: stored.trial_ends_at,
    gatewayActive: gatewayActive(),
  }
}

function signOutLocally(): void {
  clearSession()
  clearApiKey()
  clearGatewayUrl()
  clearUsageWarnedDay()
  clearClientIdentity()
  gatewayConnectedFor = undefined
  usageCache = undefined
  // Sem a credencial no servidor, o provedor do gateway some do pool.
  void disconnectGatewayCredential()
  notifyClientChanged()
}

/** O gateway está ativo: chave + URL guardadas e credencial aceita no servidor. */
export function gatewayActive(): boolean {
  return isGatewayActive({
    connected: gatewayConnectedFor !== undefined,
    apiKey: loadApiKey(),
    gatewayUrl: loadGatewayUrl(),
  })
}

/**
 * Conecta (ou reconecta) a credencial do gateway no servidor quando a
 * chave ou a URL mudou — ou quando o app reiniciou. Idempotente e
 * fail-open: o app segue com os provedores atuais se o servidor não
 * aceitar (flag desligada, servidor fora do ar, integração ausente).
 */
async function refreshGatewayCredential(): Promise<void> {
  const apiKey = loadApiKey()
  const gatewayUrl = loadGatewayUrl()

  if (!apiKey || !gatewayUrl) {
    gatewayConnectedFor = undefined
    return
  }

  if (
    gatewayConnectedFor?.apiKey === apiKey &&
    gatewayConnectedFor?.gatewayUrl === gatewayUrl
  )
    return

  gatewayConnectedFor = (await connectGatewayCredential(apiKey, gatewayUrl))
    ? { apiKey, gatewayUrl }
    : undefined
}

/** Guarda chave e URL quando o painel as devolve (ausente = mantém a guardada). */
function storeGatewayCredentials(apiKey: string | undefined, gatewayUrl: string | undefined): void {
  if (apiKey) saveApiKey(apiKey)
  if (gatewayUrl) saveGatewayUrl(gatewayUrl)
}

/** Uso diário do plano (GET /api/uso), com cache curto; sem gateway ativo, nada. */
export async function getDailyUsage(): Promise<Panel.DailyUsage | undefined> {
  if (!gatewayActive()) return undefined

  const now = Date.now()

  if (usageCache && now - usageCache.at < USAGE_CACHE_MS) return usageCache.value

  const apiKey = loadApiKey()

  if (!apiKey) return undefined

  const value = await Panel.fetchDailyUsage(Panel.panelBaseUrl(process.env), apiKey)
  usageCache = { at: now, value }

  return value
}

/** Uso diário para a UI: null sem gateway ativo ou sem dados (a barra some). */
export async function getClientUsage(): Promise<ClientUsage | null> {
  const usage = await getDailyUsage()

  if (!usage) return null

  return { percent: usage.percent, resetsAt: usage.resetsAt, warnedToday: wasUsageWarnedToday() }
}

/** O aviso dos 85% já apareceu hoje (America/Sao_Paulo)? */
export function wasUsageWarnedToday(): boolean {
  return loadUsageWarnedDay() === todayInSaoPaulo(Date.now())
}

/** Marca o aviso dos 85% como mostrado hoje. */
export function markUsageWarnedToday(): void {
  saveUsageWarnedDay(todayInSaoPaulo(Date.now()))
}

export async function getStatus(): Promise<ClientStatus> {
  const stored = loadSession()

  if (!stored) return { state: "logged-out" }

  if (stored.expires_at && Date.parse(stored.expires_at) <= Date.now()) {
    signOutLocally()

    return { state: "logged-out" }
  }

  // Local e barato quando já conectado: cobre o reinício do app e o
  // offline (a validação no painel pode falhar e a sessão guardada vale).
  await refreshGatewayCredential()

  const result = await Panel.validateSession(Panel.panelBaseUrl(process.env), stored.token)

  if (result.ok) {
    const info = result.value
    // A /sessao não reemite token nem trial: o guardado continua valendo.
    // A chave e a URL, quando vêm, renovam o guardado (renovação mensal).
    updateSession({ mustChange: info.mustChange, expires_at: info.expires_at })
    storeGatewayCredentials(info.apiKey, info.gatewayUrl)
    await refreshGatewayCredential()

    return statusFromSession({
      token: stored.token,
      mustChange: info.mustChange,
      client: info.client,
      trial_ends_at: stored.trial_ends_at,
      expires_at: info.expires_at,
      apiKey: info.apiKey,
      gatewayUrl: info.gatewayUrl,
    })
  }

  if (result.error.tag === "invalid-credentials") {
    signOutLocally()

    return { state: "logged-out" }
  }

  if (result.error.tag === "trial-expired")
    return { state: "trial-expired", trialEndsAt: result.error.trial_ends_at ?? stored.trial_ends_at }

  if (result.error.tag === "account-inactive") {
    signOutLocally()

    return { state: "logged-out" }
  }

  return storedStatus(Date.now())
}

export async function login(email: string, password: string): Promise<LoginResult> {
  const result = await Panel.login(Panel.panelBaseUrl(process.env), {
    email,
    password,
    deviceId: deviceId(),
  })

  if (!result.ok) return { ok: false, error: result.error }

  saveSession(result.value)
  storeGatewayCredentials(result.value.apiKey, result.value.gatewayUrl)
  writeClientIdentity({ id: result.value.client.id, email: result.value.client.email })
  await refreshGatewayCredential()
  notifyClientChanged()

  return { ok: true, status: statusFromSession(result.value) }
}

export async function changePassword(next: string): Promise<{ ok: true } | { ok: false; error: Panel.ClientError }> {
  const stored = loadSession()

  if (!stored) return { ok: false, error: { tag: "invalid-credentials" } }

  // A troca com o token não verifica a senha atual no painel; o token é a
  // prova. A senha atual continua no formulário como confirmação.
  const result = await Panel.changePassword(Panel.panelBaseUrl(process.env), {
    token: stored.token,
    next,
  })

  if (!result.ok) return { ok: false, error: result.error }

  updateSession({ mustChange: false })
  notifyClientChanged()

  return { ok: true }
}

export async function logout(): Promise<void> {
  const stored = loadSession()

  if (stored) await Panel.logout(Panel.panelBaseUrl(process.env), stored.token)

  signOutLocally()
}

/** A conta guardada, sem rede — para a seção Conta nas Configurações. */
export function getAccount(): { name: string; email: string } | undefined {
  const stored = loadSession()

  return stored ? { name: stored.client.name, email: stored.client.email } : undefined
}

export async function googleStart(): Promise<{ available: boolean }> {
  if (!MANOSTECH_GOOGLE_CLIENT_ID) return { available: false }

  const pkce = createPkce()
  pendingGoogle = { verifier: pkce.verifier, state: createState(), startedAt: Date.now() }
  await openExternalURL(
    authorizeUrl({ clientId: MANOSTECH_GOOGLE_CLIENT_ID, state: pendingGoogle.state, challenge: pkce.challenge }),
  )

  return { available: true }
}

export async function googleAvailable(): Promise<boolean> {
  return MANOSTECH_GOOGLE_CLIENT_ID !== undefined
}

/**
 * Recebe um deep-link `manostech://auth/google`. Devolve true quando o link
 * era nosso (mesmo que o fluxo tenha falhado); false para qualquer outro.
 */
export async function handleDeepLink(url: string): Promise<boolean> {
  const parsed = parseAuthReturn(url)

  if (!parsed) return false

  const pending = pendingGoogle
  pendingGoogle = undefined

  if (parsed.kind === "error") {
    notifyClientChanged()

    return true
  }

  if (!pending || pending.state !== parsed.state || Date.now() - pending.startedAt > GOOGLE_FLOW_TTL_MS) {
    notifyClientChanged()

    return true
  }

  if (!MANOSTECH_GOOGLE_CLIENT_ID) {
    notifyClientChanged()

    return true
  }

  // O painel aceita o ID token, não o código: a troca acontece no Google.
  const idToken = await exchangeCodeForIdToken(process.env, {
    clientId: MANOSTECH_GOOGLE_CLIENT_ID,
    code: parsed.code,
    codeVerifier: pending.verifier,
  })

  if (!idToken) {
    notifyClientChanged()

    return true
  }

  const result = await Panel.googleLogin(Panel.panelBaseUrl(process.env), {
    idToken,
    deviceId: deviceId(),
  })

  if (result.ok) {
    saveSession(result.value)
    storeGatewayCredentials(result.value.apiKey, result.value.gatewayUrl)
    writeClientIdentity({ id: result.value.client.id, email: result.value.client.email })
    await refreshGatewayCredential()
  }

  notifyClientChanged()

  return true
}

export function notifyClientChanged(): void {
  getMainWindows().forEach((win) => emitIpcEvent(win.webContents, new ManosTechClientChanged({})))
}
