import { describe, expect, test } from "bun:test"
import type { SessionInfo, SessionMessageAssistant } from "@opencode/client/promise"
import { createRoot } from "solid-js"
import { createSessionBackground, latestSubagentActivity } from "./background"

const assistant = (content: SessionMessageAssistant["content"], id = "msg_1") =>
  ({
    id,
    type: "assistant",
    agent: "build",
    model: { id: "model", providerID: "provider" },
    content,
    time: { created: 1 },
  }) satisfies SessionMessageAssistant

const toolPart = (name: string, state: Record<string, unknown>) =>
  ({
    type: "tool",
    id: `tool_${name}`,
    name,
    state,
    time: { created: 2 },
  }) as SessionMessageAssistant["content"][number]

describe("latestSubagentActivity", () => {
  test("a tool call reads as its name plus the file it works on", () => {
    expect(
      latestSubagentActivity([
        assistant([toolPart("read", { status: "running", input: { filePath: "src/example.ts" }, metadata: {} })]),
      ]),
    ).toBe("read src/example.ts")
  })

  test("a shell call reads as its name plus the command", () => {
    expect(
      latestSubagentActivity([
        assistant([toolPart("bash", { status: "running", input: { command: "npm test" }, metadata: {} })]),
      ]),
    ).toBe("bash npm test")
  })

  test("a streaming call reads as the tool name alone, its input still partial text", () => {
    expect(
      latestSubagentActivity([
        assistant([toolPart("read", { status: "streaming", input: '{"filePath": "src/ex' })]),
      ]),
    ).toBe("read")
  })

  test("a wrong-typed hint field is skipped for the next one", () => {
    expect(
      latestSubagentActivity([
        assistant([
          toolPart("read", { status: "running", input: { filePath: 42, command: "cat x" }, metadata: {} }),
        ]),
      ]),
    ).toBe("read cat x")
  })

  test("a call with no usable hint reads as the tool name alone", () => {
    expect(
      latestSubagentActivity([
        assistant([toolPart("glob", { status: "running", input: {}, metadata: {} })]),
      ]),
    ).toBe("glob")
  })

  test("text reads as its first line only", () => {
    expect(
      latestSubagentActivity([
        assistant([{ type: "text", text: "Vou ler o arquivo principal.\nDepois edito o resto." }]),
      ]),
    ).toBe("Vou ler o arquivo principal.")
  })

  test("blank text falls through to the earlier tool call", () => {
    expect(
      latestSubagentActivity([
        assistant([
          toolPart("edit", { status: "completed", input: { filePath: "src/a.ts" }, content: [], metadata: {} }),
          { type: "text", text: "   " },
        ]),
      ]),
    ).toBe("edit src/a.ts")
  })

  test("reasoning alone is not activity", () => {
    expect(
      latestSubagentActivity([assistant([{ type: "reasoning", text: "thinking" }])]),
    ).toBeUndefined()
  })

  test("no assistant message means no activity", () => {
    expect(
      latestSubagentActivity([{ id: "msg_0", type: "user", text: "oi", time: { created: 0 } }]),
    ).toBeUndefined()
    expect(latestSubagentActivity([])).toBeUndefined()
  })
})

describe("createSessionBackground subagents", () => {
  const session = (id: string, parentID?: string) =>
    ({
      id,
      parentID,
      projectID: "proj_1",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 2 },
      title: id === "ses_parent" ? "Parent" : "Revisar o PDV",
      location: { directory: "/tmp" },
    }) satisfies SessionInfo

  test("a running child carries its current activity into the live list", () => {
    createRoot((dispose) => {
      const background = createSessionBackground({
        sessionID: () => "ses_parent",
        messages: (id) =>
          id === "ses_child"
            ? [
                assistant([
                  toolPart("read", { status: "running", input: { filePath: "src/pdv.ts" }, metadata: {} }),
                ]),
              ]
            : [
                assistant([
                  toolPart("subagent", {
                    status: "running",
                    input: { description: "Revisar o PDV", agent: "explore" },
                    metadata: { sessionID: "ses_child" },
                  }),
                ]),
              ],
        sessions: () => [session("ses_parent"), session("ses_child", "ses_parent")],
        status: (id) => (id === "ses_child" ? "running" : "running"),
        shells: () => [],
      })

      const subagents = background.subagents()
      expect(subagents).toHaveLength(1)
      expect(subagents[0]?.label).toBe("Revisar o PDV")
      expect(subagents[0]?.agent).toBe("explore")
      expect(subagents[0]?.activity).toBe("read src/pdv.ts")
      dispose()
    })
  })

  test("a running child with no messages yet has no activity", () => {
    createRoot((dispose) => {
      const background = createSessionBackground({
        sessionID: () => "ses_parent",
        messages: (id) =>
          id === "ses_child"
            ? []
            : [
                assistant([
                  toolPart("subagent", {
                    status: "running",
                    input: { description: "Revisar o PDV", agent: "explore" },
                    metadata: { sessionID: "ses_child" },
                  }),
                ]),
              ],
        sessions: () => [session("ses_parent"), session("ses_child", "ses_parent")],
        status: () => "running",
        shells: () => [],
      })

      expect(background.subagents()).toHaveLength(1)
      expect(background.subagents()[0]?.activity).toBeUndefined()
      dispose()
    })
  })
})
