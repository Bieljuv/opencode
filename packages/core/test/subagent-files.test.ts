import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { SessionMessage } from "@opencode/schema/session-message"
import { overlappingFiles, writtenFiles } from "@opencode/core/session/subagent-files"

const at = DateTime.makeUnsafe(0)

const toolPart = (
  name: string,
  path: string,
  status: "completed" | "running" | "error" = "completed",
): SessionMessage.AssistantContent => ({
  type: "tool",
  id: `call_${name}_${path}`,
  name,
  state:
    status === "completed"
      ? { status: "completed", input: { path }, content: [{ type: "text", text: "ok" }] }
      : status === "running"
        ? { status: "running", input: { path }, metadata: {} }
        : {
            status: "error",
            input: { path },
            error: { type: "aborted", message: "failed" },
          },
  time: { created: at },
})

const assistantMessage = (parts: SessionMessage.AssistantContent[]): SessionMessage.Info =>
  SessionMessage.Assistant.make({
    id: SessionMessage.ID.create(),
    type: "assistant",
    agent: Agent.ID.make("builder"),
    model: Model.Ref.make({ id: Model.ID.make("model"), providerID: Provider.ID.make("test") }),
    content: parts,
    time: { created: at },
  })

const userMessage = (): SessionMessage.Info =>
  SessionMessage.User.make({
    id: SessionMessage.ID.create(),
    type: "user",
    text: "crie um sistema",
    time: { created: at },
  })

describe("SubagentFiles.writtenFiles", () => {
  test("collects finished writes and edits, sorted and deduplicated", () => {
    const messages = [
      assistantMessage([toolPart("write", "sobre.html"), toolPart("edit", "index.html")]),
      assistantMessage([toolPart("write", "index.html")]),
    ]

    expect(writtenFiles(messages)).toEqual(["index.html", "sobre.html"])
  })

  test("ignores running and failed calls, other tools, and user messages", () => {
    const messages = [
      userMessage(),
      assistantMessage([
        toolPart("write", "index.html", "running"),
        toolPart("write", "rascunho.html", "error"),
        toolPart("read", "index.html"),
      ]),
    ]

    expect(writtenFiles(messages)).toEqual([])
  })

  test("ignores a write without a path", () => {
    const messages = [assistantMessage([toolPart("write", "index.html"), toolPart("edit", "")])]

    expect(writtenFiles(messages)).toEqual(["index.html"])
  })
})

describe("SubagentFiles.overlappingFiles", () => {
  test("reports only the files another subagent also wrote", () => {
    expect(overlappingFiles(["a.html", "b.html", "c.html"], [["b.html"], ["d.html", "c.html"]])).toEqual([
      "b.html",
      "c.html",
    ])
  })

  test("reports nothing when no sibling wrote the same file", () => {
    expect(overlappingFiles(["a.html"], [["b.html"]])).toEqual([])
    expect(overlappingFiles(["a.html"], [])).toEqual([])
  })
})
