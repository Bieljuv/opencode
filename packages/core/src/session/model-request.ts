export * as SessionModelRequest from "./model-request.js"

import {
  ai,
  AssistantMessage,
  type ContentPart,
  GENERATION_KEYS,
  type GenerationOptionsFields,
  LanguageModel,
  type LLM,
  type LLMRequest,
  type Media,
  type MediaPart,
  Message,
  SystemPart,
  ToolMessage,
  type ToolResultPart,
  UserMessage,
} from "@opencode/ai/effect"
import type { StreamOptions } from "@opencode/ai/route"
import type {
  SessionCompaction,
  SessionContext,
  SessionGenerate,
  SessionRequest,
  SessionRequestKind,
  SessionTitle,
} from "@opencode/plugin/effect/session"
import type { Agent } from "@opencode/schema/agent"
import type { Model } from "@opencode/schema/model"
import type { Content } from "@opencode/schema/tool"
import { Cause, Context, Effect, Layer, Result, Stream } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/http"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { App } from "../app.js"
import { Instructions } from "../instructions/index.js"
import { Permission } from "../permission.js"
import { PluginHooks } from "../plugin/hooks.js"
import { QuestionTool } from "../tool/plugin/question.js"
import { Tool } from "../tool.js"
import { SessionAffinity } from "./affinity.js"
import { SessionModelTransport } from "./model-transport.js"
import { SessionRouter } from "./router.js"
import { SessionRunnerModel } from "./runner/model.js"
import { SessionSchema } from "./schema.js"
import { SessionSystemPrompt } from "./system-prompt.js"
import { toLLMMessages } from "./runner/to-llm-message.js"
import type { SessionMessage } from "./message.js"

const IMAGE_BYTES_TRIGGER = 25 * 1024 * 1024 // 25 MiB
const IMAGE_BYTES_TARGET = 15 * 1024 * 1024 // 15 MiB
const IMAGE_REMOVED =
  "[This image was removed to reduce the request size and is no longer visible. Do not make claims about its contents from memory. If needed, retrieve it again with an available tool or ask the user to attach it again.]"
// Used when the catalog has no output limit for the model.
const OUTPUT_TOKEN_FALLBACK = 32_000
// No reply needs more, however much the model allows.
const OUTPUT_TOKEN_MAX = 256_000
// Prompt text is estimated at about 4 characters per token, which can run low on dense text such as code.
const ESTIMATE_ERROR = 0.15
// Share of the window a turn leaves unused when its output limit is fitted to the room left. Providers count a few
// tokens more than we do (chat template, tool schemas), and strict ones reject input plus output past the window.
// Compaction sizes its summary against its own reserve instead.
const WINDOW_HEADROOM = 0.01
// Never ask for less; only reachable with automatic compaction off, since it keeps the window from filling this far.
const OUTPUT_TOKEN_MIN = 1_024

/** Tool errors, plus the user declining a permission or dismissing a question. */
export type ExecuteError = Tool.Error | Permission.DeclinedError | QuestionTool.CancelledError

export interface Prepared<Event = SessionRequest> {
  readonly event: Event
  readonly request: LLMRequest
  readonly options: StreamOptions
  readonly retry: (event: PluginHooks.Domains["session"]["retry"]) => Effect.Effect<void>
  /** Runs a tool call against the tools this request advertised. */
  readonly executeTool: (
    input: Parameters<Tool.Snapshot["execute"]>[0],
  ) => Effect.Effect<Tool.NormalizedResult, ExecuteError>
}

export interface Input {
  readonly session: SessionSchema.Info
  readonly agent: Agent.ID
  readonly model: SessionRunnerModel.Resolved
  readonly tools?: Tool.Snapshot
  readonly system: Array<SystemPart>
  readonly messages: Array<Message>
  readonly toolChoice?: LLM.LLMRequestInput["toolChoice"]
  /** Only the durable runner may use a stateful WebSocket. */
  readonly webSocket?: "session"
  /** Prompt size, measured by the provider or estimated. The default output limit leaves room for it. */
  readonly inputTokens?: { readonly measured: number; readonly estimated: number }
  /**
   * The turn's classified complexity (primary only). On the gateway model
   * it rides to the server as a body overlay, so the gateway routes a
   * complex turn to its paid head first; direct models never see it.
   */
  readonly complexity?: SessionRouter.Complexity
}

/** The default output limit: the catalog limit, fitted to the room the prompt leaves in the context window. */
export const outputLimit = (limit: Model.Info["limit"], inputTokens?: Input["inputTokens"], headroom = 0) => {
  const requested = Math.min(limit.output > 0 ? limit.output : OUTPUT_TOKEN_FALLBACK, OUTPUT_TOKEN_MAX)
  if (inputTokens === undefined || limit.context <= 0) return requested
  const room =
    Math.floor(limit.context * (1 - headroom)) -
    inputTokens.measured -
    Math.ceil(inputTokens.estimated * (1 + ESTIMATE_ERROR))
  return Math.min(requested, Math.max(OUTPUT_TOKEN_MIN, room))
}

/**
 * ManosTech token economy, appended to the system prompt of every turn.
 * The agent never shows this to the user; it only steers how much context
 * the model consumes before answering.
 */
export const TOKEN_ECONOMY =
  "Token economy: be economical with tokens. Summarize long context in your own words before reasoning over it; prefer short, direct answers; do not repeat the user's text or tool output verbatim; only read the files and tool output you actually need."

/**
 * ManosTech mandatory token saving, appended to the system prompt of every
 * turn. The ponytail and graphify skills are not optional: ponytail keeps
 * every change minimal, and graphify keeps the agent from re-reading the
 * codebase on every question by consulting the project map. When the
 * graphify CLI is not installed the agent builds a lightweight map with its
 * own tools — nobody is ever asked to install anything, and the turn never
 * fails because the map is missing.
 */
export const MANDATORY_TOKEN_SAVING =
  "Token saving (mandatory, every turn): the ponytail and graphify skills are not optional. On every coding turn, apply the ponytail skill: the smallest change that fully solves the task. Before reading files to understand the codebase, consult the project map at graphify-out/graph.json or graphify-out/GRAPH_REPORT.md when it exists, and read only the files it points to. When no map exists and the task needs broad codebase understanding, build one: use the graphify CLI when installed, otherwise build a lightweight map with your own tools (tree, entry points, modules, imports, callers) and save it to graphify-out/GRAPH_REPORT.md. For a single targeted lookup, search directly instead of building a map. Never ask the user to install anything, and never fail the turn because the map is missing — fall back to normal file reading. The graphify skill was written for another editor: never create a CLAUDE.md and never install hooks here."

/**
 * ManosTech Arena auto-activation, appended to the system prompt of every
 * turn. The tournament is a tool the agent fires when the request justifies
 * it, not on every turn. The triggers are dissatisfaction, a high-stakes
 * decision, or a complex task whose first attempt was weak. Trivial
 * requests never fire it; when unsure, offer it instead.
 */
export const ARENA_AUTO =
  "Arena (automatic, only when the request justifies it): invoke the arena tool when (a) the user is unhappy with a previous answer (\"resposta ruim\", \"tenta de novo\", \"não gostei\", \"faz de novo\", \"errado\" after your answer), (b) the request is a high-stakes decision that is hard to reverse (choosing between approaches, architecture, or a library), or (c) the task is complex and your first attempt was weak (it failed, or the user had to correct it). Never run the tournament for a trivial request (a greeting, a quick question, a small fix). When unsure, offer the tournament and ask instead of running it silently. When you run it, tell the user in chat that the tournament is running and why, so they know why it takes longer. The user can always start it directly with /arena."

/**
 * ManosTech identity masking, appended to the system prompt of every turn.
 * The user must never learn which model or provider is answering, what tier
 * it runs on, or that models are switched behind the scenes. The rule covers
 * every visible word — answers, reasoning shown to the user, summaries, and
 * error explanations — including when the work itself is about models or
 * providers: report what works and what does not, never which model or
 * provider, and never with free/paid, quota, limit, or credit language.
 * It also covers the debugging narration itself: never list, count, or name
 * the providers or models available, never say how many are free or which
 * ones are, never say which ones are alive, slow, or unstable, never talk
 * about budgets or limits per model or in total — not even that you are
 * adjusting them — and never quote provider or tool error text — the model
 * saw those words in tool output, and repeating them is the leak. If a
 * sentence must name the system, its name is ManosTech.AI, never OpenCode
 * or opencode. The model is never told its own identity either (see
 * IdentityPlugin), so it has nothing to repeat.
 */
export const HIDE_MODEL_IDENTITY =
  "Identity: never reveal which model or provider is answering, in any visible text — answers, reasoning shown to the user, summaries, or error explanations. Never mention model names or IDs, provider names, free or paid tiers, quotas, limits, credits, message counts, or model switching and routing — even when the work itself involves testing or comparing models or providers; describe results generically instead. Never list, count, or name the providers or models available to you, and never say how many are free or which ones are — even while debugging routes, testing providers, or comparing them; call them the service, the first route, the next attempt. Never say which providers are alive, slow, or unstable, and never talk about budgets or limits per model or in total — not even that you are adjusting them. Never quote provider or tool error text; say only that it did not work and what you will try next. Never name the harness or engine you run on; if a sentence must name the system, call it ManosTech.AI — never OpenCode or opencode. If the user asks which model or AI is answering, reply exactly: \"Desculpa não tenho essa informação, algo mais em que posso ajudar?\" and nothing else."

/**
 * ManosTech direct reply, appended to the system prompt of every turn.
 * A greeting or a question that is not about the active task is not a
 * request to continue that task: the agent answers it directly in chat
 * and waits. Without this, a bare "oi" in the middle of a build is read
 * as "proceed" and the agent resumes editing files the user never asked
 * it to touch.
 */
export const DIRECT_REPLY =
  "Direct reply: a greeting or a question that is not about the active task is not a request to continue that task. When the user greets you (\"oi\", \"olá\", \"bom dia\", \"boa tarde\", \"boa noite\", \"hey\", \"hello\"), reply with a greeting in chat and then wait for the user — do not resume the previous task, do not call tools, do not edit files, and do not create a task card. When the user asks a question unrelated to the work in progress, answer it directly in chat (using a tool only if the answer itself needs one, never to resume the task) and then wait. The previous task only resumes when the user explicitly asks to continue it (\"continue\", \"continua\", \"pode continuar\", \"volta para a tarefa\", \"segue\", \"prossiga\") or gives a new build instruction. A question about the active task gets a direct chat answer too; only resume the task if the user asks you to."

/**
 * ManosTech failed tool calls, appended to the system prompt of every turn.
 * A failed tool call is information, not a cue to try the same call again:
 * the edit tool already returns the closest lines when oldString misses,
 * and repeating the identical call only burns the turn. Without this, the
 * agent retries a failing edit verbatim several times before stopping.
 */
export const FAILED_TOOL_RETRY =
  "Failed tool calls: when a tool call fails, never repeat the identical call. Read the error message — including any closest lines it shows — and adjust the call before trying again; when the failure is about content that does not match, re-read the file first. If the same operation fails a second time, stop and tell the user what went wrong and what you need, instead of trying again."

/**
 * ManosTech approval before building, appended to the system prompt of
 * every turn. The agent never creates, edits, or deletes files, and never
 * runs a command that changes files or system state, before the user has
 * approved the plan. The plan is shown in chat and confirmed with the
 * question tool; the permission system asks again for each mutation
 * unless the user answers "always", so even a skipped plan cannot build
 * silently. Without this, the agent starts building the moment it is
 * asked, which is the opposite of how the user works.
 */
export const APPROVAL_BEFORE_BUILD =
  "Approval before building: never create, edit, or delete files, and never run a command that changes files or system state, before the user has approved the plan. When a request means building or changing something, first show a short plan in chat — what you will build, the main files and steps, and what kind of delivery it is — and ask the user to confirm with the question tool (options to approve or to adjust). Only start building after the user says yes. Read-only exploration, questions, and explanations never need approval. An approval covers the plan as presented; if the work grows beyond it, show the updated plan and ask again. If the user already approved this exact work earlier in the conversation, continue without asking again."

/**
 * ManosTech delivery rules, appended to the system prompt of every turn.
 * The agent identifies what the delivery is before building it — a system,
 * a website, or a demo — and never downgrades a system to a demo. Every
 * build is born ready to publish, with the same code and structure locally
 * and in production. These rules live here, not in per-provider prompts,
 * so the agent keeps the same posture no matter which model answers.
 */
export const DELIVERY_RULES =
  "Delivery rules: first identify what the request is — a system (an app with a backend, database, users, or logins), a website (pages and content, no backend logic), or a demo (a throwaway preview). Never downgrade a system to a demo, and never present media as a system. Every build is born ready to publish: the same code and structure locally and in production; the database through Supabase, with the SQL in the project; secrets only through environment variables; a mock or simulation only when a credential is missing, never as architecture; never localStorage as the final destination."

/**
 * ManosTech multi-agent, appended to the system prompt only while the
 * composer's multi-agent toggle is on. The agent splits work that has
 * independent fronts across parallel subagents and joins the results;
 * the user watches each front live by its task label. Without the toggle
 * the agent works alone, as before.
 */
export const MULTI_AGENT =
  "Multi-agent: when the request splits into independent fronts, split it and run each front in its own parallel subagent in the background, so the fronts work at the same time, then join the results into one answer at the end. Fronts that depend on each other run in order, not in parallel. Give each front a short label of a few words saying what it does, so the user can follow it live. Only delegate fronts that are truly independent; a single small question or a single-file change is done directly, without subagents."

export const baseTranscript = (input: {
  readonly agent: Agent.Info
  readonly model: SessionRunnerModel.Resolved
  readonly tools: Tool.Snapshot
  readonly initial: ReadonlyArray<Instructions.Rendered>
  readonly messages: ReadonlyArray<SessionMessage.Info>
  /** The composer's multi-agent toggle for this turn; off keeps the agent working alone. */
  readonly multiAgent?: boolean
}) => {
  const providerMetadataKey = input.model.model.route.providerMetadataKey ?? input.model.model.provider
  return {
    providerMetadataKey,
    system: [
      SystemPart.make(
        input.agent.system
          ? input.agent.system
          : SessionSystemPrompt.make(input.tools.definitions.map((tool) => tool.name)),
      ),
      {
        ...SystemPart.make(Instructions.join(input.initial)),
        metadata: { experimental: { instructions: input.initial } },
      },
      // ManosTech token economy: embedded in every message, invisible to
      // the user. The agent summarizes context before reasoning over it and
      // keeps answers short, so simple turns stay on the cheapest models.
      SystemPart.make(TOKEN_ECONOMY),
      // ManosTech identity masking: embedded in every message, invisible to
      // the user. The agent never names a model or provider, never talks
      // about free/paid tiers, quotas, limits, credits, or model switching,
      // in any visible text — including its shown reasoning.
      SystemPart.make(HIDE_MODEL_IDENTITY),
      // ManosTech direct reply: embedded in every message, invisible to
      // the user. A greeting or an unrelated question is not a request to
      // continue the previous task: the agent answers it directly in chat
      // and waits, and only resumes the task on an explicit ask.
      SystemPart.make(DIRECT_REPLY),
      // ManosTech failed tool calls: embedded in every message, invisible
      // to the user. A failed call is never repeated identically; the agent
      // reads the error, adjusts, and after a second failure of the same
      // operation stops and tells the user.
      SystemPart.make(FAILED_TOOL_RETRY),
      // ManosTech mandatory token saving: embedded in every message,
      // invisible to the user. The ponytail and graphify skills are not
      // optional — the agent applies them on every turn where they fit, and
      // consults (or builds) the project map instead of re-reading files.
      SystemPart.make(MANDATORY_TOKEN_SAVING),
      // ManosTech Arena auto-activation: embedded in every message,
      // invisible to the user. The agent fires the tournament when the
      // request justifies it (dissatisfaction, a high-stakes decision, or
      // a weak first attempt), never for a trivial request, and offers it
      // instead when unsure.
      SystemPart.make(ARENA_AUTO),
      // ManosTech approval before building: embedded in every message,
      // invisible to the user. The agent shows a short plan and asks the
      // user to confirm it with the question tool before creating or
      // editing files or running a command that changes anything.
      SystemPart.make(APPROVAL_BEFORE_BUILD),
      // ManosTech delivery rules: embedded in every message, invisible to
      // the user. The agent identifies the delivery (system, website, or
      // demo) before building it and never downgrades a system to a demo;
      // every build is born ready to publish.
      SystemPart.make(DELIVERY_RULES),
      // ManosTech multi-agent: only while the toggle is on. The agent splits
      // independent fronts across parallel subagents and joins the results;
      // the user watches each front live by its task label.
      ...(input.multiAgent ? [SystemPart.make(MULTI_AGENT)] : []),
    ].filter((part) => part.text.length > 0),
    messages: toLLMMessages(input.messages, input.model.ref, providerMetadataKey),
  }
}

const mimeToModality = (mime: string) => {
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  if (mime === "application/pdf") return "pdf"
}

// xAI rejects any other image type (e.g. GIF) with invalid_image, and the stored image would fail every later turn.
const XAI_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"])

const unsupportedMedia = (
  mime: string,
  name: string | undefined,
  capabilities: Model.Capabilities,
  provider: string | undefined,
) => {
  const modality = mimeToModality(mime)
  if (!modality) return
  const unsupported = !capabilities.input.some((item) => item.startsWith(modality))
    ? modality
    : provider === "xai" && modality === "image" && !XAI_IMAGE_MIMES.has(mime.toLowerCase())
      ? mime
      : undefined
  if (!unsupported) return
  return `ERROR: Cannot read ${name ? `"${name}"` : modality} (this model does not support ${unsupported} input). Inform the user.`
}

// The inline budget counts base64 characters, which are ASCII, so a string's length is its size without scanning it.
// Remote and provider-referenced media carry no local payload and never count toward the inline budget.
const mediaBytes = (media: Media.Asset) => {
  if (media.source.type === "base64") return media.source.data.length
  if (media.source.type === "bytes") return Math.ceil(media.source.data.byteLength / 3) * 4
  return 0
}

/** Replaces media with the returned text; messages without replacements are returned unchanged. */
const replaceMedia = (
  messages: LLMRequest["messages"],
  replace: (media: { mime: string; name: string | undefined; bytes: () => number }) => string | undefined,
) => {
  const media = (part: MediaPart) => {
    const text = replace({ mime: part.media.mediaType, name: part.filename, bytes: () => mediaBytes(part.media) })
    return text === undefined ? part : Message.text(text)
  }
  const toolResult = (part: ToolResultPart) => {
    if (part.result.type !== "content") return part
    const result = part.result
    const value = result.value.map((item): Content => {
      if (item.type !== "file") return item
      const text = replace({ mime: item.mime, name: item.name, bytes: () => item.uri.length })
      return text === undefined ? item : { type: "text", text }
    })
    return value.every((item, index) => item === result.value[index]) ? part : { ...part, result: { ...result, value } }
  }
  return messages.map((message) => {
    switch (message.role) {
      case "system":
        return message
      case "user": {
        const content = message.content.map((part) => (part.type === "media" ? media(part) : part))
        return sameParts(content, message.content) ? message : new UserMessage({ ...message, content })
      }
      case "assistant": {
        const content = message.content.map((part) => {
          if (part.type === "media") return media(part)
          return part.type === "tool-result" ? toolResult(part) : part
        })
        return sameParts(content, message.content) ? message : new AssistantMessage({ ...message, content })
      }
      case "tool": {
        const content = message.content.map(toolResult)
        return sameParts(content, message.content) ? message : new ToolMessage({ ...message, content })
      }
    }
  })
}

const sameParts = (next: ReadonlyArray<ContentPart>, previous: ReadonlyArray<ContentPart>) =>
  next.every((part, index) => part === previous[index])

export const unsupportedParts = (
  messages: LLMRequest["messages"],
  capabilities: Model.Capabilities,
  provider?: string,
) => replaceMedia(messages, (media) => unsupportedMedia(media.mime, media.name, capabilities, provider))

export const boundImages = (messages: LLMRequest["messages"]) => {
  const isImage = (mime: string) => mime.toLowerCase().startsWith("image/")
  const sizes = messages.flatMap((message) =>
    message.content.flatMap((part) => {
      if (part.type === "media") return isImage(part.media.mediaType) ? [mediaBytes(part.media)] : []
      if (part.type !== "tool-result" || part.result.type !== "content") return []
      return part.result.value.flatMap((item: Content) =>
        item.type === "file" && isImage(item.mime) ? [item.uri.length] : [],
      )
    }),
  )
  // Replay the images in order, dropping the oldest down to the target whenever the kept payload passes the trigger.
  // A new image then moves the cut only every (trigger - target) bytes instead of on every request, so the replaced
  // prefix, and with it the provider's prompt cache, stays the same between cuts.
  let cut = 0
  let kept = 0
  for (const size of sizes) {
    kept += size
    if (kept <= IMAGE_BYTES_TRIGGER) continue
    while (kept > IMAGE_BYTES_TARGET) kept -= sizes[cut++]!
  }
  if (cut === 0) return messages

  let index = 0
  return replaceMedia(messages, (media) => {
    if (!isImage(media.mime)) return
    return index++ < cut ? IMAGE_REMOVED : undefined
  })
}

type Definitions = PluginHooks.Domains["session"]["context"]["tools"]

/** Builds the model request for each session flow. Each entry runs its own plugin hook. */
export interface Interface {
  readonly primary: (input: Input) => Effect.Effect<Prepared<SessionContext>>
  readonly compaction: (input: Input) => Effect.Effect<Prepared<SessionCompaction>>
  readonly generate: (input: Input) => Effect.Effect<Prepared<SessionGenerate>>
  readonly title: (input: Input) => Effect.Effect<Prepared<SessionTitle>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionModelRequest") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    const transport = yield* SessionModelTransport.Service
    const app = yield* App.Metadata
    const prepare = Effect.fn("SessionModelRequest.prepare")(function* <
      S extends SessionRequest & { tools?: Definitions },
    >(kind: SessionRequestKind, input: Input, shape: (draft: SessionRequest, tools: Definitions) => Effect.Effect<S>) {
      const session = input.session
      const model = input.model
      const scope = { sessionID: session.id, agent: input.agent, model: model.ref, kind }
      const tools = input.tools ?? {
        definitions: [],
        execute: () => new Tool.Error({ message: "Tools are not available for this request" }),
      }
      // Remember which tool each definition object came from. Hooks rename a tool by moving
      // its definition to a new key, so after the hook we find the tool by object identity.
      // Definitions are shared across steps and sessions, and hooks may edit schemas in place,
      // so each hook gets a deep copy.
      const given = new Map(
        tools.definitions.map(
          (t) => [{ description: t.description, input: JSON.parse(JSON.stringify(t.inputSchema)) }, t] as const,
        ),
      )
      // Hooks see the default output limit and may change or remove it. Titles and generate keep the provider default,
      // because their reasoning is hard to budget.
      const shaped = yield* shape(
        {
          sessionID: session.id,
          model: model.ref,
          system: input.system,
          messages: input.messages,
          options:
            kind === "primary"
              ? { maxTokens: outputLimit(model.limit, input.inputTokens, WINDOW_HEADROOM) }
              : kind === "compaction"
                ? { maxTokens: outputLimit(model.limit, input.inputTokens) }
                : {},
        },
        Object.fromEntries(Array.from(given, ([d, t]) => [t.name, d])),
      )
      // Match by identity first, then by key. Entries matching neither were invented by a
      // hook and are dropped. `t.name` stays the real name so execution can map renames back.
      const byName = new Map(tools.definitions.map((t) => [t.name, t]))
      const hooked = new Map(
        Object.entries(shaped.tools ?? {}).flatMap(([name, d]) => {
          const t = given.get(d) ?? byName.get(name)
          return t ? [[name, { ...t, description: d.description, inputSchema: d.input }] as const] : []
        }),
      )
      const entries = Object.entries(shaped.options)
      const generation = Object.fromEntries(entries.filter(([k]) => GENERATION_KEYS.has(k))) as GenerationOptionsFields
      const providerOptions = Object.fromEntries(entries.filter(([k]) => !GENERATION_KEYS.has(k)))
      const affinity = SessionAffinity.get(session)
      // Gateway mode, primary only: the turn's complexity rides to the
      // server as a body overlay (`http.body` merges over the provider
      // body after validation). Compaction, title, and generate never
      // carry it — the gateway defaults those to "simples".
      const gatewayBody =
        kind === "primary"
          ? SessionRouter.gatewayComplexityBody(model.ref, input.complexity)
          : undefined
      const base = ai.request({
        model: model.model,
        headers: {
          "x-opencode-session-id": session.id,
          ...(session.parentID ? { "x-opencode-parent-session-id": session.parentID } : {}),
          "x-session-affinity": affinity,
          "X-Session-Id": affinity,
          ...(session.parentID ? { "x-parent-session-id": session.parentID } : {}),
          "User-Agent": App.useragent(app),
          "x-opencode-project": session.projectID,
          "x-opencode-session": affinity,
          "x-opencode-client": app.name,
        },
        // TODO: Persist cache lineage so nested forks reuse the root session's cache key.
        promptCacheKey: /^ses_[0-9a-f]{64}$/.test(affinity) ? affinity.slice(4) : affinity,
        cache: model.cache?.ttl === undefined ? undefined : { ttl: model.cache.ttl },
        system: shaped.system,
        messages: boundImages(unsupportedParts(shaped.messages, model.capabilities, model.model.provider)),
        tools: Array.from(hooked, ([name, t]) => ({ ...t, name })),
        toolChoice: input.toolChoice,
        ...generation,
        providerOptions: Object.keys(providerOptions).length === 0 ? undefined : providerOptions,
        http: gatewayBody === undefined ? undefined : { body: gatewayBody },
      })

      const baseURL = base.model.route.endpoint.baseURL
      const modelHook = yield* hooks.trigger("session", "model.request", {
        ...scope,
        baseURL,
        headers: { ...base.headers },
      })
      const route =
        modelHook.baseURL !== undefined && modelHook.baseURL !== baseURL
          ? base.model.route.with({ endpoint: { baseURL: modelHook.baseURL } })
          : base.model.route
      const request = {
        ...base,
        model: route === base.model.route ? base.model : LanguageModel.update(base.model, { route }),
        headers: Object.keys(modelHook.headers).length === 0 ? undefined : modelHook.headers,
      }
      const hasHttpHooks =
        (yield* hooks.has("session", "http.request", model.ref.providerID)) ||
        (yield* hooks.has("session", "http.response", model.ref.providerID))
      const http: StreamOptions["http"] = hasHttpHooks
        ? (req, handler) =>
            Effect.gen(function* () {
              const request = yield* HttpClientRequest.toWeb(req)
              const before = yield* hooks.trigger("session", "http.request", { ...scope, request })
              // A hook that kept the request object cannot have replaced its body, so the original body is sent as is.
              // Reading it back would hold a second full copy of the request, screenshots included, for the whole call.
              const sent =
                before.request === request
                  ? HttpClientRequest.setBody(HttpClientRequest.fromWeb(request), req.body)
                  : before.request.body
                    ? HttpClientRequest.bodyUint8Array(
                        HttpClientRequest.fromWeb(before.request),
                        new Uint8Array(yield* Effect.promise(() => before.request.clone().arrayBuffer())),
                        before.request.headers.get("content-type") ?? undefined,
                      )
                    : HttpClientRequest.fromWeb(before.request)
              const res = yield* handler(sent)
              const after = yield* hooks.trigger("session", "http.response", {
                ...scope,
                request: before.request,
                response: new Response(
                  [204, 205, 304].includes(res.status) ? null : yield* Stream.toReadableStreamEffect(res.stream),
                  { status: res.status, headers: res.headers },
                ),
              })
              return HttpClientResponse.fromWeb(sent, after.response)
            })
        : undefined
      // HTTP hooks wrap every HTTP request, including the WebSocket fallback path. The route decides
      // which transport actually carries the request, so both hook families are always offered.
      const webSocket =
        input.webSocket === "session" && model.transport === "websocket"
          ? transport.bind(
              session.id,
              {
                handshake: (connect) =>
                  hooks
                    .trigger("session", "experimental.ws.handshake", {
                      ...scope,
                      url: connect.url,
                      headers: connect.headers,
                    })
                    .pipe(Effect.map((event) => ({ url: event.url, headers: event.headers }))),
                send: (frame) =>
                  hooks
                    .trigger("session", "experimental.ws.send", { ...scope, frame })
                    .pipe(Effect.map((event) => event.frame)),
                receive: (frame) =>
                  hooks
                    .trigger("session", "experimental.ws.receive", { ...scope, frame })
                    .pipe(Effect.map((event) => event.frame)),
              },
              model.chunkTimeout,
            )
          : undefined

      return {
        event: shaped,
        request,
        options: { ...(http ? { http } : {}), ...(webSocket ? { webSocket } : {}) },
        retry: (event: Parameters<Prepared["retry"]>[0]) =>
          hooks.trigger("session", "retry", event).pipe(Effect.asVoid),
        // Permission.assert and the question tool throw declines as defects so tools cannot
        // catch them and turn a "no" into model-visible output. Recover them here as failures,
        // including declines a tool rethrew and its wrapper attached to a Tool.Error, as Promise
        // plugin tools do.
        executeTool: (call: Parameters<Prepared["executeTool"]>[0]) =>
          tools.execute({ ...call, definitions: hooked }).pipe(
            Effect.catchCauseFilter(
              (cause) => {
                const decline = cause.reasons
                  .map((r) => (Cause.isDieReason(r) ? r.defect : Cause.isFailReason(r) ? r.error.error : undefined))
                  .find(
                    (value): value is Permission.DeclinedError | QuestionTool.CancelledError =>
                      value instanceof Permission.DeclinedError || value instanceof QuestionTool.CancelledError,
                  )
                return decline ? Result.succeed(decline) : Result.fail(cause)
              },
              (decline) => Effect.fail(decline),
            ),
          ),
      }
    })

    const agentHook =
      (name: "context" | "compaction" | "generate", agent: Agent.ID) => (draft: SessionRequest, tools: Definitions) =>
        hooks.trigger("session", name, { ...draft, agent, tools })

    return Service.of({
      primary: (input) => prepare("primary", input, agentHook("context", input.agent)),
      compaction: (input) => prepare("compaction", input, agentHook("compaction", input.agent)),
      generate: (input) => prepare("generate", input, agentHook("generate", input.agent)),
      title: (input) => prepare("title", input, (draft) => hooks.trigger("session", "title", draft)),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [PluginHooks.node, SessionModelTransport.node, App.node],
})
