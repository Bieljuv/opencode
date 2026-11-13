import { describe, expect, test } from "bun:test"
import { ClaudeQueryOptions } from "@opencode/core/plugin/provider/claude-agent/claude/query-options"
import { PendingTools } from "@opencode/core/plugin/provider/claude-agent/tools/pending"
import { FakeClaude } from "../lib/fake-claude"
import { FakeIO } from "../lib/fake-io"

describe("autoCompactWindowFor", () => {
  const cases: Array<[number | undefined, number]> = [
    [undefined, 500_000],
    [600_000, 500_000],
    [1_000_000, 500_000],
    [200_000, 170_000],
    [128_000, 108_800],
    [100_000, 100_000],
    [0, 500_000],
    [-5, 500_000],
    [Number.NaN, 500_000],
  ]
  test.each(cases)("context window %s compacts at %s tokens", (contextWindow, expected) => {
    expect(ClaudeQueryOptions.autoCompactWindowFor(contextWindow)).toBe(expected)
  })
})

describe("ClaudeQueryOptions.session", () => {
  const optionsFor = (contextWindow?: number) =>
    ClaudeQueryOptions.session({
      executable: FakeIO.EXECUTABLE,
      io: FakeIO.make({ claude: FakeClaude.make([]) }),
      directory: "/tmp/fake-project",
      model: "claude-fable-5",
      contextWindow,
      system: "test",
      tools: [],
      pending: PendingTools.make(),
      persist: false,
    })

  test("applies the 500k auto-compact window and enables auto-compact", async () => {
    const options = await optionsFor(600_000)
    expect(options.settings).toMatchObject({
      disableAllHooks: true,
      autoCompactEnabled: true,
      autoCompactWindow: 500_000,
    })
  })

  test("clamps the window to 85% of a small model window", async () => {
    const options = await optionsFor(200_000)
    expect(options.settings).toMatchObject({ autoCompactWindow: 170_000 })
  })

  test("takes the 500k default when the window is unknown", async () => {
    const options = await optionsFor()
    expect(options.settings).toMatchObject({ autoCompactWindow: 500_000 })
  })

  test("no longer disables auto-compact in the spawn env", async () => {
    const options = await optionsFor(600_000)
    expect(options.env?.DISABLE_AUTO_COMPACT).toBeUndefined()
    const base = ClaudeQueryOptions.base({
      executable: FakeIO.EXECUTABLE,
      io: FakeIO.make({ claude: FakeClaude.make([]) }),
    })
    expect(base.env?.DISABLE_AUTO_COMPACT).toBeUndefined()
  })
})
