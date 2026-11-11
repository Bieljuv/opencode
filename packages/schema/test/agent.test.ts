import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Agent } from "../src/agent.js"

test("Agent.Color preserves configured colors at the public boundary", () => {
  const encode = Schema.encodeSync(Agent.Color)

  expect(encode("info")).toBe("info")
  expect(encode("custom-color")).toBe("custom-color")
})

test("Agent.Info.default caps steps per turn (audit C-04)", () => {
  expect(Agent.DEFAULT_MAX_STEPS).toBe(50)
  expect(Agent.Info.default(Agent.ID.make("build")).steps).toBe(Agent.DEFAULT_MAX_STEPS)
})
