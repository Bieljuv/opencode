import type {
  ManosTechClientErrorValue,
  ManosTechClientStatusValue,
} from "../../shared/ipc-rpc/manostech-client"

/**
 * ManosTech: o portão da conta do cliente. Uma máquina pura: a fase que o
 * usuário vê (checando, login, recuperação de senha, troca de senha, teste
 * encerrado, pronto). O driver (gate.tsx) roda os efeitos e devolve os
 * resultados como eventos.
 */

export type ClientGateError = ManosTechClientErrorValue["tag"]

export type ClientGateState =
  | { readonly status: "checking"; readonly googlePending?: boolean }
  | {
      readonly status: "login"
      readonly googleAvailable: boolean | undefined
      readonly error: ClientGateError | undefined
      readonly busy: boolean
    }
  | { readonly status: "waiting-google"; readonly googleAvailable: boolean; readonly authorizeUrl: string | undefined }
  | { readonly status: "change-password"; readonly error: ClientGateError | undefined; readonly busy: boolean }
  | {
      readonly status: "forgot"
      readonly googleAvailable: boolean | undefined
      readonly error: ClientGateError | undefined
      readonly busy: boolean
    }
  | { readonly status: "forgot-sent"; readonly googleAvailable: boolean | undefined }
  | { readonly status: "trial-expired"; readonly trialEndsAt: string | null }
  | {
      readonly status: "ready"
      readonly trialEndsAt: string | null
      /**
       * A revalidação em andamento: a conta segue pronta na tela enquanto o
       * status é conferido de novo — a tela de "Verificando sua conta…" só
       * aparece na checagem inicial, nunca durante o uso.
       */
      readonly revalidating?: boolean
    }

export type ClientGateEvent =
  | { readonly type: "status.settled"; readonly status: ManosTechClientStatusValue }
  | { readonly type: "status.failed" }
  | { readonly type: "login.submitted"; readonly email: string; readonly password: string }
  | { readonly type: "login.succeeded"; readonly status: ManosTechClientStatusValue }
  | { readonly type: "login.failed"; readonly error: ManosTechClientErrorValue }
  | { readonly type: "google.availability.settled"; readonly available: boolean }
  | { readonly type: "google.submitted" }
  | { readonly type: "google.started"; readonly authorizeUrl: string | undefined }
  | { readonly type: "google.unavailable" }
  | { readonly type: "google.cancelled" }
  | { readonly type: "change.submitted"; readonly current: string; readonly next: string }
  | { readonly type: "change.succeeded" }
  | { readonly type: "change.failed"; readonly error: ManosTechClientErrorValue }
  | { readonly type: "forgot.requested" }
  | { readonly type: "forgot.submitted"; readonly email: string }
  | { readonly type: "forgot.succeeded" }
  | { readonly type: "forgot.failed"; readonly error: ManosTechClientErrorValue }
  | { readonly type: "forgot.cancelled" }
  | { readonly type: "client.changed" }
  | { readonly type: "revalidate" }
  | { readonly type: "disposed" }

export type ClientGateEffect =
  | { readonly type: "check-status" }
  | { readonly type: "check-google" }
  | { readonly type: "do-login"; readonly email: string; readonly password: string }
  | { readonly type: "do-change"; readonly current: string; readonly next: string }
  | { readonly type: "do-forgot"; readonly email: string }
  | { readonly type: "do-google-start" }
  | { readonly type: "do-google-cancel" }
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

    // A mudança chegou enquanto o login Google esperava (o loopback
    // expirou ou o fluxo terminou): a checagem lembra que era o Google,
    // para voltar ao login com erro se o usuário seguiu deslogado.
    if (state.status === "waiting-google")
      return to({ status: "checking", googlePending: true }, [{ type: "check-status" }])

    // A conta já está pronta e o usuário está trabalhando: a checagem roda
    // em silêncio, sem a tela de "Verificando sua conta…". Só o resultado
    // muda a tela — se a conta de fato mudou, o próximo status.settled
    // leva ao login ou ao fim do teste.
    if (state.status === "ready")
      return to({ ...state, revalidating: true }, [{ type: "check-status" }])

    return to({ status: "checking" }, [{ type: "check-status" }])
  }

  if (event.type === "revalidate") {
    if (state.status !== "ready") return unchanged(state)

    // Revalidação silenciosa: a tela segue pronta enquanto o status é
    // conferido de novo. A splash do robô só aparece na checagem inicial.
    return to({ ...state, revalidating: true }, [{ type: "check-status" }])
  }

  if (event.type === "status.settled") {
    // O login Google expirou sem retorno e o usuário seguiu deslogado:
    // volta ao login com erro visível em vez de ficar no spinner.
    if (state.status === "checking" && state.googlePending && event.status.state === "logged-out")
      return to(
        { status: "login", googleAvailable: undefined, error: "unknown", busy: false },
        [{ type: "check-google" }],
      )

    return fromStatus(event.status)
  }

  if (event.type === "status.failed") {
    if (state.status === "checking")
      return to(
        { status: "login", googleAvailable: false, error: "network", busy: false },
        [{ type: "check-google" }],
      )

    // A revalidação silenciosa falhou (rede, por exemplo): a tela segue
    // pronta e a próxima revalidação tenta de novo. Nunca derruba o
    // usuário para o login por uma falha transitória.
    if (state.status === "ready" && state.revalidating)
      return to({ status: "ready", trialEndsAt: state.trialEndsAt }, [{ type: "schedule-revalidation" }])

    return unchanged(state)
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
    if (state.status === "login" || state.status === "forgot" || state.status === "forgot-sent")
      return to({ ...state, googleAvailable: event.available })

    return unchanged(state)
  }

  if (event.type === "google.submitted") {
    if (state.status !== "login" || state.busy) return unchanged(state)

    return to({ ...state, busy: true }, [{ type: "do-google-start" }])
  }

  if (event.type === "google.started") {
    if (state.status !== "login") return unchanged(state)

    return to({
      status: "waiting-google",
      googleAvailable: state.googleAvailable ?? false,
      authorizeUrl: event.authorizeUrl,
    })
  }

  if (event.type === "google.unavailable") {
    if (state.status !== "login") return unchanged(state)

    return to({ ...state, busy: false, error: "google-unavailable" })
  }

  if (event.type === "google.cancelled") {
    if (state.status !== "waiting-google") return unchanged(state)

    return to(
      { status: "login", googleAvailable: state.googleAvailable, error: undefined, busy: false },
      [{ type: "do-google-cancel" }],
    )
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

  if (event.type === "forgot.requested") {
    if (state.status !== "login" || state.busy) return unchanged(state)

    return to({ status: "forgot", googleAvailable: state.googleAvailable, error: undefined, busy: false })
  }

  if (event.type === "forgot.submitted") {
    if (state.status !== "forgot" || state.busy) return unchanged(state)

    return to({ ...state, busy: true }, [{ type: "do-forgot", email: event.email }])
  }

  if (event.type === "forgot.succeeded") {
    if (state.status !== "forgot") return unchanged(state)

    return to({ status: "forgot-sent", googleAvailable: state.googleAvailable })
  }

  if (event.type === "forgot.failed") {
    if (state.status !== "forgot") return unchanged(state)

    return to({ ...state, busy: false, error: event.error.tag })
  }

  if (event.type === "forgot.cancelled") {
    if (state.status !== "forgot" && state.status !== "forgot-sent") return unchanged(state)

    return to({ status: "login", googleAvailable: state.googleAvailable, error: undefined, busy: false })
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
