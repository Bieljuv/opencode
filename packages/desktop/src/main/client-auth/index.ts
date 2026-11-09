export * as ManosTechClientAuth from "./index"

import { ManosTechClientChanged } from "../../shared/ipc-rpc/events"
import { MANOSTECH_GOOGLE_CLIENT_ID } from "../constants"
import { openExternalURL } from "../files"
import { emitIpcEvent } from "../ipc-events"
import { getMainWindows } from "../windows"
import { authorizeUrl, createPkce, createState, exchangeCodeForIdToken, parseAuthReturn } from "./google"
import * as Panel from "./panel"
import { clearClientIdentity, writeClientIdentity } from "./reporter-file"
import { clearSession, deviceId, loadSession, saveSession, updateSession } from "./store"

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
  | { readonly state: "ready"; readonly client: { name: string; email: string }; readonly trialEndsAt: string | null }
  | { readonly state: "must-change"; readonly client: { name: string; email: string } }
  | { readonly state: "trial-expired"; readonly trialEndsAt: string | null }

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

function statusFromSession(session: Panel.SessionData): ClientStatus {
  if (session.mustChange) return { state: "must-change", client: { name: session.client.name, email: session.client.email } }
  if (Panel.trialStatus(session.trial_ends_at, Date.now()) === "trial-expired")
    return { state: "trial-expired", trialEndsAt: session.trial_ends_at }

  return {
    state: "ready",
    client: { name: session.client.name, email: session.client.email },
    trialEndsAt: session.trial_ends_at,
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
  }
}

function signOutLocally(): void {
  clearSession()
  clearClientIdentity()
  notifyClientChanged()
}

export async function getStatus(): Promise<ClientStatus> {
  const stored = loadSession()

  if (!stored) return { state: "logged-out" }

  if (stored.expires_at && Date.parse(stored.expires_at) <= Date.now()) {
    signOutLocally()

    return { state: "logged-out" }
  }

  const result = await Panel.validateSession(Panel.panelBaseUrl(process.env), stored.token)

  if (result.ok) {
    const info = result.value
    // A /sessao não reemite token nem trial: o guardado continua valendo.
    updateSession({ mustChange: info.mustChange, expires_at: info.expires_at })

    return statusFromSession({
      token: stored.token,
      mustChange: info.mustChange,
      client: info.client,
      trial_ends_at: stored.trial_ends_at,
      expires_at: info.expires_at,
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
  writeClientIdentity({ id: result.value.client.id, email: result.value.client.email })
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
    writeClientIdentity({ id: result.value.client.id, email: result.value.client.email })
  }

  notifyClientChanged()

  return true
}

export function notifyClientChanged(): void {
  getMainWindows().forEach((win) => emitIpcEvent(win.webContents, new ManosTechClientChanged({})))
}
