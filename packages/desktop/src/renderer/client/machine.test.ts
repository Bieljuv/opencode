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

    expect(next.state).toEqual({ status: "ready", trialEndsAt: null })
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

  test("starting Google waits for the browser return", () => {
    const submitted = transitionClientGate(login, { type: "google.submitted" })

    expect(submitted.state).toEqual({ ...login, busy: true })
    expect(submitted.effects).toEqual([{ type: "do-google-start" }])

    const started = transitionClientGate(submitted.state, { type: "google.started" })

    expect(started.state).toEqual({ status: "waiting-google", googleAvailable: true })
  })

  test("cancelling the wait returns to the login", () => {
    const next = transitionClientGate(
      { status: "waiting-google", googleAvailable: true },
      { type: "google.cancelled" },
    )

    expect(next.state).toEqual({ status: "login", googleAvailable: true, error: undefined, busy: false })
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
})

describe("client.changed and revalidate", () => {
  test("a change in another window re-checks, unless already checking", () => {
    const readyState: ClientGateState = { status: "ready", trialEndsAt: null }
    const next = transitionClientGate(readyState, { type: "client.changed" })

    expect(next.state).toEqual({ status: "checking" })
    expect(next.effects).toEqual([{ type: "check-status" }])
    expect(transitionClientGate({ status: "checking" }, { type: "client.changed" }).effects).toEqual([])
  })

  test("revalidation only runs from ready", () => {
    const readyState: ClientGateState = { status: "ready", trialEndsAt: null }
    const next = transitionClientGate(readyState, { type: "revalidate" })

    expect(next.state).toEqual({ status: "checking" })

    const login: ClientGateState = { status: "login", googleAvailable: true, error: undefined, busy: false }
    expect(transitionClientGate(login, { type: "revalidate" }).state).toBe(login)
  })
})
