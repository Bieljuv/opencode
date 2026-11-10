import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionMessage } from "@opencode/core/session/message"
import { toLLMMessages } from "@opencode/core/session/runner/to-llm-message"
import { Model } from "@opencode/schema/model"

const ref = Model.Ref.parse("test/test-model")

const assistantWithTool = (tool: unknown) =>
  Schema.decodeUnknownSync(SessionMessage.Info)({
    id: "msg_test1",
    type: "assistant",
    agent: "build",
    model: { providerID: "test", id: "test-model" },
    content: [tool],
    time: { created: 1 },
  })

const errorTool = (message: string) => ({
  type: "tool",
  id: "call_1",
  name: "bash",
  executed: true,
  state: { status: "error", input: {}, error: { type: "tool.execution", message } },
  time: { created: 1 },
})

const completedTool = (text: string) => ({
  type: "tool",
  id: "call_1",
  name: "bash",
  executed: true,
  state: { status: "completed", input: {}, content: [{ type: "text", text }] },
  time: { created: 1 },
})

describe("toLLMMessages tool errors", () => {
  test("masks a provider-flavored stored tool error before the model sees it", () => {
    // A session recorded before the origin fix can still carry a provider
    // refusal in the stored error; without the mask the model would
    // parrot it into visible prose on the next turn.
    for (const message of [
      "User not found",
      "OpenRouter via ponte do OpenCode quebrou (401)",
      "cota grátis estourou",
    ]) {
      const shown = JSON.stringify(toLLMMessages([assistantWithTool(errorTool(message))], ref))
      expect(shown).toContain("Tente novamente mais tarde.")
      expect(shown).not.toContain(message)
    }
  })

  test("keeps a local stored tool error verbatim", () => {
    const shown = JSON.stringify(
      toLLMMessages([assistantWithTool(errorTool("ENOENT: no such file or directory"))], ref),
    )
    expect(shown).toContain("ENOENT: no such file or directory")
    expect(shown).not.toContain("Tente novamente mais tarde.")
  })

  test("keeps a completed tool's output verbatim", () => {
    // Success output is the agent's working material for debugging: the
    // model must see the actual provider words there, and only the
    // display net keeps them out of the pixels.
    const shown = JSON.stringify(
      toLLMMessages([assistantWithTool(completedTool("OpenRouter returned 401: User not found"))], ref),
    )
    expect(shown).toContain("OpenRouter returned 401: User not found")
  })
})
