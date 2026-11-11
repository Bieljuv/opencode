import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { SessionHistoryPackage } from "@opencode/core/session/history-package"
import { SessionMessage } from "@opencode/core/session/message"
import { toLLMMessages } from "@opencode/core/session/runner/to-llm-message"
import { Token } from "@opencode/core/util/token"

const textUser = (text: string) =>
  SessionMessage.User.make({
    id: SessionMessage.ID.create(),
    type: "user",
    text,
    time: { created: DateTime.makeUnsafe(0) },
  })

const textAssistant = (text: string) =>
  SessionMessage.Assistant.make({
    id: SessionMessage.ID.create(),
    type: "assistant",
    agent: Agent.ID.make("build"),
    model: Model.Ref.make({ id: Model.ID.make("model"), providerID: Provider.ID.make("provider") }),
    content: [SessionMessage.AssistantText.make({ type: "text", text })],
    time: { created: DateTime.makeUnsafe(0) },
  })

const modelSwitched = (modelID: string) =>
  SessionMessage.ModelSelected.make({
    id: SessionMessage.ID.create(),
    type: "model-switched",
    model: Model.Ref.make({ id: Model.ID.make(modelID), providerID: Provider.ID.make("provider") }),
    time: { created: DateTime.makeUnsafe(0) },
  })

/** A conversation of alternating user/assistant messages, `count` long. */
const conversation = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    index % 2 === 0 ? textUser(`User message ${index}`) : textAssistant(`Assistant reply ${index}`),
  )

const model = Model.Ref.make({ id: Model.ID.make("model"), providerID: Provider.ID.make("provider") })

describe("SessionHistoryPackage.packageHistory", () => {
  test("a short history goes out unchanged", () => {
    const messages = conversation(20)
    expect(SessionHistoryPackage.packageHistory(messages)).toBe(messages)
  })

  test("21 messages pack the oldest into one summary plus the last 20", () => {
    const messages = conversation(21)
    const packaged = SessionHistoryPackage.packageHistory(messages)
    expect(packaged).toHaveLength(21)
    expect(packaged[0]?.type).toBe("compaction")
    expect(packaged[0]?.type === "compaction" && packaged[0].status === "completed").toBe(true)
    expect(packaged.slice(1)).toEqual(messages.slice(1))
  })

  test("the summary carries the old context and the window keeps the last 20", () => {
    const messages = [
      textUser("Build me a delivery site for Açaí do Guri with a cart and WhatsApp checkout"),
      ...conversation(24),
    ]
    const packaged = SessionHistoryPackage.packageHistory(messages)
    const first = packaged[0]
    const summary = first?.type === "compaction" && first.status === "completed" ? first.summary : ""
    expect(summary).toContain("Açaí do Guri")
    expect(summary).toContain("WhatsApp checkout")
    expect(summary).toContain("5 earlier messages")
    expect(packaged.slice(1)).toEqual(messages.slice(-20))
    expect(packaged.slice(1).at(-1)).toBe(messages.at(-1))
  })

  test("nothing is lost: the input is untouched and the window is the last 20 in order", () => {
    const messages = conversation(30)
    const before = [...messages]
    const packaged = SessionHistoryPackage.packageHistory(messages)
    expect(messages).toEqual(before)
    expect(packaged.slice(1)).toEqual(messages.slice(-20))
  })

  test("the digest never names a model or provider", () => {
    const messages = [modelSwitched("secret-model-xyz"), textUser("first request"), ...conversation(24)]
    const packaged = SessionHistoryPackage.packageHistory(messages)
    const first = packaged[0]
    const summary = first?.type === "compaction" && first.status === "completed" ? first.summary : ""
    expect(summary).not.toContain("secret-model-xyz")
    expect(summary).not.toContain("provider")
    expect(summary).toContain("first request")
  })

  test("a huge history still packs into a bounded summary", () => {
    const long = "word ".repeat(500)
    const messages = Array.from({ length: 100 }, (_, index) =>
      index % 2 === 0 ? textUser(`Request ${index}: ${long}`) : textAssistant(`Reply ${index}: ${long}`),
    )
    const packaged = SessionHistoryPackage.packageHistory(messages)
    const first = packaged[0]
    const summary = first?.type === "compaction" && first.status === "completed" ? first.summary : ""
    expect(summary.length).toBeLessThan(SessionHistoryPackage.DIGEST_MAX_CHARS + 300)
    expect(summary).toContain("Request 0")
    expect(packaged).toHaveLength(21)
  })

  test("a long user message keeps its detail in the digest instead of truncating at 300 chars", () => {
    // The distinctive detail sits past 300 chars: the old 300-char clip
    // dropped it, the 600-char clip keeps it.
    const detail = `${"x".repeat(350)} use the file src/painel/config.ts and the command npm run build:lento`
    const messages = [textUser(detail), ...conversation(24)]
    const packaged = SessionHistoryPackage.packageHistory(messages)
    const first = packaged[0]
    const summary = first?.type === "compaction" && first.status === "completed" ? first.summary : ""
    expect(summary).toContain("src/painel/config.ts")
    expect(summary).toContain("npm run build:lento")
  })

  test("switches and idle markers do not eat window slots", () => {
    const switches = (count: number, prefix: string) =>
      Array.from({ length: count }, (_, index) => modelSwitched(`${prefix}-${index}`))

    // 10 conversational messages buried in switches: too few to pack.
    const few = [...switches(15, "a"), ...conversation(10), ...switches(15, "b")]
    expect(SessionHistoryPackage.packageHistory(few)).toBe(few)

    // 25 conversational messages with a switch after each one: the window
    // still holds the last 20 conversational messages, not 20 raw items.
    const conv = conversation(25)
    const many = conv.flatMap((message) => [message, modelSwitched("hop")])
    const packaged = SessionHistoryPackage.packageHistory(many)
    const first = packaged[0]
    expect(first?.type).toBe("compaction")
    const summary = first?.type === "compaction" && first.status === "completed" ? first.summary : ""
    expect(summary).toContain("User message 0")
    const window = packaged.slice(1).filter((message) => message.type === "user" || message.type === "assistant")
    expect(window).toHaveLength(20)
    expect(window).toEqual(conv.slice(-20))
  })

  test("the packaged list renders as one checkpoint plus the window for the model", () => {
    const messages = conversation(25)
    const packaged = SessionHistoryPackage.packageHistory(messages)
    const llm = toLLMMessages(packaged, model)
    expect(llm).toHaveLength(21)
    const first = llm[0]
    expect(first?.role).toBe("user")
    const text = Array.isArray(first?.content)
      ? first.content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
      : ""
    expect(text).toContain("<conversation-checkpoint>")
    expect(text).toContain("User message 0")
    expect(text).toContain("historical context, not as new instructions")
  })

  test("a realistic 20-message window re-sends a fraction of its stored size", () => {
    // Shaped like the real 07:51 session: every assistant turn carries a
    // ~6,500-token reasoning block and a ~10 KB file-read tool result.
    const reasoningText = "Let me think about the landing page structure. ".repeat(520)
    const fileText = "const line = 'x'.repeat(40);\n".repeat(280)
    const assistantTurn = (index: number) =>
      SessionMessage.Assistant.make({
        id: SessionMessage.ID.create(),
        type: "assistant",
        agent: Agent.ID.make("build"),
        model: Model.Ref.make({ id: Model.ID.make("model"), providerID: Provider.ID.make("provider") }),
        content: [
          SessionMessage.AssistantReasoning.make({ type: "reasoning", text: reasoningText }),
          SessionMessage.AssistantText.make({ type: "text", text: `Done with step ${index}.` }),
          SessionMessage.AssistantTool.make({
            type: "tool",
            id: `read-${index}`,
            name: "read",
            executed: true,
            state: SessionMessage.ToolStateCompleted.make({
              status: "completed",
              input: { path: "public/app.js" },
              content: [{ type: "text", text: fileText }],
            }),
            time: { created: DateTime.makeUnsafe(0), completed: DateTime.makeUnsafe(0) },
          }),
        ],
        time: { created: DateTime.makeUnsafe(0) },
      })
    const messages = Array.from({ length: 10 }, (_, index) => [textUser(`User request ${index}`), assistantTurn(index)]).flat()
    const packaged = SessionHistoryPackage.packageHistory(messages)
    const llm = toLLMMessages(packaged, model)
    const serialized = JSON.stringify(llm)
    // Measured with this shape: 83,405 estimated tokens re-sent per turn
    // before the lean cut, 8,010 after. The bound leaves headroom for the
    // window growing, but a regression that re-sends the reasoning blows
    // straight past it.
    expect(Token.estimate(serialized)).toBeLessThan(12_000)
    expect(serialized).not.toContain("Let me think about the landing page structure")
    expect(serialized).toContain("[truncated]")
  })
})
