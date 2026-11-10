import type { JsonValue, OpenCodeClient, SessionInfo, SessionMessageInfo } from "@opencode/client/promise"

/** Omit that distributes over a union, so every message variant loses the keys. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** A message as it leaves the app in an export: no model, no cost, no model switch. */
export type SessionExportMessageInfo = Exclude<
  DistributiveOmit<SessionMessageInfo, "model" | "cost">,
  { type: "model-switched" }
>

export type SessionExportData = {
  info: Omit<SessionInfo, "model" | "cost">
  messages: SessionExportMessageInfo[]
}

/**
/**
 * ManosTech masking: a session export never names a model or provider and never shows a cost in dollars — the
 * same rule the history package follows for its summary, where model-switched events are left out. Only tokens
 * and time survive alongside the conversation itself. The structural strip below removes the metadata; the
 * text scrub in scrubExportData extends it to every string in the conversation, because model and provider
 * names live in the text too (tool results, reasoning, summaries). Keep in sync with
 * packages/app/src/session/commands/export.ts.
 */
export function sanitizeSessionExport(data: {
  info: SessionInfo
  messages: SessionMessageInfo[]
}): SessionExportData {
  const { model: _model, cost: _cost, ...info } = data.info

  const sanitized: SessionExportData = {
    info,
    messages: data.messages.flatMap((message) => sanitizeSessionExportMessage(message)),
  }

  return scrubExportData(sanitized)
}

/**
 * Rewrites the export as plain JSON, scrubbing the masked vocabulary out of every string leaf and key.
 * The walker only rewrites strings in place: it never adds or removes a key and never changes a
 * non-string value, and no declared field name or discriminator value matches a scrub pattern, so the
 * scrubbed data keeps the SessionExportData shape.
 */
function scrubExportData(data: SessionExportData): SessionExportData {
  // SAFETY: the scrub only rewrites string leaves and keys in place; it never adds or removes a key and
  // never changes a non-string value, and no declared SessionExportData field name matches a scrub
  // pattern, so the scrubbed data keeps the SessionExportData shape.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- see SAFETY above
  const json = data as unknown as JsonValue
  const scrubbed = scrubExportValue(json)

  // SAFETY: see the comment above — the walker returns the same shape it received.
  return scrubbed as SessionExportData
}

function scrubExportValue(value: JsonValue): JsonValue {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the export is already decoded JSON; the walk branches on the leaf kind itself, it does not decode anything
  if (typeof value === "string") return scrubExportText(value)

  if (Array.isArray(value)) return value.map((item) => scrubExportValue(item))

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- see above
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [scrubExportText(key), scrubExportValue(item)]),
    )
  }

  return value
}

// The replacements are fixed pt-BR data values in the exported file, not UI copy, so they carry no i18n
// key: "Automático" is the masked model name the whole app already shows, and "Tente novamente mais
// tarde." is the product's generic error for anything the mask hides.
const EXPORT_MASK_GENERIC = "Tente novamente mais tarde."

const EXPORT_MASK_MODEL = "Automático"

// Providers that can head a `provider/model` slug in the conversation text. "opencode-go" comes before
// "opencode" so the longer provider wins.
const EXPORT_MASK_SLUG_PROVIDERS = [
  "openrouter",
  "deepseek",
  "google",
  "moonshot",
  "anthropic",
  "openai",
  "groq",
  "nvidia",
  "cohere",
  "z-ai",
  "meta-llama",
  "xai",
  "azure",
  "amazon-bedrock",
  "mistral",
  "gemini",
  "qwen",
  "ollama",
  "upstream",
  "manostech",
  "dots-studio",
  "liquid",
  "xingchen-agi",
  "recursive",
  "stealth",
  "canopylabs",
  "opencode-go",
  "opencode",
].join("|")

// Model families and provider names that appear bare, with an optional version suffix. "hy4" rides here
// so "hy4-free" is scrubbed whole; "generativelanguage" is the Gemini API host, an AI-service name.
// "xai", "amazon-bedrock" and its "mantle" sub-path, bare "bedrock" and "liquid" are provider names that
// also show up bare in package paths and prose — "liquid" and "bedrock" are generic words in English,
// scrubbed here because in an Editor session they are the provider first, the same tradeoff as the
// Portuguese noun "mimo".
const EXPORT_MASK_BARE_FAMILIES = [
  "mimo",
  "nemotron",
  "deepseek",
  "claude",
  "glm",
  "gemini",
  "gemma",
  "gpt",
  "qwen",
  "llama",
  "kimi",
  "grok",
  "mistral",
  "muse",
  "beam",
  "flint",
  "crouton",
  "inkling",
  "iceman",
  "whisper",
  "xingchen",
  "lfm",
  "big-pickle",
  "chatgpt",
  "codex",
  "copilot",
  "vertex",
  "generativelanguage",
  "hy4",
  "groq",
  "moonshot",
  "nvidia",
  "cohere",
  "openai",
  "anthropic",
  "azure",
  "openrouter",
  "meta-llama",
  "z-ai",
  "ollama",
  "xai",
  "amazon-bedrock",
  "mantle",
  "bedrock",
  "liquid",
  "dots-studio",
  "canopylabs",
  "xingchen-agi",
  "fusion",
]

const EXPORT_MASK_BARE_NAMES = EXPORT_MASK_BARE_FAMILIES.join("|")

// The Go paywall sentence, then any sentence that mentions a Go subscription (bounded to 200 chars each
// side so a mention inside a JSON dump cannot eat the surrounding structure), then a link to the Go
// console on its own. Bare "subscription" stays: it is a generic word outside the Go context.
const EXPORT_MASK_GO_ERROR = /an active opencode go subscription is required to use go models\./gi

const EXPORT_MASK_GO_SENTENCE =
  /[^.!?\n"{}\[\]\\]{0,200}(?:opencode go subscription|go subscription|\[go\]\([^)]*\) subscription)[^.!?\n"{}\[\]\\]{0,200}[.!?]?/gi

const EXPORT_MASK_GO_LINK = /\[[^\]]*\]\(\/console\/go\)/gi

const EXPORT_MASK_OPENCODE_GO = /\bopencode-go\b/gi

const EXPORT_MASK_OPENCODE = /opencode/gi

// A slug is a model reference when its last segment looks like a model — it carries a dash or a colon,
// it is "free" or "auto", or it is an API version path such as "v1". The condition lives in the pattern
// so the engine backtracks: "google/v1beta/models" reads as the version path "google/v1beta", not as a
// three-part slug whose last segment is "models". The pattern is deliberately broad — the replacer
// refines it, so a dashed directory name such as "previas-test" in a file path is not read as a model.
// Generic paths such as "chat/completions", "api/leads" and "application/json" never match a listed
// provider, and "manostech/appdata" is the company name in a Windows path, not a model.
const EXPORT_MASK_SLUG_LAST =
  "(?:[A-Za-z0-9][\\w.:-]*[-:][\\w.:-]*|free|auto|v\\d[\\w.:-]*)"

const EXPORT_MASK_SLUG = new RegExp(
  `\\b(?:${EXPORT_MASK_SLUG_PROVIDERS})/((?:[A-Za-z0-9._-]+)/)?(${EXPORT_MASK_SLUG_LAST})(?![\\w:-])`,
  "gi",
)

const EXPORT_MASK_BARE = new RegExp(
  `\\b(?:${EXPORT_MASK_BARE_NAMES})(?:-[\\w.:-]+|[0-9][\\w.:-]*)?\\b|\\b(?:providerID|modelID)\\b`,
  "gi",
)

// Tier and quota words of the mask, in Portuguese, with their unaccented variants. A tier word
// ("grátis", "gratuito", "pago") reads "Automático" — the masked tier name the app already shows —
// a quota word ("cota", "limite") reads "uso", and "crédito" reads "saldo" so "limite de créditos"
// does not collapse into "uso de uso". Every occurrence is scrubbed, even in the user's project
// copy ("prévia gratuita", "tráfego pago", "Aceitamos ... crédito"): an ambiguous occurrence is
// masked, not kept — the mask beats literal fidelity. Code identifiers that contain a word are out
// of reach already: \b never matches inside camelCase or snake_case ("limiteTokens", "cota_maxima"),
// and the base64 guard below keeps image data intact.
const EXPORT_MASK_TIER_QUOTA =
  /\b(grátis|gratis|gratuit[oa]s?|pag[oa]s?|cotas?|créditos?|creditos?|limites?)\b/gi

// A base64 run of 64 or more is image data, not prose: real image blobs in exports run to tens of KB,
// while the longest path that carries a model word measured 52 chars. The guard applies to the slug,
// bare-word and tier/quota rules — "opencode" itself is never inside image data and must reach zero
// occurrences.
const EXPORT_MASK_BASE64_RUN = 64

const EXPORT_MASK_BASE64_CHAR = /[A-Za-z0-9+/=]/

/**
 * Scrubs the masked vocabulary out of one string. Order matters: the Go error first (it contains
 * "OpenCode Go", which the later opencode rule would otherwise rewrite), then the Go console link,
 * then the provider/model slugs (before "opencode" so "opencode/mimo-..." becomes one "Automático"),
 * then "opencode-go" before "opencode" (else it becomes "editor-go"), then the bare model and
 * provider words, then the tier and quota words last (they never overlap the earlier rules, so they
 * only catch what is left). Left alone on purpose: bare "Google" as a search engine and the company
 * name "ManosTech".
 */
function scrubExportText(value: string): string {
  return value
    .replace(EXPORT_MASK_GO_ERROR, EXPORT_MASK_GENERIC)
    .replace(EXPORT_MASK_GO_SENTENCE, EXPORT_MASK_GENERIC)
    .replace(EXPORT_MASK_GO_LINK, EXPORT_MASK_MODEL)
    .replace(EXPORT_MASK_SLUG, scrubExportSlug)
    .replace(EXPORT_MASK_OPENCODE_GO, EXPORT_MASK_MODEL)
    .replace(EXPORT_MASK_OPENCODE, scrubExportOpencode)
    .replace(EXPORT_MASK_BARE, scrubExportBare)
    .replace(EXPORT_MASK_TIER_QUOTA, scrubExportTierQuota)
}

// "opencode" becomes the product's short name, keeping the case the text used so paths, commands and
// identifiers keep their shape: "~/.opencode/skills" reads "~/.editor/skills", "tentarOpenCode" reads
// "tentarEditor". The full name would break those.
function scrubExportOpencode(match: string): string {
  if (match === "OPENCODE") return "EDITOR"

  if (match.startsWith("O")) return "Editor"

  return "editor"
}

// The replacer only guards image data and keeps a sentence-final period the pattern may have swallowed
// ("...claude-sonnet-5.5." stays punctuated). A match the pattern caught but is not a model — a dashed
// directory name under a provider path — is left alone so the later opencode rule can rewrite it as a
// path instead.
function scrubExportSlug(
  match: string,
  _segment: string | undefined,
  last: string,
  offset: number,
  value: string,
): string {
  if (!isModelSlug(last)) return match

  if (isInsideBase64Run(value, offset, match.length)) return match

  if (match.endsWith(".")) return `${EXPORT_MASK_MODEL}.`

  return EXPORT_MASK_MODEL
}

function isModelSlug(last: string): boolean {
  const lower = last.toLowerCase()

  if (lower === "free" || lower === "auto" || /^v\d/i.test(last)) return true

  if (!last.includes("-") && !last.includes(":")) return false

  if (lower.endsWith(":free")) return true

  // A dashed segment is a model id when it carries a version number ("claude-sonnet-5.5") or starts
  // with a known model family ("beam-free", "crouton-alpha"); a dashed directory name such as
  // "previas-test" in a file path is not.
  return (
    /\d/.test(last) || EXPORT_MASK_BARE_FAMILIES.some((family) => lower.startsWith(family))
  )
}

function scrubExportBare(match: string, offset: number, value: string): string {
  if (isInsideBase64Run(value, offset, match.length)) return match

  return EXPORT_MASK_MODEL
}

function scrubExportTierQuota(match: string, offset: number, value: string): string {
  if (isInsideBase64Run(value, offset, match.length)) return match

  const lower = match.toLowerCase()

  if (["cota", "cotas", "limite", "limites"].includes(lower)) return "uso"

  if (["crédito", "créditos", "credito", "creditos"].includes(lower)) return "saldo"

  return EXPORT_MASK_MODEL
}

function isInsideBase64Run(value: string, offset: number, length: number): boolean {
  return (
    base64RunLength(value, offset - 1, -1) + base64RunLength(value, offset + length, 1) >=
    EXPORT_MASK_BASE64_RUN
  )
}

function base64RunLength(value: string, start: number, step: -1 | 1): number {
  let length = 0

  for (let index = start; index >= 0 && index < value.length; index += step) {
    if (!EXPORT_MASK_BASE64_CHAR.test(value.charAt(index))) break
    length += 1
  }

  return length
}

function sanitizeSessionExportMessage(message: SessionMessageInfo): SessionExportMessageInfo[] {
  // A model switch is metadata of a hop, not conversation — same as the history package.
  if (message.type === "model-switched") return []

  const metadata = withoutModelKey(message.metadata)
  const stripped = metadata === message.metadata ? message : { ...message, metadata }

  switch (stripped.type) {
    case "assistant": {
      const { model: _model, cost: _cost, ...rest } = stripped

      return [rest]
    }

    case "compaction": {
      if (stripped.status === "completed") {
        const { model: _model, cost: _cost, ...rest } = stripped

        return [rest]
      }

      if (stripped.status === "failed") {
        const { cost: _cost, ...rest } = stripped

        return [rest]
      }

      return [stripped]
    }

    default:
      return [stripped]
  }
}

/**
 * User messages remember which model answered in their metadata; drop that key, keep the rest. Returns the
 * same dict when there is nothing to drop, so untouched messages keep their identity.
 */
function withoutModelKey(
  metadata: { [x: string]: JsonValue } | undefined,
): { [x: string]: JsonValue } | undefined {
  if (!metadata || !("model" in metadata)) return metadata

  const { model: _model, ...rest } = metadata

  return rest
}

/** Bounds each request rather than the whole export, so a long history still exports. */
export const EXPORT_REQUEST_TIMEOUT_MS = 60_000

export async function fetchSessionExport(input: {
  sessionID: string
  api: Pick<OpenCodeClient, "session" | "message">
  signal?: AbortSignal
}): Promise<SessionExportData> {
  const signal = () =>
    input.signal
      ? AbortSignal.any([input.signal, AbortSignal.timeout(EXPORT_REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(EXPORT_REQUEST_TIMEOUT_MS)

  const [info, first] = await Promise.all([
    input.api.session.get({ sessionID: input.sessionID }, { signal: signal() }),
    input.api.message.list({ sessionID: input.sessionID, limit: 200, order: "asc" }, { signal: signal() }),
  ])

  const pages = [first]

  while (pages.at(-1)?.cursor.next) {
    pages.push(
      await input.api.message.list(
        {
          sessionID: input.sessionID,
          limit: 200,
          cursor: pages.at(-1)!.cursor.next ?? undefined,
        },
        { signal: signal() },
      ),
    )
  }

  // The export leaves the app already masked: no model, no cost, no model switch.
  return sanitizeSessionExport({
    info,
    messages: pages.flatMap((page) => page.data),
  })
}

export function sessionExportFilename(session: { id: string; title?: string; slug?: string }) {
  const name = session.title || session.slug || session.id

  const clean = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .slice(0, 250)
    .replace(/^-+|-+$/g, "")

  return `${clean || session.id}.json`
}
