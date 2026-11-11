import { describe, expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { resolveStepLimit } from "@opencode/core/session/runner/max-steps"

describe("resolveStepLimit", () => {
  test("an agent without an explicit cap gets the shared default", () => {
    expect(Agent.DEFAULT_MAX_STEPS).toBe(50)
    expect(resolveStepLimit({})).toBe(50)
    expect(resolveStepLimit({ steps: undefined })).toBe(50)
  })

  test("an explicit cap wins over the default", () => {
    expect(resolveStepLimit({ steps: 10 })).toBe(10)
    expect(resolveStepLimit({ steps: 200 })).toBe(200)
  })

  test("the schema default agent carries the cap", () => {
    expect(Agent.Info.default(Agent.ID.make("build")).steps).toBe(50)
  })
})
