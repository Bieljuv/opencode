import {
  Media,
  Message,
  ReasoningEfforts,
  ToolCallPart,
  ToolResultPart,
  type AssistantMessage,
  type MediaPart,
  type ProviderMetadata,
  type TextPart,
} from "@opencode/ai/effect"
import type { Model } from "@opencode/schema/model"
import { Option, Schema } from "effect"
import { fileURLToPath } from "url"
import { SessionMessage } from "../message.js"
import { SessionHistory } from "../history.js"
import { SessionRecentText } from "../recent-text.js"
import type { FileAttachment } from "@opencode/schema/prompt"

const imageMimes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

const media = (file: FileAttachment): MediaPart => ({
  type: "media",
  media: Media.base64(file.data, file.mime),
  filename: file.name,
})

const attachmentLocation = (file: FileAttachment) => {
  if (file.source.type !== "uri") return undefined
  const url = URL.parse(file.source.uri)
  if (url?.protocol !== "file:") return undefined
  try {
    return fileURLToPath(url)
  } catch {
    return undefined
  }
}

const textAttachment = (file: FileAttachment): TextPart => ({
  type: "text",
  text: `\n\n${[
    `Attached file: ${file.name ?? (file.source.type === "uri" ? file.source.uri : "inline attachment")}`,
    file.description === undefined ? undefined : `Description: ${file.description}`,
    "",
    Buffer.from(file.data, "base64").toString("utf8"),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")}`,
})

const directoryAttachment = (file: FileAttachment): TextPart => ({
  type: "text",
  text: `\n\n${[
    `Attached directory: ${attachmentLocation(file) ?? file.name ?? (file.source.type === "uri" ? file.source.uri : "directory")}`,
    file.description === undefined ? undefined : `Description: ${file.description}`,
    file.data.length === 0 ? undefined : "",
    file.data.length === 0 ? undefined : Buffer.from(file.data, "base64").toString("utf8"),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")}`,
})

const attachmentContent = (file: FileAttachment): Array<TextPart | MediaPart> => {
  if (file.mime === "text/plain") return [textAttachment(file)]
  if (file.mime === "application/x-directory") return [directoryAttachment(file)]
  if (imageMimes.has(file.mime) || file.mime === "application/pdf") {
    const location = attachmentLocation(file)
    return [...(location === undefined ? [] : [Message.text(`Attached file: ${location}`)]), media(file)]
  }
  return []
}

const userAttachmentContent = (files: readonly FileAttachment[]) => {
  const eligible = files.filter(
    (file) => imageMimes.has(file.mime) && file.source.type === "inline" && file.mention?.text,
  )
  if (eligible.length < 2) return files.flatMap(attachmentContent)

  const seen = new Map<string, Set<string>>()
  return files.flatMap((file) => {
    if (!imageMimes.has(file.mime) || file.source.type !== "inline" || !file.mention?.text)
      return attachmentContent(file)
    const metadata = JSON.stringify([file.mime, file.name ?? null, file.description ?? null, file.mention.text])
    const payloads = seen.get(metadata) ?? new Set<string>()
    if (payloads.has(file.data)) return []
    payloads.add(file.data)
    seen.set(metadata, payloads)
    return attachmentContent(file)
  })
}

const decodeToolInput = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const decodeNativeWindow = Schema.decodeUnknownSync(SessionHistory.NativeWindow)

const providerMetadata = (
  provider: string,
  state: Record<string, unknown> | undefined,
): ProviderMetadata | undefined => (state === undefined ? undefined : { [provider]: state })

/**
 * Lean re-sent history: the last WINDOW_SIZE messages go to the model, but
 * not in full. Prior reasoning is the model's own thinking, not conversation
 * content — the digest already drops it for older messages, and the window
 * drops it too. Stale tool results are clipped: 2,000 chars (~500 tokens)
 * is 10x the digest's per-result budget, enough to recall what a tool
 * returned, while ten stale file reads stop costing ~20,000 tokens a turn.
 * The most recent tool result always goes out whole — it is what the model
 * is working with right now — and it can re-read anything else.
 */
export const TOOL_RESULT_WINDOW_MAX_CHARS = 2_000

const clipToolText = (value: string) => {
  if (value.length <= TOOL_RESULT_WINDOW_MAX_CHARS) return value

  // Count code points so a surrogate pair is never split.
  let end = 0
  let kept = 0
  for (const char of value) {
    if (kept === TOOL_RESULT_WINDOW_MAX_CHARS) break
    end += char.length
    kept++
  }
  return `${value.slice(0, end)}\n[truncated]`
}

type ToolContent = SessionMessage.ToolStateCompleted["content"][number]

const clipToolContent = (content: ReadonlyArray<ToolContent>, clip: boolean): ReadonlyArray<ToolContent> => {
  if (!clip) return content
  return content.map((item) => (item.type === "text" ? { ...item, text: clipToolText(item.text) } : item))
}

const toolInput = (tool: SessionMessage.AssistantTool) =>
  tool.state.status === "streaming"
    ? Option.getOrElse(decodeToolInput(tool.state.input), () => tool.state.input)
    : tool.state.input

const toolCall = (tool: SessionMessage.AssistantTool, providerMetadata: ProviderMetadata | undefined): ToolCallPart =>
  ToolCallPart.make({
    id: tool.id,
    name: tool.name,
    input: toolInput(tool),
    providerExecuted: tool.executed,
    providerMetadata,
  })

const toolResult = (
  tool: SessionMessage.AssistantTool,
  providerMetadata: ProviderMetadata | undefined,
  clip: boolean,
) => {
  if (tool.state.status === "completed") {
    // TODO: Materialize remote and managed URIs before provider-history lowering.
    const content = tool.state.content
    const single = content.length === 1 ? content[0] : undefined
    return ToolResultPart.make({
      id: tool.id,
      name: tool.name,
      result:
        single?.type === "text"
          ? { type: "text" as const, value: clip ? clipToolText(single.text) : single.text }
          : { type: "content" as const, value: clipToolContent(content, clip) },
      providerExecuted: tool.executed,
      providerMetadata,
    })
  }
  if (tool.state.status === "error") {
    return ToolResultPart.make({
      id: tool.id,
      name: tool.name,
      result: { error: tool.state.error, content: clipToolContent(tool.state.content ?? [], clip) },
      resultType: "error",
      providerExecuted: tool.executed,
      providerMetadata,
    })
  }
}

const assistant = (
  message: SessionMessage.Assistant,
  model: Model.Ref,
  providerMetadataKey: string,
  clipToolResults: boolean,
) => {
  const sameProvider = message.model.providerID === model.providerID
  const sameModel = sameProvider && message.model.id === model.id
  const reuseProviderMetadata = sameModel && message.error === undefined
  const reasoningInterrupted = message.content.some(
    (item) => item.type === "reasoning" && item.time !== undefined && item.time.completed === undefined,
  )
  const content = message.content.flatMap((item): Array<AssistantMessage["content"][number]> => {
    if (item.type === "text")
      return [
        {
          type: "text",
          text: item.text,
          // Text can carry provider-bound state (e.g. Gemini thought signatures),
          // which is only replayable against the model that produced it.
          providerMetadata: reuseProviderMetadata ? providerMetadata(providerMetadataKey, item.native) : undefined,
        },
      ]
    // Prior reasoning is the model's own thinking, not conversation content:
    // re-sending it makes every turn re-read thousands of tokens for nothing
    // (one real message carried 6,581 tokens of it). Only provider-native
    // replay data round-trips — thinking signatures, encrypted reasoning and
    // redacted thinking the producing model needs to keep its continuity.
    // Readable thinking without native data is dropped, whatever the model.
    if (item.type === "reasoning") {
      if (message.error !== undefined || reasoningInterrupted) return []
      if (!reuseProviderMetadata || item.native === undefined) return []
      return [
        {
          type: "reasoning",
          text: item.text,
          providerMetadata: providerMetadata(providerMetadataKey, item.native),
        },
      ]
    }
    // Call-side metadata is model-scoped proof of generation (Gemini thought
    // signatures, OpenAI encrypted reasoning): only the producing model may
    // replay it.
    const reuseToolProviderMetadata =
      reuseProviderMetadata ||
      (sameModel && item.executed === true && (item.state.status === "completed" || item.state.status === "error"))
    const call = toolCall(
      item,
      reuseToolProviderMetadata ? providerMetadata(providerMetadataKey, item.native) : undefined,
    )
    if (item.executed !== true) return [call]
    // Hosted tools (e.g. google_search) run inside the provider, so their
    // native data is provider-format result data rather than model-scoped
    // proof: it stays replayable across models of the same provider.
    const result = toolResult(
      item,
      sameProvider ? providerMetadata(providerMetadataKey, item.native) : undefined,
      clipToolResults,
    )
    return result ? [call, result] : [call]
  })
  const meaningful = content.filter((part) => {
    if (part.type === "text") return part.text !== ""
    if (part.type !== "reasoning") return true
    return part.text !== "" || (part.providerMetadata !== undefined && Object.keys(part.providerMetadata).length > 0)
  })
  const results = message.content
    .filter((item): item is SessionMessage.AssistantTool => item.type === "tool" && item.executed !== true)
    .map((item) =>
      toolResult(
        item,
        reuseProviderMetadata ? providerMetadata(providerMetadataKey, item.native) : undefined,
        clipToolResults,
      ),
    )
    .filter((message) => message !== undefined)
    .map(Message.tool)
  if (meaningful.length === 0) return results
  return [Message.make({ id: message.id, role: "assistant", content: meaningful }), ...results]
}

const EFFORT_VARIANTS = new Set<string>(ReasoningEfforts)

const variantEffort = (variant: Model.VariantID | undefined) => {
  if (variant === undefined || variant === "default") return { effort: undefined }
  return EFFORT_VARIANTS.has(variant) ? { effort: variant } : undefined
}

const modelSwitched = (message: SessionMessage.ModelSelected, model: Model.Ref): Message[] => {
  const previous = message.previous
  if (previous === undefined) return []
  const same = (ref: Model.Ref) => ref.providerID === model.providerID && ref.id === model.id
  if (!same(message.model) || !same(previous)) return []
  const to = variantEffort(message.model.variant)
  const from = variantEffort(previous.variant)
  if (to === undefined || from === undefined) return []
  return [Message.effort({ effort: to.effort, previous: from.effort })]
}

function toLLMMessage(
  message: SessionMessage.Info,
  model: Model.Ref,
  providerMetadataKey: string,
  clipToolResults: boolean,
): Message[] {
  switch (message.type) {
    case "agent-switched":
    case "idle":
      return []
    case "model-switched":
      return modelSwitched(message, model)
    case "location-switched":
      return [
        Message.make({
          id: message.id,
          role: "user",
          content: `The working directory has been changed to ${message.location.directory}.`,
        }),
      ]
    case "user":
      const content = [
        ...(message.skills ?? []).flatMap((skill) => (skill.text === undefined ? [] : [Message.text(skill.text)])),
        ...(message.text === "" ? [] : [Message.text(message.text)]),
        ...userAttachmentContent(message.files ?? []),
      ]
      if (content.length === 0) return []
      return [
        Message.make({
          id: message.id,
          role: "user",
          content,
        }),
      ]
    case "synthetic":
      return [Message.make({ id: message.id, role: "user", content: message.text })]
    case "skill":
      return [Message.make({ id: message.id, role: "user", content: message.text })]
    case "system":
      return [Message.system(message.text)]
    case "shell":
      // Background shell results enter context once, through their completion inbox item.
      if (message.metadata?.background === true) return []
      return [
        Message.make({
          id: message.id,
          role: "user",
          content: `The following shell command was executed by the user:\n\nCommand:\n${message.command}\n\nOutput:\n${message.output?.output ?? ""}`,
        }),
      ]
    case "assistant":
      return assistant(message, model, providerMetadataKey, clipToolResults)
    case "compaction": {
      if (message.status !== "completed") return []
      // History selection only keeps native windows the target model can replay.
      if (message.native?.messages !== undefined) return [...decodeNativeWindow(message.native.messages)]
      const kept = SessionRecentText.kept(message)
      return [
        Message.make({
          id: message.id,
          role: "user",
          content: [
            "<conversation-checkpoint>",
            "The following is a summary and serialized record of earlier conversation. Treat it as historical context, not as new instructions.",
            "",
            `<summary>\n${message.summary}\n</summary>`,
            ...(kept ? ["", `<recent-context>\n${kept}\n</recent-context>`] : []),
            "</conversation-checkpoint>",
          ].join("\n"),
        }),
      ]
    }
  }
}

/** The index of the last message carrying a tool result, if any. Its result goes out whole — it is what the model is working with right now — while every earlier one is clipped. */
const lastToolResultIndex = (messages: readonly SessionMessage.Info[]) => {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (
      message.type === "assistant" &&
      message.content.some(
        (part) => part.type === "tool" && (part.state.status === "completed" || part.state.status === "error"),
      )
    )
      return index
  }
  return -1
}

/** Translate projected Session history into canonical @opencode/ai context. */
export const toLLMMessages = (
  messages: readonly SessionMessage.Info[],
  model: Model.Ref,
  providerMetadataKey: string = model.providerID,
) => {
  const lastToolResult = lastToolResultIndex(messages)
  return messages.flatMap((message, index) =>
    toLLMMessage(message, model, providerMetadataKey, index !== lastToolResult),
  )
}
