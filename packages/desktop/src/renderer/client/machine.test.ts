import { describe, expect, test } from "bun:test"
import {
  createClientGateState,
  transitionClientGate,
  type ClientGateState,
} from "./machine"

const loggedOut = { state: "logged-out" } as const
const ready = { state: "ready", client: { name: "Ana", email: "ana@exemplo.com" }, trialEndsAt: null, gatewayActive: false } as const
const mustChange = {
  state: "must-change",
  client: { name: "Ana", email: "ana@exemplo.com" },
} as const
const trialExpired = { state: "trial-expired", trialEndsAt: "2026-11-09T06:00:00Z" } as const

describe("createClientGateState", () => {
  test("starts by checking the session", () => {
    const initial = createClientGateState()

    expect(initial.state.status).toBe("checking")
    expect(initial.effects).toEqual([{ type: "check-status" }])
  })
})

describe("status.settled", () => {
  test("no session shows the login and checks Google", () => {
    const next = transitionClientGate({ status: "checking" }, { type: "status.settled", status: loggedOut })

    expect(next.state.status).toBe("login")
    expect(next.effects).toEqual([{ type: "check-google" }])
  })

  test("a forced password change shows the change screen", () => {
    const next = transitionClientGate({ status: "checking" }, { type: "status.settled", status: mustChange })

    expect(next.state).toEqual({ status: "change-password", error: undefined, busy: false })
    expect(next.effects).toEqual([])
  })

  test("an expired trial blocks the editor", () => {
    const next = transitionClientGate({ status: "checking" }, { type: "status.settled", status: trialExpired })

    expect(next.state).toEqual({ status: "trial-expired", trialEndsAt: "2026-11-09T06:00:00Z" })
  })

  test("a valid session is ready and schedules revalidation", () => {
    const next = transitionClientGate({ status: "checking" }, { type: "status.settled", status: ready })

    expect(next.state).toEqual({ status: "ready", trialEndsAt: null, apiKeyRenewsAt: null })
    expect(next.effects).toEqual([{ type: "schedule-revalidation" }])
  })

  test("a valid session carries the key renewal date into ready", () => {
    const withRenewal = { ...ready, apiKeyRenewsAt: "2026-12-01T03:00:00Z" } as const
    const next = transitionClientGate({ status: "checking" }, { type: "status.settled", status: withRenewal })

    expect(next.state).toEqual({
      status: "ready",
      trialEndsAt: null,
      apiKeyRenewsAt: "2026-12-01T03:00:00Z",
    })
    expect(next.effects).toEqual([{ type: "schedule-revalidation" }])
  })
})

describe("login", () => {
  const login: ClientGateState = { status: "login", googleAvailable: true, error: undefined, busy: false }

  test("submitting locks the form and calls the login", () => {
    const next = transitionClientGate(login, { type: "login.submitted", email: "a@b.com", password: "segredo" })

    expect(next.state).toEqual({ ...login, busy: true })
    expect(next.effects).toEqual([{ type: "do-login", email: "a@b.com", password: "segredo" }])
  })

  test("a second submit while busy is ignored", () => {
    const busy = { ...login, busy: true }
    const next = transitionClientGate(busy, { type: "login.submitted", email: "a@b.com", password: "segredo" })

    expect(next.state).toBe(busy)
    expect(next.effects).toEqual([])
  })

  test("a wrong password unlocks the form with the error", () => {
    const busy = { ...login, busy: true }
    const next = transitionClientGate(busy, {
      type: "login.failed",
      error: { tag: "invalid-credentials" },
    })

    expect(next.state).toEqual({ ...login, error: "invalid-credentials" })
  })

  test("a successful login routes by the returned status", () => {
    const busy = { ...login, busy: true }
    const next = transitionClientGate(busy, { type: "login.succeeded", status: mustChange })

    expect(next.state.status).toBe("change-password")
  })
})

describe("google", () => {
  const login: ClientGateState = { status: "login", googleAvailable: true, error: undefined, busy: false }

  test("starting Google waits for the browser return and keeps the authorize URL", () => {
    const submitted = transitionClientGate(login, { type: "google.submitted" })

    expect(submitted.state).toEqual({ ...login, busy: true })
    expect(submitted.effects).toEqual([{ type: "do-google-start" }])

    const started = transitionClientGate(submitted.state, {
      type: "google.started",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=cid",
    })

    expect(started.state).toEqual({
      status: "waiting-google",
      googleAvailable: true,
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=cid",
    })
  })

  test("cancelling the wait returns to the login and closes the flow", () => {
    const next = transitionClientGate(
      { status: "waiting-google", googleAvailable: true, authorizeUrl: undefined },
      { type: "google.cancelled" },
    )

    expect(next.state).toEqual({ status: "login", googleAvailable: true, error: undefined, busy: false })
    expect(next.effects).toEqual([{ type: "do-google-cancel" }])
  })

  test("a change while waiting for Google re-checks and remembers the Google wait", () => {
    const waiting: ClientGateState = { status: "waiting-google", googleAvailable: true, authorizeUrl: undefined }
    const next = transitionClientGate(waiting, { type: "client.changed" })

    expect(next.state).toEqual({ status: "checking", googlePending: true })
    expect(next.effects).toEqual([{ type: "check-status" }])
  })

  test("an expired Google wait returns to the login with an error", () => {
    const next = transitionClientGate(
      { status: "checking", googlePending: true },
      { type: "status.settled", status: loggedOut },
    )

    expect(next.state).toEqual({ status: "login", googleAvailable: undefined, error: "unknown", busy: false })
    expect(next.effects).toEqual([{ type: "check-google" }])
  })

  test("a Google return that completes the login is ready", () => {
    const next = transitionClientGate(
      { status: "checking", googlePending: true },
      { type: "status.settled", status: ready },
    )

    expect(next.state).toEqual({ status: "ready", trialEndsAt: null, apiKeyRenewsAt: null })
    expect(next.effects).toEqual([{ type: "schedule-revalidation" }])
  })

  test("Google unavailable shows the error on the login", () => {
    const busy = { ...login, busy: true }
    const next = transitionClientGate(busy, { type: "google.unavailable" })

    expect(next.state).toEqual({ ...login, error: "google-unavailable" })
  })
})

describe("change-password", () => {
  const change: ClientGateState = { status: "change-password", error: undefined, busy: false }

  test("a successful change re-checks the session", () => {
    const submitted = transitionClientGate(change, {
      type: "change.submitted",
      current: "inicial",
      next: "nova-senha",
    })

    expect(submitted.effects).toEqual([{ type: "do-change", current: "inicial", next: "nova-senha" }])

    const done = transitionClientGate(submitted.state, { type: "change.succeeded" })

    expect(done.state).toEqual({ status: "checking" })
    expect(done.effects).toEqual([{ type: "check-status" }])
  })

  test("a short password keeps the form with the error", () => {
    const busy = { ...change, busy: true }
    const next = transitionClientGate(busy, { type: "change.failed", error: { tag: "password-too-short" } })

    expect(next.state).toEqual({ ...change, error: "password-too-short" })
  })

  test("submitting with an empty current password still calls the change", () => {
    // Conta sem senha (Google): a senha atual não é conferida — o token
    // da sessão é a prova — então o vazio não pode travar o envio.
    const next = transitionClientGate(change, {
      type: "change.submitted",
      current: "",
      next: "nova-senha",
    })

    expect(next.state).toEqual({ ...change, busy: true })
    expect(next.effects).toEqual([{ type: "do-change", current: "", next: "nova-senha" }])
  })
})

describe("trial-expired", () => {
  const expired: ClientGateState = { status: "trial-expired", trialEndsAt: "2026-11-09T06:00:00Z" }

  test("going back re-checks the session instead of staying blocked", () => {
    const next = transitionClientGate(expired, { type: "trial-expired.back" })

    expect(next.state).toEqual({ status: "checking" })
    expect(next.effects).toEqual([{ type: "check-status" }])
  })

  test("going back from another screen does nothing", () => {
    const login: ClientGateState = { status: "login", googleAvailable: true, error: undefined, busy: false }

    expect(transitionClientGate(login, { type: "trial-expired.back" }).state).toBe(login)
  })

  test("a re-check that finds the account paid opens the editor", () => {
    const checking = transitionClientGate(expired, { type: "trial-expired.back" })
    const next = transitionClientGate(checking.state, { type: "status.settled", status: ready })

    expect(next.state).toEqual({ status: "ready", trialEndsAt: null, apiKeyRenewsAt: null })
    expect(next.effects).toEqual([{ type: "schedule-revalidation" }])
  })

  test("a re-check that still finds the trial expired blocks again", () => {
    const checking = transitionClientGate(expired, { type: "trial-expired.back" })
    const next = transitionClientGate(checking.state, { type: "status.settled", status: trialExpired })

    expect(next.state).toEqual(expired)
    expect(next.effects).toEqual([])
  })
})

describe("forgot-password", () => {
  const login: ClientGateState = { status: "login", googleAvailable: true, error: undefined, busy: false }
  const forgot: ClientGateState = { status: "forgot", googleAvailable: true, error: undefined, busy: false }

  test("requesting recovery opens the form, keeping the Google availability", () => {
    const next = transitionClientGate(login, { type: "forgot.requested" })

    expect(next.state).toEqual(forgot)
    expect(next.effects).toEqual([])
  })

  test("a busy login ignores the recovery request", () => {
    const busy = { ...login, busy: true }

    expect(transitionClientGate(busy, { type: "forgot.requested" }).state).toBe(busy)
  })

  test("submitting locks the form and calls the recovery", () => {
    const next = transitionClientGate(forgot, { type: "forgot.submitted", email: "ana@exemplo.com" })

    expect(next.state).toEqual({ ...forgot, busy: true })
    expect(next.effects).toEqual([{ type: "do-forgot", email: "ana@exemplo.com" }])
  })

  test("a second submit while busy is ignored", () => {
    const busy = { ...forgot, busy: true }

    expect(transitionClientGate(busy, { type: "forgot.submitted", email: "ana@exemplo.com" }).state).toBe(busy)
  })

  test("success shows the generic confirmation", () => {
    const busy = { ...forgot, busy: true }
    const next = transitionClientGate(busy, { type: "forgot.succeeded" })

    expect(next.state).toEqual({ status: "forgot-sent", googleAvailable: true })
    expect(next.effects).toEqual([])
  })

  test("a network failure keeps the form with the error", () => {
    const busy = { ...forgot, busy: true }
    const next = transitionClientGate(busy, { type: "forgot.failed", error: { tag: "network" } })

    expect(next.state).toEqual({ ...forgot, error: "network" })
  })

  test("cancelling from the form or the confirmation returns to the login", () => {
    const sent: ClientGateState = { status: "forgot-sent", googleAvailable: true }

    expect(transitionClientGate(forgot, { type: "forgot.cancelled" }).state).toEqual(login)
    expect(transitionClientGate(sent, { type: "forgot.cancelled" }).state).toEqual(login)
  })

  test("Google availability settling during recovery is kept for the login", () => {
    const unsettled: ClientGateState = { status: "forgot", googleAvailable: undefined, error: undefined, busy: false }
    const next = transitionClientGate(unsettled, { type: "google.availability.settled", available: true })

    expect(next.state).toEqual({ ...unsettled, googleAvailable: true })
  })
})

describe("client.changed and revalidate", () => {
  test("a change in another window re-checks silently while ready, unless already checking", () => {
    const readyState: ClientGateState = { status: "ready", trialEndsAt: null, apiKeyRenewsAt: "2026-12-01T03:00:00Z" }
    const next = transitionClientGate(readyState, { type: "client.changed" })

    expect(next.state).toEqual({
      status: "ready",
      trialEndsAt: null,
      apiKeyRenewsAt: "2026-12-01T03:00:00Z",
      revalidating: true,
    })
    expect(next.effects).toEqual([{ type: "check-status" }])
    expect(transitionClientGate({ status: "checking" }, { type: "client.changed" }).effects).toEqual([])
  })

  test("revalidation only runs from ready, and stays on the ready screen", () => {
    const readyState: ClientGateState = { status: "ready", trialEndsAt: null, apiKeyRenewsAt: null }
    const next = transitionClientGate(readyState, { type: "revalidate" })

    expect(next.state).toEqual({ status: "ready", trialEndsAt: null, apiKeyRenewsAt: null, revalidating: true })
    expect(next.effects).toEqual([{ type: "check-status" }])

    const login: ClientGateState = { status: "login", googleAvailable: true, error: undefined, busy: false }
    expect(transitionClientGate(login, { type: "revalidate" }).state).toBe(login)
  })

  test("a settled revalidation returns to ready and schedules the next one", () => {
    const revalidating: ClientGateState = { status: "ready", trialEndsAt: null, apiKeyRenewsAt: null, revalidating: true }
    const next = transitionClientGate(revalidating, { type: "status.settled", status: ready })

    expect(next.state).toEqual({ status: "ready", trialEndsAt: null, apiKeyRenewsAt: null })
    expect(next.effects).toEqual([{ type: "schedule-revalidation" }])
  })

  test("a revalidation that finds the session logged out shows the login", () => {
    const revalidating: ClientGateState = { status: "ready", trialEndsAt: null, apiKeyRenewsAt: null, revalidating: true }
    const next = transitionClientGate(revalidating, { type: "status.settled", status: loggedOut })

    expect(next.state).toEqual({ status: "login", googleAvailable: undefined, error: undefined, busy: false })
    expect(next.effects).toEqual([{ type: "check-google" }])
  })

  test("a failed revalidation stays ready and retries at the next revalidation", () => {
    const revalidating: ClientGateState = { status: "ready", trialEndsAt: null, apiKeyRenewsAt: null, revalidating: true }
    const next = transitionClientGate(revalidating, { type: "status.failed" })

    expect(next.state).toEqual({ status: "ready", trialEndsAt: null, apiKeyRenewsAt: null })
    expect(next.effects).toEqual([{ type: "schedule-revalidation" }])
  })
})
