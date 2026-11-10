export * as SessionRouter from "./router.js"

/**
 * ManosTech automatic router.
 *
 * The user never picks a model. This module decides which model answers each
 * message, and the session runner hops between models when one runs out of
 * credit — always silently, never showing a model name, a tier, or a
 * free-message counter.
 *
 * The law, in order:
 * - Free models first, always. Simple chats and requests use the lightest
 *   free model, even among the free ones.
 * - Turns rotate the starting free model round-robin per session: each
 *   new turn starts at the next capable free model after the one that
 *   answered the previous turn, so one free model does not absorb every
 *   turn until its free limit breaks. The rest of the chain stays the
 *   fallback, and a complex turn never rotates down to a free model.
 * - On error or exhausted credit, hop to the next free model. Never stop at
 *   a paywall: subscription models (OpenCode Go) are never in any chain.
 * - Complex requests use paid models with a configured key — Kimi K3.1 Pro
 *   first when Moonshot is connected, then the cheapest paid model.
 * - When the paid models run out of tokens, hop back to the free ones.
 * - The hop pool is dynamic: the models of the providers connected right
 *   now (`Model.available()`), discovered at runtime, never a fixed list.
 * - An explicit model in opencode.json (or on the agent) wins the initial
 *   choice; the hop still rescues the turn when it exhausts.
 * - Effort arrives from the app as prompt metadata (`manostechEffort`) and
 *   maps to the target model's reasoning variant when one exists.
 *
 * Complexity classification is an intent-first heuristic, not mechanical
 * keyword rules: a question is answered directly (simple), a small change
 * is simple, and only a long, multi-part, or architectural request is
 * complex.
 *
 * Capacity: the chain only carries models that fit this turn's real prompt.
 * Answering a small probe proves nothing — a model that answered in seconds
 * can still freeze on the real request — so the size used here is the
 * packed turn, never a probe. A model that fails mid-task is skipped to the
 * next capable one, and when no free model fits, the chain starts at the
 * paid models that do. All of it silent: no visible message ever says a
 * model was skipped, that the free tier could not cope, or that the turn
 * moved to paid — the user only sees the result, or the generic message
 * when nothing works.
 *
 * Speed: the cascade is fast or it is a bad experience. A model that
 * produces no output within the first-output deadline is frozen and the
 * runner hops at once instead of waiting out the transport timeouts
 * (5 minutes for headers, 15 between chunks). And a step that produced
 * no output at all within the cascade budget gives up with the generic
 * message instead of hopping through frozen models forever. A healthy
 * first answer arrives in seconds, so neither limit ever touches it.
 *
 * Gateway mode: when the ManosTech gateway is active, the only model this
 * router ever sees is `manostech/auto`, so the chain built here has a
 * single element and no hop ever happens in the app — provider failover
 * and model selection happen on the server, invisible to the app. The law
 * above still describes the local fallback (direct provider keys), and
 * complexity classification and effort keep running; they just no longer
 * pick a local model or rescue a turn.
 */
import { Model } from "@opencode/schema/model"
import { SessionError } from "@opencode/schema/session-error"

/** Effort chosen by the user in the composer. `automatico` is the default. */
export type Effort = "automatico" | "rapido" | "equilibrado" | "aprofundado"

export type Complexity = "simple" | "complex"

/** Prompt-metadata key carrying the effort (`manostechEffort`). */
export const EFFORT_METADATA_KEY = "manostechEffort"

/** Kimi K3.1 Pro: paid tier, complex tasks only, only with a Moonshot key. */
export const KIMI_K3 = { providerID: "moonshotai", id: "kimi-k3.1-pro" } as const

/**
 * Subscription-gated providers the router never picks. A Go model must never
 * be the end of the line: the app used to stop on the "subscribe to Go"
 * paywall instead of trying the next connected provider.
 */
const SUBSCRIPTION_PROVIDERS: ReadonlySet<string> = new Set(["opencode-go"])

/** Free models the app prefers first, in order (mirrors Model.preferFree). */
const PREFERRED_FREE = [
  "big-pickle",
  "deepseek-v4.1-flash-free",
  "glm-5.3-flash-free",
  "muse-spark-1.3-contributor-free",
]

/** The single generic message shown when every model is exhausted. */
export const EXHAUSTED_MESSAGE = "Tente novamente mais tarde."

/**
 * First output within this long or the model is frozen: hop. 30 seconds —
 * the same per-request timeout the code-mode fetch already uses
 * (`TIMEOUT_MS` in `codemode/fetch.ts`), and far below the 142.8s one
 * model held the user in Gabriel's gate test (2026-11-10 08:50, "lento
 * demais"). Normal first tokens arrive in seconds, and reasoning models
 * stream reasoning as output, so a model that produced nothing in 30s is
 * frozen for the user's purposes — the next model tries instead of the
 * user waiting minutes.
 */
export const FIRST_OUTPUT_TIMEOUT_MS = 30_000

/**
 * Total silence a step tolerates before the turn gives up with the
 * generic message. 90 seconds: three frozen attempts at the first-output
 * deadline, and still 52.8s below the 142.8s a single model held the user
 * in Gabriel's gate test — the whole cascade resolves before one frozen
 * model used to. Fast failures (429s) hop in ~0s, so the budget never
 * cuts a healthy cascade short; it only stops a dead one.
 */
export const CASCADE_BUDGET_MS = 90_000

/** True when the step has produced no output and the cascade budget is spent. */
export function cascadeBudgetSpent(startedAtMs: number, nowMs: number, outputStarted: boolean): boolean {
  return !outputStarted && nowMs - startedAtMs >= CASCADE_BUDGET_MS
}

/** The step failure when the cascade budget is spent: nothing answered in time. */
export const CASCADE_EXHAUSTED: SessionError.Error = {
  type: "provider.exhausted",
  message: EXHAUSTED_MESSAGE,
}

/** Session error type for a prompt the model cannot hold. A hop signal, never a stop. */
export const CONTEXT_OVERFLOW_TYPE = "provider.context-too-long"

/**
 * The largest prompt a model takes while leaving room for its reply.
 * Mirrors the compactor's ceiling (`calculateCeiling` in
 * `compaction.ts`): `RESERVE_SHARE` of the window, or `RESERVE_MIN` when
 * that is more. The router cannot import the compactor — the compactor
 * reads session errors through `to-session-error`, which reads this
 * module — so the two constants live here too, and must stay equal.
 */
const RESERVE_MIN = 16_000
const RESERVE_SHARE = 0.15

/** The largest prompt the model takes, or 0 when unknown. */
function inputWindow(limit: Pick<Model.Info, "limit">["limit"]): number {
  return limit.input && limit.context ? Math.min(limit.input, limit.context) : limit.input || limit.context
}

/** The largest request the model takes while leaving room for its reply; unbounded when the window is unknown. */
export function requestCeiling(limit: Pick<Model.Info, "limit">["limit"]): number {
  const window = inputWindow(limit)
  if (window <= 0) return Number.POSITIVE_INFINITY
  return window - Math.max(Math.floor(window * RESERVE_SHARE), window >= 2 * RESERVE_MIN ? RESERVE_MIN : 0)
}

/** True when the model's window holds this turn's prompt with room for its reply. An unknown window never excludes. */
export function fitsPrompt(model: Pick<Model.Info, "limit">, promptTokens: number): boolean {
  return promptTokens <= requestCeiling(model.limit)
}

/** True when the model costs nothing (no priced input or output tier). */
export function isFreeModel(model: Pick<Model.Info, "cost">): boolean {
  return !model.cost.some((cost) => cost.input > 0 || cost.output > 0)
}

/** True when the model may answer a session turn through this router. */
export function isRoutable(model: Model.Info): boolean {
  if ((model.type ?? "chat") !== "chat") return false
  if (!model.capabilities.tools) return false
  if (model.status === "deprecated") return false
  if (SUBSCRIPTION_PROVIDERS.has(model.providerID)) return false
  return true
}

/** Cheapest priced tier of the model, in USD per million tokens. Free is 0. */
export function modelPrice(model: Pick<Model.Info, "cost">): number {
  if (model.cost.length === 0) return 0
  return Math.min(...model.cost.map((cost) => cost.input + cost.output))
}

/** `"providerID/modelID"` — the identity a hop treats as already tried. */
export function refKey(ref: Pick<Model.Ref, "providerID" | "id">): string {
  return `${ref.providerID}/${ref.id}`
}

/**
 * Every session error type that means a quota/limit ran out. `toSessionError`
 * folds every quota/limit subtype into `provider.exhausted`, but a limit
 * refusal can also arrive under its own subtype — an older server, a stored
 * message, or a gateway that names the cap directly — and every one of them
 * is a hop signal, never a stop. A plain throttle (`provider.rate-limit`)
 * is not: it retries the same model with backoff.
 */
const EXHAUSTION_TYPES: ReadonlySet<string> = new Set([
  "provider.exhausted",
  "provider.free-limit",
  "provider.go-limit",
  "provider.budget-limit",
  "provider.model-budget-limit",
  "provider.quota",
  "provider.chatgpt-limit",
])

export function isExhaustionError(error: { readonly type: string }): boolean {
  return EXHAUSTION_TYPES.has(error.type)
}

/**
 * Every session error type the runner hops away from. Exhaustion hops at
 * once; a plain throttle (`provider.rate-limit`) also hops — a 429 is a
 * per-model or per-account cap (OpenRouter's free 20/min and 50/day caps,
 * an upstream provider at capacity), and another model answers now while
 * the same model would burn its backoff retries and die with the
 * throttle message. A model that freezes or fails mid-task hops too: a
 * timeout, a provider-side failure, or a broken/incomplete reply means
 * this model cannot carry this task, and the next capable model tries
 * instead of retrying the same one until the turn dies. A prompt the
 * model cannot hold (`provider.context-too-long`) hops to a bigger window,
 * never to a smaller one. An authentication failure hops too: the
 * credential is per provider, so a dead key on one provider must not
 * condemn the models of the others — each model is tried at most once
 * per turn, and the hop prefers a different provider. When no hop remains,
 * the throttle and the mid-task failures fall through to the same-model
 * retry policy instead of failing at once; auth is the exception and
 * fails at once with the generic message, because a dead key never heals
 * with backoff. Content-filter and invalid-request errors never hop:
 * they are request problems, not a spent or incapable model.
 */
export function isHopSignal(error: { readonly type: string }): boolean {
  return (
    error.type === "provider.rate-limit" ||
    error.type === "provider.auth" ||
    error.type === "provider.timeout" ||
    error.type === "provider.internal" ||
    error.type === "provider.invalid-output" ||
    error.type === CONTEXT_OVERFLOW_TYPE ||
    isExhaustionError(error)
  )
}

/** Effort from prompt metadata; anything unknown falls back to automatic. */
export function effortFromMetadata(metadata: Record<string, unknown> | undefined): Effort {
  const value = metadata?.[EFFORT_METADATA_KEY]
  if (value === "rapido" || value === "equilibrado" || value === "aprofundado" || value === "automatico")
    return value
  return "automatico"
}

/** Effort from the session model's reasoning variant, when one is set. */
export function effortFromVariant(variant: string | undefined): Effort {
  switch (variant) {
    case "low":
    case "minimal":
      return "rapido"
    case "medium":
      return "equilibrado"
    case "high":
    case "max":
    case "xhigh":
      return "aprofundado"
    default:
      return "automatico"
  }
}

/**
 * The reasoning variant id that carries the effort on this model, or
 * undefined when the model has no matching variant (the effort then only
 * steers which model the chain picks).
 */
export function variantForEffort(
  model: Pick<Model.Info, "variants">,
  effort: Effort,
): Model.VariantID | undefined {
  const ids = new Set<string>(model.variants.map((variant) => variant.id))
  const pick = (...candidates: string[]): Model.VariantID | undefined =>
    candidates.find((id) => ids.has(id)) as Model.VariantID | undefined
  switch (effort) {
    case "rapido":
      return pick("low", "minimal")
    case "equilibrado":
      return pick("medium")
    case "aprofundado":
      return pick("high", "max", "xhigh")
    default:
      return undefined
  }
}

const QUESTION_PREFIXES = [
  "o que",
  "o quê",
  "como",
  "qual",
  "quais",
  "quando",
  "onde",
  "por que",
  "porque",
  "porquê",
  "quanto",
  "quantos",
  "quantas",
  "quem",
  "é possível",
  "e possível",
  "posso",
  "pode",
  "poderia",
  "devo",
  "deveria",
  "existe",
  "existem",
  "há ",
  "me explica",
  "explique",
  "me diz",
  "me diga",
  "diga",
  "liste",
  "mostre",
  "qual é",
  "qual e",
  "what",
  "how",
  "why",
  "when",
  "where",
  "which",
  "can you",
  "could you",
  "is it possible",
  "explain",
]

const BUILD_VERBS = [
  "crie",
  "criar",
  "faça",
  "faca",
  "fazer",
  "altere",
  "alterar",
  "mude",
  "mudar",
  "adicione",
  "adicionar",
  "corrija",
  "corrigir",
  "implemente",
  "implementar",
  "construa",
  "construir",
  "revise",
  "revisar",
  "refatore",
  "refatorar",
  "remova",
  "remover",
  "troque",
  "trocar",
  "ajuste",
  "ajustar",
  "melhore",
  "melhorar",
  "monte",
  "montar",
  "desenvolva",
  "desenvolver",
  "arrume",
  "arrumar",
  "conserte",
  "consertar",
  "atualize",
  "atualizar",
  "configure",
  "configurar",
  "inclua",
  "incluir",
  "retire",
  "retirar",
  "renomeie",
  "renomear",
  "mova",
  "mover",
  "copie",
  "copiar",
  "apague",
  "apagar",
  "exclua",
  "excluir",
  "create",
  "build",
  "fix",
  "add",
  "change",
  "update",
  "implement",
  "refactor",
  "remove",
]

const COMPLEX_SIGNALS = [
  "sistema",
  "aplicativo",
  "app completo",
  "arquitetura",
  "integração",
  "integracao",
  "integrar",
  "migração",
  "migracao",
  "migrar",
  "banco de dados",
  "autenticação",
  "autenticacao",
  "login",
  "cadastro completo",
  "vários arquivos",
  "varios arquivos",
  "múltiplos arquivos",
  "multiplos arquivos",
  "projeto inteiro",
  "do zero",
  "criar um site",
  "criar um app",
  "dashboard completo",
  "painel completo",
  "várias telas",
  "varias telas",
  "muitas telas",
  "fluxo completo",
  "do início ao fim",
  "do inicio ao fim",
  "refatorar tudo",
  "reescreva",
  "reescrever",
]

/**
 * Intent-first complexity: a question is always simple (it is answered
 * directly, never built), a short single change is simple, and only a long,
 * multi-part, or architectural request is complex.
 */
export function classifyComplexity(text: string): Complexity {
  const lower = text.trim().toLowerCase()
  if (lower.length === 0) return "simple"
  if (lower.includes("?")) return "simple"
  if (QUESTION_PREFIXES.some((prefix) => lower.startsWith(prefix))) return "simple"
  if (lower.length > 600) return "complex"
  if (COMPLEX_SIGNALS.some((signal) => lower.includes(signal))) return "complex"
  const verbs = new Set(
    BUILD_VERBS.filter((verb) => new RegExp(`\\b${verb}\\b`).test(lower)),
  )
  if (verbs.size >= 2) return "complex"
  return "simple"
}

/** Free models in hop order: preferred free first, then the rest. */
function orderFree(free: readonly Model.Info[], effort: Effort): Model.Info[] {
  const preferred = PREFERRED_FREE.flatMap((id) => free.find((model) => model.id === id) ?? [])
  const rest = free.filter((model) => !preferred.includes(model))
  if (effort === "rapido") {
    // Lightest first: the smallest context window is the catalog's only size
    // signal, and it stands in for the lowest token consumption.
    const lightest = [...free].sort((a, b) => a.limit.context - b.limit.context)
    return lightest
  }
  return [...preferred, ...rest]
}

/**
 * Round-robin over the free run: the run starts at the model after
 * `after`, wrapping to the first. A model outside the run (or no `after`)
 * leaves the order untouched, so the first turn of a session and a turn
 * that ended on a paid model both start at the preferred free model. A
 * single-model run never changes.
 */
function rotateFreeRun(
  free: readonly Model.Ref[],
  after: Pick<Model.Ref, "providerID" | "id"> | undefined,
): Model.Ref[] {
  if (after === undefined) return [...free]
  const index = free.findIndex((ref) => ref.providerID === after.providerID && ref.id === after.id)
  if (index < 0) return [...free]
  return [...free.slice(index + 1), ...free.slice(0, index + 1)]
}

/**
 * The hop chain for one turn: ordered model refs, each carrying the variant
 * that expresses the effort on that model.
 *
 * Simple: every free model first, then the cheapest paid as a last resort
 * (Kimi last — it is the most expensive paid model here).
 * Complex: Kimi first when Moonshot is connected, then the cheapest paid,
 * then every free model as the fallback when the paid ones run out.
 *
 * `promptTokens` is the size of this turn's real prompt, in tokens. When
 * given, models whose window cannot hold it (leaving room for the reply)
 * never enter the chain — a model that answered a small probe can still
 * freeze on the real request, so the chain is built from the real size.
 * When the filter would empty the pool, it is dropped entirely: the turn
 * still runs, and compaction handles the overflow. A filter that leaves no
 * free model capable escalates the chain to the paid models that fit.
 *
 * `rotateAfter` is the model that answered the previous turn: the free
 * run starts at the next capable free model after it, so consecutive
 * turns spread across the free pool instead of draining one model to its
 * free limit. It only moves the free run — a complex turn still starts
 * on its paid head, never on a free model.
 */
export function buildChain(
  available: readonly Model.Info[],
  input: {
    complexity: Complexity
    effort: Effort
    promptTokens?: number
    rotateAfter?: Pick<Model.Ref, "providerID" | "id">
  },
): Model.Ref[] {
  const pool = available.filter(isRoutable)
  const { promptTokens } = input
  const capable =
    promptTokens === undefined ? pool : pool.filter((model) => fitsPrompt(model, promptTokens))
  const usable = capable.length > 0 ? capable : pool
  const free = usable.filter(isFreeModel)
  const paid = usable.filter((model) => !isFreeModel(model))
  const kimi = paid.find((model) => model.providerID === KIMI_K3.providerID && model.id === KIMI_K3.id)
  const otherPaid = paid
    .filter((model) => model !== kimi)
    .sort((a, b) => modelPrice(a) - modelPrice(b))
  const toRef = (model: Model.Info): Model.Ref => {
    const variant = variantForEffort(model, input.effort)
    return Model.Ref.make({
      providerID: model.providerID,
      id: model.id,
      ...(variant === undefined ? {} : { variant }),
    })
  }
  const orderedFree = orderFree(free, input.effort).map(toRef)
  const rotatedFree = rotateFreeRun(orderedFree, input.rotateAfter)
  if (input.complexity === "complex")
    return [
      ...(kimi === undefined ? [] : [toRef(kimi)]),
      ...otherPaid.map(toRef),
      ...rotatedFree,
    ]
  return [...rotatedFree, ...otherPaid.map(toRef), ...(kimi === undefined ? [] : [toRef(kimi)])]
}

/** First chain ref not tried yet in this turn, or undefined when exhausted. */
export function nextHop(
  chain: readonly Model.Ref[],
  tried: ReadonlySet<string>,
): Model.Ref | undefined {
  return chain.find((ref) => !tried.has(refKey(ref)))
}

/**
 * The model a step starts on. A new turn takes the chain head (already
 * rotated past the model that answered the previous turn); a continuation
 * step keeps the turn's model when it is still in the chain, so rotation
 * never switches models mid-task. Falls back to the chain head when the
 * session has no model or it left the chain.
 */
export function stepHead(
  chain: readonly Model.Ref[],
  tried: ReadonlySet<string>,
  sessionModel: Model.Ref | undefined,
  isNewTurn: boolean,
): Model.Ref | undefined {
  if (!isNewTurn && sessionModel !== undefined) {
    const current = chain.find(
      (ref) => refKey(ref) === refKey(sessionModel) && !tried.has(refKey(ref)),
    )
    if (current !== undefined) return current
  }
  return nextHop(chain, tried)
}

/**
 * First chain ref not tried yet from a different provider than the one
 * that just failed, or the plain next hop when no other provider remains.
 * A rate limit is usually per account, not per model — OpenRouter's free
 * 20/min cap covers every free model on the account — so hopping to
 * another model of the same provider hits the same wall. A different
 * provider is a different bucket.
 */
export function nextHopFromProvider(
  chain: readonly Model.Ref[],
  tried: ReadonlySet<string>,
  providerID: string,
): Model.Ref | undefined {
  return (
    chain.find((ref) => !tried.has(refKey(ref)) && ref.providerID !== providerID) ?? nextHop(chain, tried)
  )
}

/**
 * First chain ref not tried yet whose window is strictly larger than the
 * model that just failed with a prompt it cannot hold. A smaller or equal
 * window would fail on the same prompt, so it is never a hop target for a
 * context overflow — when none is larger, compaction shrinks the prompt
 * instead. A model with an unknown window (0) never counts as larger: its
 * size cannot be proven. `pool` is the `available()` list the chain was
 * built from; the chain itself carries refs only.
 */
export function nextHopWithLargerWindow(
  pool: readonly Model.Info[],
  chain: readonly Model.Ref[],
  tried: ReadonlySet<string>,
  current: Pick<Model.Info, "limit">,
): Model.Ref | undefined {
  const currentWindow = inputWindow(current.limit)
  const byKey = new Map(pool.map((model) => [refKey(model), model]))
  return chain.find((ref) => {
    if (tried.has(refKey(ref))) return false
    const model = byKey.get(refKey(ref))
    if (model === undefined) return false
    const window = inputWindow(model.limit)
    return window > 0 && window > currentWindow
  })
}
