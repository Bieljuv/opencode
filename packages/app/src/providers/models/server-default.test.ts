import { expect, test } from "bun:test"
import { resolveFallbackModel } from "./server-default"

const provider = (id: string, ...modelIDs: string[]) => ({
  id,
  models: Object.fromEntries(modelIDs.map((modelID) => [modelID, { id: modelID }])),
})

test("returns the server default when it names a connected model", () => {
  expect(
    resolveFallbackModel({ providerID: "manostech", modelID: "auto" }, [
      provider("opencode", "big-pickle"),
      provider("manostech", "auto"),
    ]),
  ).toEqual({ providerID: "manostech", modelID: "auto" })
})

test("falls back to the first model of the first connected provider without a server default", () => {
  expect(resolveFallbackModel(undefined, [provider("opencode", "big-pickle"), provider("manostech", "auto")])).toEqual(
    { providerID: "opencode", modelID: "big-pickle" },
  )
})

test("ignores a server default for a disconnected provider", () => {
  expect(
    resolveFallbackModel({ providerID: "manostech", modelID: "auto" }, [provider("opencode", "big-pickle")]),
  ).toEqual({ providerID: "opencode", modelID: "big-pickle" })
})

test("ignores a server default for an unknown model of a connected provider", () => {
  expect(
    resolveFallbackModel({ providerID: "opencode", modelID: "missing" }, [provider("opencode", "big-pickle")]),
  ).toEqual({ providerID: "opencode", modelID: "big-pickle" })
})

test("skips connected providers without models", () => {
  expect(
    resolveFallbackModel(undefined, [provider("empty"), provider("opencode", "big-pickle")]),
  ).toEqual({ providerID: "opencode", modelID: "big-pickle" })
})

test("returns undefined with no connected providers", () => {
  expect(resolveFallbackModel({ providerID: "manostech", modelID: "auto" }, [])).toEqual(undefined)
})
