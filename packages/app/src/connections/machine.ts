import { CONNECTION_PROVIDERS, type ConnectionPermission, type ConnectionProvider, type ConnectionStatus } from "./connections"

/**
 * A máquina do painel de conexões: um cartão por provedor, cada um com
 * sua fase — parado, ocupado (salvando, testando ou desconectando) ou
 * com erro. `transition` é pura: sem I/O, sem tempo, sem sinais. O
 * driver (`controller.ts`) roda o trabalho e devolve os resultados como
 * eventos, com o id da tentativa — um resultado atrasado, de uma
 * tentativa que já não é a atual, é ignorado.
 */

export type ConnectionCardState =
  | {
      readonly phase: "idle"
      readonly connected: boolean
      readonly login?: string
      readonly permission: ConnectionPermission
      readonly notice?: "saved" | "tested"
    }
  | {
      readonly phase: "busy"
      readonly operation: "saving" | "testing" | "disconnecting"
      readonly connected: boolean
      readonly login?: string
      readonly permission: ConnectionPermission
      readonly attempt: string
    }
  | {
      readonly phase: "error"
      readonly connected: boolean
      readonly login?: string
      readonly permission: ConnectionPermission
      readonly error: "save-failed" | "test-failed"
    }

export type ConnectionsPanelState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly cards: Record<ConnectionProvider, ConnectionCardState> }
  | { readonly status: "load-failed" }
  | { readonly status: "disposed" }

export type ConnectionsPanelEvent =
  | { readonly type: "loaded"; readonly statuses: readonly ConnectionStatus[] }
  | { readonly type: "load-failed" }
  | { readonly type: "retry-load" }
  | { readonly type: "save-started"; readonly provider: ConnectionProvider; readonly attempt: string }
  | { readonly type: "saved"; readonly provider: ConnectionProvider; readonly attempt: string; readonly login?: string }
  | { readonly type: "save-failed"; readonly provider: ConnectionProvider; readonly attempt: string }
  | { readonly type: "test-started"; readonly provider: ConnectionProvider; readonly attempt: string }
  | { readonly type: "tested"; readonly provider: ConnectionProvider; readonly attempt: string; readonly login?: string }
  | { readonly type: "test-failed"; readonly provider: ConnectionProvider; readonly attempt: string }
  | { readonly type: "disconnect-started"; readonly provider: ConnectionProvider; readonly attempt: string }
  | { readonly type: "disconnected"; readonly provider: ConnectionProvider; readonly attempt: string }
  | { readonly type: "disconnect-failed"; readonly provider: ConnectionProvider; readonly attempt: string }
  | { readonly type: "permission-changed"; readonly provider: ConnectionProvider; readonly permission: ConnectionPermission }
  | { readonly type: "permission-failed"; readonly provider: ConnectionProvider }
  | { readonly type: "refreshed"; readonly statuses: readonly ConnectionStatus[] }
  | { readonly type: "disposed" }

export const initialConnectionsPanelState: ConnectionsPanelState = { status: "loading" }

export function transition(
  state: ConnectionsPanelState,
  event: ConnectionsPanelEvent,
): ConnectionsPanelState {
  if (event.type === "disposed") return { status: "disposed" }
  if (state.status === "disposed") return state

  if (event.type === "loaded") {
    if (state.status !== "loading" && state.status !== "load-failed") return state
    return { status: "ready", cards: cardsFrom(event.statuses) }
  }

  if (event.type === "load-failed") {
    if (state.status !== "loading") return state
    return { status: "load-failed" }
  }

  if (event.type === "retry-load") {
    if (state.status !== "load-failed") return state
    return { status: "loading" }
  }

  if (state.status !== "ready") return state

  if (event.type === "refreshed") {
    if (Object.values(state.cards).some((card) => card.phase === "busy")) return state
    // Um cartão cujo estado não mudou fica como está — inclusive o aviso
    // de "funcionando" e o erro da última operação. Só o que mudou de
    // fato (outra janela, outro processo) ganha um cartão novo, sem aviso.
    const next = {} as Record<ConnectionProvider, ConnectionCardState>
    let changed = false
    for (const provider of CONNECTION_PROVIDERS) {
      const status = event.statuses.find((item) => item.provider === provider)
      const current = state.cards[provider]
      const fresh: ConnectionCardState = {
        phase: "idle",
        connected: status?.connected ?? false,
        ...(status?.login ? { login: status.login } : {}),
        permission: status?.permission ?? "ask",
      }
      if (sameConnection(current, fresh)) {
        next[provider] = current
      } else {
        next[provider] = fresh
        changed = true
      }
    }
    if (!changed) return state
    return { status: "ready", cards: next }
  }

  const nextCards = transitionCard(state.cards, event)

  if (nextCards === state.cards) return state

  return { status: "ready", cards: nextCards }
}

function cardsFrom(statuses: readonly ConnectionStatus[]): Record<ConnectionProvider, ConnectionCardState> {
  const cards = {} as Record<ConnectionProvider, ConnectionCardState>

  for (const provider of CONNECTION_PROVIDERS) {
    const status = statuses.find((item) => item.provider === provider)
    cards[provider] = {
      phase: "idle",
      connected: status?.connected ?? false,
      ...(status?.login ? { login: status.login } : {}),
      permission: status?.permission ?? "ask",
    }
  }

  return cards
}

function transitionCard(
  cards: Record<ConnectionProvider, ConnectionCardState>,
  event: ConnectionsPanelEvent,
): Record<ConnectionProvider, ConnectionCardState> {
  if (event.type === "permission-changed" || event.type === "permission-failed") {
    const card = cards[event.provider]

    if (card.phase === "busy") return cards
    if (event.type === "permission-failed") {
      if (card.phase !== "idle") return cards
      return { ...cards, [event.provider]: { ...idleCard(card), error: "save-failed", phase: "error" } }
    }

    return { ...cards, [event.provider]: { ...idleCard(card), permission: event.permission } }
  }

  const provider = (event as { provider: ConnectionProvider }).provider
  const card = cards[provider]

  if (event.type === "save-started" || event.type === "test-started" || event.type === "disconnect-started") {
    if (card.phase === "busy") return cards
    const operation = event.type === "save-started" ? "saving" : event.type === "test-started" ? "testing" : "disconnecting"

    return { ...cards, [provider]: { ...idleCard(card), phase: "busy", operation, attempt: event.attempt } }
  }

  if (card.phase !== "busy") return cards

  if (event.type === "saved" || event.type === "tested") {
    if (event.attempt !== card.attempt) return cards
    return {
      ...cards,
      [provider]: {
        phase: "idle",
        connected: true,
        ...(event.login ? { login: event.login } : {}),
        permission: card.permission,
        notice: event.type === "saved" ? "saved" : "tested",
      },
    }
  }

  if (event.type === "save-failed" || event.type === "test-failed") {
    if (event.attempt !== card.attempt) return cards
    return {
      ...cards,
      [provider]: { ...idleCard(card), phase: "error", error: event.type === "save-failed" ? "save-failed" : "test-failed" },
    }
  }

  if (event.type === "disconnected") {
    if (event.attempt !== card.attempt) return cards
    return {
      ...cards,
      [provider]: { phase: "idle", connected: false, permission: "ask" },
    }
  }

  if (event.type === "disconnect-failed") {
    if (event.attempt !== card.attempt) return cards
    return { ...cards, [provider]: { ...idleCard(card), phase: "error", error: "save-failed" } }
  }

  return cards
}

function sameConnection(a: ConnectionCardState, b: ConnectionCardState): boolean {
  return a.connected === b.connected && a.login === b.login && a.permission === b.permission
}

function idleCard(card: ConnectionCardState): {
  connected: boolean
  login?: string
  permission: ConnectionPermission
} {
  return {
    connected: card.connected,
    ...(card.login ? { login: card.login } : {}),
    permission: card.permission,
  }
}

/** Seletores: o componente lê estes, nunca a fase diretamente. */
export function isCardBusy(card: ConnectionCardState): boolean {
  return card.phase === "busy"
}

export function cardError(card: ConnectionCardState): "save-failed" | "test-failed" | undefined {
  return card.phase === "error" ? card.error : undefined
}

export function cardNotice(card: ConnectionCardState): "saved" | "tested" | undefined {
  return card.phase === "idle" ? card.notice : undefined
}
