import { describe, expect, test } from "bun:test"
import { Message, ToolMessage, ToolResultPart, Media, UserMessage } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import {
  APPROVAL_BEFORE_BUILD,
  ARENA_AUTO,
  baseTranscript,
  boundImages,
  DELIVERY_RULES,
  DIRECT_REPLY,
  FAILED_TOOL_RETRY,
  HIDE_MODEL_IDENTITY,
  MANDATORY_TOKEN_SAVING,
  MULTI_AGENT,
  unsupportedParts,
} from "@opencode/core/session/model-request"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { DateTime, Effect } from "effect"

const capabilities = (input: string[]) => ({ tools: true, input, output: ["text"] })

describe("SessionModelRequest.unsupportedParts", () => {
  test("replaces unsupported user media with a visible error", () => {
    const messages = unsupportedParts(
      [
        Message.user([
          Message.text("Describe these files"),
          { type: "media", media: Media.base64("aGVsbG8=", "image/png"), filename: "logo.png" },
          { type: "media", media: Media.base64("JVBERg==", "application/pdf"), filename: "document.pdf" },
        ]),
      ],
      capabilities(["text"]),
    )

    expect(messages[0]?.content).toEqual([
      Message.text("Describe these files"),
      Message.text('ERROR: Cannot read "logo.png" (this model does not support image input). Inform the user.'),
      Message.text('ERROR: Cannot read "document.pdf" (this model does not support pdf input). Inform the user.'),
    ])
  })

  test("replaces unsupported media nested in tool results", () => {
    const messages = unsupportedParts(
      [
        Message.tool(
          ToolResultPart.make({
            id: "call_1",
            name: "read",
            result: {
              type: "content",
              value: [
                { type: "text", text: "Image read successfully" },
                { type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "logo.png" },
              ],
            },
          }),
        ),
      ],
      capabilities(["text"]),
    )

    expect(messages[0]?.content[0]).toMatchObject({
      type: "tool-result",
      result: {
        type: "content",
        value: [
          { type: "text", text: "Image read successfully" },
          {
            type: "text",
            text: 'ERROR: Cannot read "logo.png" (this model does not support image input). Inform the user.',
          },
        ],
      },
    })
  })

  test("replaces images xAI cannot decode and keeps png, jpeg and webp", () => {
    const image = (mime: string, name: string) => ({
      type: "media" as const,
      media: Media.base64("aGVsbG8=", mime),
      filename: name,
    })
    const user = [image("image/png", "a.png"), image("image/jpeg", "b.jpg"), image("image/webp", "c.webp")]
    const messages = [
      Message.user([...user, image("image/gif", "d.gif")]),
      Message.tool(
        ToolResultPart.make({
          id: "call_1",
          name: "read",
          result: {
            type: "content",
            value: [
              { type: "text", text: "Image read successfully" },
              { type: "file", uri: "data:image/gif;base64,R0lGODlh", mime: "image/gif", name: "e.gif" },
            ],
          },
        }),
      ),
    ]
    const result = unsupportedParts(messages, capabilities(["text", "image"]), "xai")

    expect(result[0]?.content).toEqual([
      ...user,
      Message.text('ERROR: Cannot read "d.gif" (this model does not support image/gif input). Inform the user.'),
    ])
    expect(result[1]?.content[0]).toMatchObject({
      type: "tool-result",
      result: {
        type: "content",
        value: [
          { type: "text", text: "Image read successfully" },
          {
            type: "text",
            text: 'ERROR: Cannot read "e.gif" (this model does not support image/gif input). Inform the user.',
          },
        ],
      },
    })
    expect(unsupportedParts(messages, capabilities(["text", "image"]), "openai")).toEqual(messages)
  })

  test("preserves supported media", () => {
    const message = Message.user({ type: "media", media: Media.base64("aGVsbG8=", "image/png") })
    expect(unsupportedParts([message], capabilities(["text", "image"]))[0]?.content).toEqual(message.content)
  })

  test("returns the same messages when nothing is unsupported", () => {
    const messages = [
      Message.user([Message.text("hi"), { type: "media", media: Media.base64("aGVsbG8=", "image/png") }]),
      Message.assistant("hello"),
      Message.tool(
        ToolResultPart.make({
          id: "call_1",
          name: "read",
          result: {
            type: "content",
            value: [{ type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "logo.png" }],
          },
        }),
      ),
    ]
    const result = unsupportedParts(messages, capabilities(["text", "image"]))
    expect(result).toHaveLength(messages.length)
    result.forEach((message, index) => expect(message).toBe(messages[index]))
  })

  test("rebuilds only messages with unsupported media", () => {
    const text = Message.user("plain")
    const supported = Message.tool(
      ToolResultPart.make({
        id: "call_1",
        name: "read",
        result: { type: "content", value: [{ type: "text", text: "no files" }] },
      }),
    )
    const tool = ToolResultPart.make({
      id: "call_2",
      name: "read",
      result: {
        type: "content",
        value: [
          { type: "text", text: "Read" },
          { type: "file", uri: "data:application/pdf;base64,JVBERg==", mime: "application/pdf" },
        ],
      },
    })
    const untouched = ToolResultPart.make({ id: "call_3", name: "read", result: "done" })
    const unsupported = Message.make({ role: "tool", content: [tool, untouched] })
    const result = unsupportedParts([text, supported, unsupported], capabilities(["text"]))

    expect(result[0]).toBe(text)
    expect(result[1]).toBe(supported)
    expect(result[2]).not.toBe(unsupported)
    expect(result[2]).toBeInstanceOf(ToolMessage)
    expect(result[2]?.content[1]).toEqual(untouched)
    expect(result[2]?.content[0]).toMatchObject({
      type: "tool-result",
      result: {
        type: "content",
        value: [
          { type: "text", text: "Read" },
          { type: "text", text: "ERROR: Cannot read pdf (this model does not support pdf input). Inform the user." },
        ],
      },
    })
    expect(tool.result).toMatchObject({
      type: "content",
      value: [
        { type: "text", text: "Read" },
        { type: "file", mime: "application/pdf" },
      ],
    })
  })
})

describe("SessionModelRequest.boundImages", () => {
  test("preserves images below the trigger", () => {
    const messages = [Message.user({ type: "media", media: Media.base64("aGVsbG8=", "image/png") })]
    expect(boundImages(messages)).toBe(messages)
  })

  test("replaces oldest images until the retained payload reaches the target", () => {
    const image = "a".repeat(9 * 1024 * 1024)
    const text = Message.user("plain")
    const third = Message.user({ type: "media", media: Media.base64(image, "image/png"), filename: "third.png" })
    const messages = [
      Message.user({ type: "media", media: Media.base64(image, "image/png"), filename: "first.png" }),
      text,
      Message.user({ type: "media", media: Media.base64(image, "image/png"), filename: "second.png" }),
      third,
    ]
    const result = boundImages(messages)

    expect(result[0]).toBeInstanceOf(UserMessage)
    expect(result[0]?.content).toEqual([Message.text(expect.stringContaining("image was removed"))])
    expect(result[1]).toBe(text)
    expect(result[2]).not.toBe(messages[2])
    expect(result[2]?.content[0]).toMatchObject({ type: "text" })
    expect(result[3]).toBe(third)
  })

  test("keeps the replaced prefix stable as new images arrive, so the prompt cache survives", () => {
    const image = (name: string) =>
      Message.user({ type: "media", media: Media.base64("a".repeat(3 * 1024 * 1024), "image/png"), filename: name })
    const removed = (messages: ReturnType<typeof boundImages>) =>
      messages.filter((message) => message.content[0]?.type === "text").length
    const history = Array.from({ length: 9 }, (_, i) => image(`${i}.png`))

    // 27 MiB passes the 25 MiB trigger: the oldest four go, leaving 15 MiB.
    expect(removed(boundImages(history))).toBe(4)
    // Each later image used to move the cut by one; now the cut holds until the kept payload passes the trigger again.
    expect(removed(boundImages([...history, image("9.png")]))).toBe(4)
    expect(removed(boundImages([...history, image("9.png"), image("10.png"), image("11.png")]))).toBe(4)
    expect(removed(boundImages([...history, ...Array.from({ length: 4 }, (_, i) => image(`${9 + i}.png`))]))).toBe(8)
  })

  test("replaces images nested in tool results", () => {
    const image = "a".repeat(13 * 1024 * 1024)
    const result = boundImages([
      Message.tool(
        ToolResultPart.make({
          id: "call_1",
          name: "read",
          result: {
            type: "content",
            value: [
              { type: "file", uri: `data:image/png;base64,${image}`, mime: "image/png", name: "first.png" },
              { type: "file", uri: `data:image/png;base64,${image}`, mime: "image/png", name: "second.png" },
            ],
          },
        }),
      ),
    ])

    expect(result[0]?.content[0]).toMatchObject({
      type: "tool-result",
      result: {
        type: "content",
        value: [{ type: "text" }, { type: "file", name: "second.png" }],
      },
    })
  })
})

describe("SessionModelRequest.HIDE_MODEL_IDENTITY", () => {
  test("forbids naming models, providers, tiers, quotas, and routing, and pins the identity reply", () => {
    expect(HIDE_MODEL_IDENTITY).toContain(
      'If the user asks which model or AI is answering, reply exactly: "Desculpa não tenho essa informação, algo mais em que posso ajudar?" and nothing else.',
    )
    for (const topic of [
      "model names or IDs",
      "provider names",
      "free or paid tiers",
      "quotas",
      "limits",
      "credits",
      "message counts",
      "model switching and routing",
      "Never list, count, or name the providers or models available to you",
      "never say how many are free",
      "Never say which providers are alive, slow, or unstable",
      "never talk about budgets or limits per model or in total",
      "call it ManosTech.AI",
      "Never quote provider or tool error text",
    ]) {
      expect(HIDE_MODEL_IDENTITY).toContain(topic)
    }
  })
})

describe("SessionModelRequest.DIRECT_REPLY", () => {
  test("a greeting or unrelated question is not a request to continue the task", () => {
    for (const topic of [
      "not a request to continue that task",
      "answer it directly in chat",
      "and then wait for the user",
      "do not resume the previous task",
      "do not call tools, do not edit files, and do not create a task card",
      "only resumes when the user explicitly asks to continue it",
      '"continue"',
      '"continua"',
      '"pode continuar"',
      "A question about the active task gets a direct chat answer too",
    ]) {
      expect(DIRECT_REPLY).toContain(topic)
    }
    for (const greeting of ['"oi"', '"olá"', '"bom dia"', '"boa tarde"', '"boa noite"']) {
      expect(DIRECT_REPLY).toContain(greeting)
    }
  })
})

describe("SessionModelRequest.FAILED_TOOL_RETRY", () => {
  test("a failed tool call is never repeated identically", () => {
    for (const topic of [
      "never repeat the identical call",
      "including any closest lines it shows",
      "re-read the file first",
      "If the same operation fails a second time, stop and tell the user what went wrong",
    ]) {
      expect(FAILED_TOOL_RETRY).toContain(topic)
    }
  })
})

describe("SessionModelRequest.MULTI_AGENT", () => {
  test("independent fronts run in parallel subagents and join at the end", () => {
    for (const topic of [
      "run each front in its own parallel subagent in the background",
      "Fronts that depend on each other run in order, not in parallel",
      "Give each front a short label of a few words saying what it does",
      "a single small question or a single-file change is done directly, without subagents",
      // The fixed pipeline: explore, then plan, then parallel builders, then review.
      "send the planner subagent first",
      "use the builder subagent for fronts that write files",
      "send the reviewer subagent to check the files the builders changed",
      "Never give two fronts the same files to edit",
    ]) {
      expect(MULTI_AGENT).toContain(topic)
    }
  })
})

describe("SessionModelRequest.baseTranscript direct reply", () => {
  const model = SessionRunnerModel.resolved(OpenAIChat.route.model({ id: "gpt-5.5", provider: "test" }), {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost: [],
    limit: { context: 200_000, output: 32_000 },
  })
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

  test("a greeting after an in-progress task still carries the direct-reply rule", () => {
    const transcript = baseTranscript({
      agent: Agent.Info.default(Agent.ID.make("build")),
      model,
      tools: { definitions: [], execute: () => Effect.die("unused tool execution") },
      initial: [],
      messages: [
        textUser("Troque os sons do chat para Web Audio"),
        textAssistant("Vou trocar os sons do chat para Web Audio."),
        textUser("oi"),
      ],
    })
    const system = transcript.system.map((part) => part.text).join("\n")
    expect(system).toContain("not a request to continue that task")
    expect(system).toContain("never repeat the identical call")
    const last = transcript.messages.at(-1)
    expect(last?.role).toBe("user")
    expect(JSON.stringify(last)).toContain('"oi"')
  })

  test("the multi-agent rule only rides along while the toggle is on", () => {
    const messages = [textUser("Crie o PDV completo")]
    const withToggle = baseTranscript({
      agent: Agent.Info.default(Agent.ID.make("build")),
      model,
      tools: { definitions: [], execute: () => Effect.die("unused tool execution") },
      initial: [],
      messages,
      multiAgent: true,
    })
    expect(withToggle.system.map((part) => part.text).join("\n")).toContain(
      "run each front in its own parallel subagent in the background",
    )
    // The pipeline names real roles with their own subagents: plan first,
    // build in parallel fronts, review before delivering.
    const joined = withToggle.system.map((part) => part.text).join("\n")
    expect(joined).toContain("planner subagent")
    expect(joined).toContain("builder subagent")
    expect(joined).toContain("reviewer subagent")
    const withoutToggle = baseTranscript({
      agent: Agent.Info.default(Agent.ID.make("build")),
      model,
      tools: { definitions: [], execute: () => Effect.die("unused tool execution") },
      initial: [],
      messages,
    })
    expect(withoutToggle.system.map((part) => part.text).join("\n")).not.toContain("parallel subagent")
  })
})

describe("SessionModelRequest.baseTranscript mandatory token saving and arena auto-activation", () => {
  const model = SessionRunnerModel.resolved(OpenAIChat.route.model({ id: "gpt-5.5", provider: "test" }), {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost: [],
    limit: { context: 200_000, output: 32_000 },
  })
  const textUser = (text: string) =>
    SessionMessage.User.make({
      id: SessionMessage.ID.create(),
      type: "user",
      text,
      time: { created: DateTime.makeUnsafe(0) },
    })

  test("a greeting still carries the mandatory rules, so they cannot be skipped", () => {
    const transcript = baseTranscript({
      agent: Agent.Info.default(Agent.ID.make("build")),
      model,
      tools: { definitions: [], execute: () => Effect.die("unused tool execution") },
      initial: [],
      messages: [textUser("oi")],
    })
    const system = transcript.system.map((part) => part.text).join("\n")
    // The rules ride along in full: removing them from baseTranscript, or
    // gutting their text, fails this test.
    expect(system).toContain(MANDATORY_TOKEN_SAVING)
    expect(system).toContain(ARENA_AUTO)
    // Distinctive phrases, so an emptied constant fails too.
    expect(system).toContain("ponytail and graphify skills are not optional")
    expect(system).toContain("graphify-out/graph.json")
    expect(system).toContain("Never ask the user to install anything")
    expect(system).toContain("fall back to normal file reading")
    expect(system).toContain("never create a CLAUDE.md")
    expect(system).toContain("resposta ruim")
    expect(system).toContain("high-stakes decision")
    expect(system).toContain("Never run the tournament for a trivial request")
    expect(system).toContain("offer the tournament and ask")
    expect(system).toContain("tell the user in chat that the tournament is running")
  })

  test("the mandatory rules also ride along on a coding turn", () => {
    const transcript = baseTranscript({
      agent: Agent.Info.default(Agent.ID.make("build")),
      model,
      tools: { definitions: [], execute: () => Effect.die("unused tool execution") },
      initial: [],
      messages: [textUser("Crie o PDV completo")],
    })
    const system = transcript.system.map((part) => part.text).join("\n")
    expect(system).toContain(MANDATORY_TOKEN_SAVING)
    expect(system).toContain(ARENA_AUTO)
  })
})

describe("SessionModelRequest.baseTranscript approval before building and delivery rules", () => {
  const model = SessionRunnerModel.resolved(OpenAIChat.route.model({ id: "gpt-5.5", provider: "test" }), {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost: [],
    limit: { context: 200_000, output: 32_000 },
  })
  const textUser = (text: string) =>
    SessionMessage.User.make({
      id: SessionMessage.ID.create(),
      type: "user",
      text,
      time: { created: DateTime.makeUnsafe(0) },
    })

  test("a greeting still carries the approval and delivery rules, so no model can skip them", () => {
    const transcript = baseTranscript({
      agent: Agent.Info.default(Agent.ID.make("build")),
      model,
      tools: { definitions: [], execute: () => Effect.die("unused tool execution") },
      initial: [],
      messages: [textUser("oi")],
    })
    const system = transcript.system.map((part) => part.text).join("\n")
    // The rules ride along in full: removing them from baseTranscript, or
    // gutting their text, fails this test.
    expect(system).toContain(APPROVAL_BEFORE_BUILD)
    expect(system).toContain(DELIVERY_RULES)
    // Distinctive phrases, so an emptied constant fails too.
    expect(system).toContain("before the user has approved the plan")
    expect(system).toContain("ask the user to confirm with the question tool")
    expect(system).toContain("Only start building after the user says yes")
    expect(system).toContain("Never downgrade a system to a demo")
    expect(system).toContain("never present media as a system")
    expect(system).toContain("born ready to publish")
    expect(system).toContain("never localStorage as the final destination")
    expect(system).toContain("never as architecture")
  })

  test("the approval and delivery rules also ride along on a coding turn", () => {
    const transcript = baseTranscript({
      agent: Agent.Info.default(Agent.ID.make("build")),
      model,
      tools: { definitions: [], execute: () => Effect.die("unused tool execution") },
      initial: [],
      messages: [textUser("Crie o PDV completo")],
    })
    const system = transcript.system.map((part) => part.text).join("\n")
    expect(system).toContain(APPROVAL_BEFORE_BUILD)
    expect(system).toContain(DELIVERY_RULES)
  })
})
