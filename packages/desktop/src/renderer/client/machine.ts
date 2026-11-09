import type {
  ManosTechClientErrorValue,
  ManosTechClientStatusValue,
} from "../../shared/ipc-rpc/manostech-client"

/**
 * ManosTech: o portão da conta do cliente. Uma máquina pura: a fase que o
 * usuário vê (checando, login, troca de senha, teste encerrado, pronto).
 * O driver (gate.tsx) roda os efeitos e devolve os resultados como eventos.
 */

export type ClientGateError = ManosTechClientErrorValue["tag"]

export type ClientGateState =
  | { readonly status: "checking" }
  | {
      readonly status: "login"
      readonly googleAvailable: boolean | undefined
      readonly error: ClientGateError | undefined
      readonly busy: boolean
    }
  | { readonly status: "waiting-google"; readonly googleAvailable: boolean }
  | { readonly status: "change-password"; readonly error: ClientGateError | undefined; readonly busy: boolean }
  | { readonly status: "trial-expired"; readonly trialEndsAt: string | null }
  | { readonly status: "ready"; readonly trialEndsAt: string | null }

export type ClientGateEvent =
  | { readonly type: "status.settled"; readonly status: ManosTechClientStatusValue }
  | { readonly type: "status.failed" }
  | { readonly type: "login.submitted"; readonly email: string; readonly password: string }
  | { readonly type: "login.succeeded"; readonly status: ManosTechClientStatusValue }
  | { readonly type: "login.failed"; readonly error: ManosTechClientErrorValue }
  | { readonly type: "google.availability.settled"; readonly available: boolean }
  | { readonly type: "google.submitted" }
  | { readonly type: "google.started" }
  | { readonly type: "google.unavailable" }
  | { readonly type: "google.cancelled" }
  | { readonly type: "change.submitted"; readonly current: string; readonly next: string }
  | { readonly type: "change.succeeded" }
  | { readonly type: "change.failed"; readonly error: ManosTechClientErrorValue }
  | { readonly type: "client.changed" }
  | { readonly type: "revalidate" }
  | { readonly type: "disposed" }

export type ClientGateEffect =
  | { readonly type: "check-status" }
  | { readonly type: "check-google" }
  | { readonly type: "do-login"; readonly email: string; readonly password: string }
  | { readonly type: "do-change"; readonly current: string; readonly next: string }
  | { readonly type: "do-google-start" }
  | { readonly type: "schedule-revalidation" }
  | { readonly type: "cancel-revalidation" }

export type ClientGateTransition = {
  readonly state: ClientGateState
  readonly effects: readonly ClientGateEffect[]
}

export function createClientGateState(): ClientGateTransition {
  return { state: { status: "checking" }, effects: [{ type: "check-status" }] }
}

function fromStatus(status: ManosTechClientStatusValue): ClientGateTransition {
  if (status.state === "logged-out")
    return {
      state: { status: "login", googleAvailable: undefined, error: undefined, busy: false },
      effects: [{ type: "check-google" }],
    }

  if (status.state === "must-change")
    return { state: { status: "change-password", error: undefined, busy: false }, effects: [] }

  if (status.state === "trial-expired")
    return { state: { status: "trial-expired", trialEndsAt: status.trialEndsAt }, effects: [] }

  return { state: { status: "ready", trialEndsAt: status.trialEndsAt }, effects: [{ type: "schedule-revalidation" }] }
}

function to(state: ClientGateState, effects: readonly ClientGateEffect[] = []): ClientGateTransition {
  return { state, effects }
}

function unchanged(state: ClientGateState): ClientGateTransition {
  return { state, effects: [] }
}

export function transitionClientGate(state: ClientGateState, event: ClientGateEvent): ClientGateTransition {
  if (event.type === "disposed") return to(state, [{ type: "cancel-revalidation" }])

  if (event.type === "client.changed") {
    if (state.status === "checking") return unchanged(state)

    return to({ status: "checking" }, [{ type: "check-status" }])
  }

  if (event.type === "revalidate") {
    if (state.status !== "ready") return unchanged(state)

    return to({ status: "checking" }, [{ type: "check-status" }])
  }

  if (event.type === "status.settled") return fromStatus(event.status)

  if (event.type === "status.failed") {
    if (state.status !== "checking") return unchanged(state)

    return to(
      { status: "login", googleAvailable: false, error: "network", busy: false },
      [{ type: "check-google" }],
    )
  }

  if (event.type === "login.submitted") {
    if (state.status !== "login" || state.busy) return unchanged(state)

    return to({ ...state, busy: true }, [{ type: "do-login", email: event.email, password: event.password }])
  }

  if (event.type === "login.succeeded") return fromStatus(event.status)

  if (event.type === "login.failed") {
    if (state.status !== "login") return unchanged(state)

    return to({ ...state, busy: false, error: event.error.tag })
  }

  if (event.type === "google.availability.settled") {
    if (state.status !== "login") return unchanged(state)

    return to({ ...state, googleAvailable: event.available })
  }

  if (event.type === "google.submitted") {
    if (state.status !== "login" || state.busy) return unchanged(state)

    return to({ ...state, busy: true }, [{ type: "do-google-start" }])
  }

  if (event.type === "google.started") {
    if (state.status !== "login") return unchanged(state)

    return to({ status: "waiting-google", googleAvailable: state.googleAvailable ?? false })
  }

  if (event.type === "google.unavailable") {
    if (state.status !== "login") return unchanged(state)

    return to({ ...state, busy: false, error: "google-unavailable" })
  }

  if (event.type === "google.cancelled") {
    if (state.status !== "waiting-google") return unchanged(state)

    return to({ status: "login", googleAvailable: state.googleAvailable, error: undefined, busy: false })
  }

  if (event.type === "change.submitted") {
    if (state.status !== "change-password" || state.busy) return unchanged(state)

    return to({ ...state, busy: true }, [{ type: "do-change", current: event.current, next: event.next }])
  }

  if (event.type === "change.succeeded") {
    if (state.status !== "change-password") return unchanged(state)

    return to({ status: "checking" }, [{ type: "check-status" }])
  }

  if (event.type === "change.failed") {
    if (state.status !== "change-password") return unchanged(state)

    return to({ ...state, busy: false, error: event.error.tag })
  }

  return unchanged(state)
}

/** O texto do erro que a tela mostra, por chave i18n. */
export function errorKey(error: ClientGateError): string {
  switch (error) {
    case "invalid-credentials":
      return "client.login.error.invalidCredentials"
    case "account-inactive":
      return "client.login.error.accountInactive"
    case "trial-expired":
      return "client.login.error.trialExpired"
    case "password-too-short":
      return "client.changePassword.error.tooShort"
    case "email-in-use":
      return "client.login.error.emailInUse"
    case "google-unavailable":
      return "client.login.error.googleUnavailable"
    case "network":
      return "client.login.error.network"
    default:
      return "client.login.error.unknown"
  }
}
