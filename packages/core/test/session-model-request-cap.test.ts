import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import type { Message } from "@opencode/ai/effect"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { SessionHistoryPackage } from "@opencode/core/session/history-package"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { toLLMMessages } from "@opencode/core/session/runner/to-llm-message"

const created = DateTime.makeUnsafe(0)
const model = Model.Ref.make({ id: Model.ID.make("model"), providerID: Provider.ID.make("provider") })

const textUser = (text: string) =>
  SessionMessage.User.make({
    id: SessionMessage.ID.create(),
    type: "user",
    text,
    time: { created },
  })

const toolCall = (id: string, name = "edit") =>
  SessionMessage.AssistantTool.make({
    type: "tool",
    id,
    name,
    state: SessionMessage.ToolStateCompleted.make({
      status: "completed",
      input: { path: "src/styles.css" },
      content: [{ type: "text", text: "ok" }],
    }),
    time: { created, completed: created },
  })

const textAssistantWithTools = (n: number, tools: number) =>
  SessionMessage.Assistant.make({
    id: SessionMessage.ID.create(),
    type: "assistant",
    agent: Agent.ID.make("build"),
    model,
    content: [
      SessionMessage.AssistantText.make({ type: "text", text: `Vou ajustar o responsivo (${n})` }),
      ...Array.from({ length: tools }, (_, i) => toolCall(`tool-${n}-${i}`)),
    ],
    time: { created, completed: created },
  })

/** Entries the provider's OpenAI-compatible array would hold: one system
 * message plus one entry per LLM message — a tool message counts once per
 * result part, the way the protocol lowers it. */
const openaiCount = (llm: ReadonlyArray<Message>) =>
  1 + llm.reduce((n, m) => n + (m.role === "tool" ? m.content.length : 1), 0)

/** Every tool result in the array still has its call before it, and every
 * call still has its result after it — the cap never splits a pair. */
const pairingIntact = (llm: ReadonlyArray<Message>) => {
  const calls = new Set<string>()
  const results = new Set<string>()
  for (const message of llm) {
    if (message.role === "assistant") {
      for (const part of message.content) if (part.type === "tool-call") calls.add(part.id)
    }
    if (message.role === "tool") {
      for (const part of message.content) results.add(part.id)
    }
  }
  return (
    [...results].every((id) => calls.has(id)) &&
    [...calls].every((id) => results.has(id)) &&
    llm[0]?.role !== "tool"
  )
}

/** The Greeting turn that died on the gateway: 109 session messages, the
 * window's assistants carrying 4 tool calls each. */
const greetingLike = () => {
  const messages: SessionMessage.Info[] = []
  for (let i = 0; i < 89; i++)
    messages.push(i % 2 === 0 ? textUser(`Pedido antigo ${i}`) : textAssistantWithTools(i, 1))
  for (let i = 0; i < 10; i++) {
    messages.push(textUser(`Deixa responsivo ${i}`))
    messages.push(textAssistantWithTools(100 + i, 4))
  }
  return messages
}

describe("SessionModelRequest.capRequestMessages", () => {
  test("a short request goes out unchanged", () => {
    const llm = toLLMMessages(SessionHistoryPackage.packageHistory(greetingLike().slice(0, 10)), model)
    expect(SessionModelRequest.capRequestMessages(llm, 1)).toBe(llm)
  })

  test("the Greeting turn packs 62 provider entries and caps at 50", () => {
    const llm = toLLMMessages(SessionHistoryPackage.packageHistory(greetingLike()), model)
    expect(llm).toHaveLength(61)
    expect(openaiCount(llm)).toBe(62)
    const capped = SessionModelRequest.capRequestMessages(llm, 1)
    expect(openaiCount(capped)).toBeLessThanOrEqual(50)
    // The condensed summary stays first and the newest message stays last.
    expect(capped[0]).toBe(llm[0])
    expect(capped.at(-1)).toBe(llm.at(-1))
    expect(pairingIntact(capped)).toBe(true)
  })

  test("the cut never lands before a tool message", () => {
    const llm = toLLMMessages(SessionHistoryPackage.packageHistory(greetingLike()), model)
    const capped = SessionModelRequest.capRequestMessages(llm, 1)
    expect(capped[0]?.role).not.toBe("tool")
    expect(pairingIntact(capped)).toBe(true)
  })

  test("without a system message the budget is the full 50", () => {
    const llm = toLLMMessages(SessionHistoryPackage.packageHistory(greetingLike()), model)
    const capped = SessionModelRequest.capRequestMessages(llm, 0)
    // 49, not 50: the cut lands on a tool message and steps past the
    // orphaned results — the pairing matters more than filling the slot.
    expect(capped).toHaveLength(49)
    expect(pairingIntact(capped)).toBe(true)
  })

  test("a text-less tool-call assistant keeps its call and its results", () => {
    const bare = SessionMessage.Assistant.make({
      id: SessionMessage.ID.create(),
      type: "assistant",
      agent: Agent.ID.make("build"),
      model,
      content: [toolCall("bare-1", "read"), toolCall("bare-2", "read")],
      time: { created, completed: created },
    })
    const llm = toLLMMessages(
      SessionHistoryPackage.packageHistory([...greetingLike(), textUser("só lê os arquivos"), bare]),
      model,
    )
    const capped = SessionModelRequest.capRequestMessages(llm, 1)
    expect(pairingIntact(capped)).toBe(true)
    expect(openaiCount(capped)).toBeLessThanOrEqual(50)
  })
})
