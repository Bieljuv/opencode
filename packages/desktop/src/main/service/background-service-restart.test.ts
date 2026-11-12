import { describe, expect, test } from "bun:test"
import { requestBackgroundServiceRestart, setBackgroundServiceRestarter } from "./background-service-restart"

// The restart bridge is the only path from the plain client login to the
// Effect service machine. The runner is module state, so the no-op test
// must stay first: once a runner is registered there is no unregister.
describe("background service restart bridge", () => {
  test("a request without a registered runner does nothing", () => {
    expect(() => requestBackgroundServiceRestart()).not.toThrow()
  })

  test("a request calls the registered runner once per request", () => {
    let calls = 0
    setBackgroundServiceRestarter(() => {
      calls += 1
    })

    requestBackgroundServiceRestart()
    requestBackgroundServiceRestart()

    expect(calls).toBe(2)
  })

  test("registering again replaces the runner", () => {
    let first = 0
    let second = 0
    setBackgroundServiceRestarter(() => {
      first += 1
    })
    setBackgroundServiceRestarter(() => {
      second += 1
    })

    requestBackgroundServiceRestart()

    expect(first).toBe(0)
    expect(second).toBe(1)
  })
})
