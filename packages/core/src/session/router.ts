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
 */
import { Model } from "@opencode/schema/model"

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
 * The hop chain for one turn: ordered model refs, each carrying the variant
 * that expresses the effort on that model.
 *
 * Simple: every free model first, then the cheapest paid as a last resort
 * (Kimi last — it is the most expensive paid model here).
 * Complex: Kimi first when Moonshot is connected, then the cheapest paid,
 * then every free model as the fallback when the paid ones run out.
 */
export function buildChain(
  available: readonly Model.Info[],
  input: { complexity: Complexity; effort: Effort },
): Model.Ref[] {
  const pool = available.filter(isRoutable)
  const free = pool.filter(isFreeModel)
  const paid = pool.filter((model) => !isFreeModel(model))
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
  if (input.complexity === "complex")
    return [
      ...(kimi === undefined ? [] : [toRef(kimi)]),
      ...otherPaid.map(toRef),
      ...orderedFree,
    ]
  return [...orderedFree, ...otherPaid.map(toRef), ...(kimi === undefined ? [] : [toRef(kimi)])]
}

/** First chain ref not tried yet in this turn, or undefined when exhausted. */
export function nextHop(
  chain: readonly Model.Ref[],
  tried: ReadonlySet<string>,
): Model.Ref | undefined {
  return chain.find((ref) => !tried.has(refKey(ref)))
}
