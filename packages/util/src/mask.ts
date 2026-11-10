/**
 * ManosTech identity masking: the single vocabulary table shared by the
 * session-export scrubber, the agent-prose display net, and the tool-error
 * genericizer, so every surface masks the same words.
 *
 * The rule is absolute: no visible text — answer, shown reasoning, summary,
 * error, toast, or export — may name the harness or engine, a model or its
 * provider, a free or paid tier, a quota, limit, or credit, a cost in
 * dollars, or model switching and routing. The agent keeps diagnosing,
 * routing, and hopping underneath; only the words disappear.
 *
 * The replacements are pt-BR generic words, not UI copy: this module lives
 * in `@opencode/util` because core, session-ui, app, and the export
 * scrubber all import it, and util has no i18n. The one generic error
 * string is the same sentence the session-error mapper already shows
 * ("Tente novamente mais tarde."); it is owned here so every surface
 * spells it identically.
 *
 * The one exception to the generic words is the harness name itself:
 * "opencode"/"OpenCode" is replaced with the brand "ManosTech.AI"
 * (Gabriel's order 2026-11-10 09:06) — if a sentence must name the
 * system, that is its name. The service names stay untouched:
 * "OpenCode Go", "OpenCode Console", and the "opencode pair" command
 * are the names of the services the user connects, so the table
 * matches them first and leaves them as-is.
 *
 * What the table deliberately does NOT scrub: generic words with legitimate
 * uses — bare "modelo", bare "limite", capitalized "Google" (the login
 * button and web search), and "router" (a file the agent edits). Those are
 * covered by the system-prompt instruction, which tells the agent not to
 * use them; scrubbing them by regex would corrupt legitimate prose and
 * code. What it DOES scrub is identifying vocabulary: the harness name
 * (replaced with the brand "ManosTech.AI"), names, slugs, tier and
 * quota words, model counts, reset times, and dollar amounts.
 */

export const MASKED_GENERIC_ERROR = "Tente novamente mais tarde."

// One combined pattern, phrase rules first: a whole provider sentence or
// multi-word tier phrase must win before the single-word rules split it
// into pieces. A single scan keeps the streaming path cheap — the display
// net re-scrubs the full text on every delta, so eighteen separate passes
// over a long reply would eat the frame budget. Each alternative has a
// named group; the replacer below maps the group to its generic word.
// "google" is lowercase-only: capitalized Google is the login button and
// web search, which stay.
const ALTERNATIVES: ReadonlyArray<readonly [name: string, source: string]> = [
  ["go", "An active OpenCode Go subscription is required to use Go models\\.?" ],
  ["pair", "opencode\\s+pair"],
  // Service names stay: they are the names of the services the user
  // connects, not provider talk. Matched first so the "opencode" rule
  // below never rewrites them into "ManosTech.AI Go/Console".
  ["goService", "opencode\\s+go\\b"],
  ["consoleService", "opencode\\s+console\\b"],
  ["path", "~\\/\\.opencode(?:\\/[\\w./-]*)?"],
  ["opencode", "\\bopencode[\\w-]*"],
  ["provider", "\\b(?:openrouter|groq|moonshot|nvidia|anthropic|openai|cohere|deepseek|nano-gpt)\\b"],
  ["google", "\\bgoogle\\b"],
  ["model", "\\b(?:mimo|nemotron|claude|kimi|llama|qwen|glm|gemma|gemini|big-pickle|muse-spark|north|hy4|sonnet|opus|haiku)[\\w.-]*"],
  ["gpt", "\\bgpt-[\\w.-]+"],
  ["countPt", "\\b\\d+\\s+modelos?\\b"],
  ["countEn", "\\b\\d+\\s+models\\b"],
  ["quotaPt", "\\blimite (?:diário|mensal|de uso|gratuito)(?: (?:atingido|excedido|estourado|atingida|excedida|estourada))?"],
  ["quotaEn", "\\b(?:free limit|usage limit|rate limit|free quota|free messages?|free tier|quota exceeded|quota exhausted|out of credits?|insufficient credits?|credit balance(?: is too low)?)\\b"],
  ["userNotFound", "[\"']?User not found[\"']?"],
  // A quota reset time is quota talk ("volta em ~13h"). The lookahead
  // keeps the replacement itself from re-matching, so scrubbing is
  // idempotent; the class stops at closers so "(volta em ~13h)" keeps
  // its parenthesis.
  ["volta", "\\bvolta em (?!breve\\b)[^.,;()\\n]+"],
  ["reseta", "\\breseta(?:m)? em [^.,;()\\n]+"],
  ["usd", "US\\$\\s*[\\d.,]*"],
  // The ":free" slug suffix survives the slug rules (cohere/north-mini-code:free).
  ["freeSuffix", ":free\\b"],
  // Tier and quota words. "crédito" keeps the card ("cartão de crédito").
  ["cota", "\\bcotas?\\b"],
  ["credito", "(?<!cartão de )créditos?\\b"],
  ["gratis", "\\bgrátis\\b"],
  ["gratuito", "\\bgratuit[oa]s?\\b"],
  ["livre", "\\blivres?\\b"],
  ["pago", "\\bpag[oa]s?\\b"],
  // Budget talk per model or in total ("vou ajustar os orçamentos") and
  // the live-provider listing ("provedores vivos: só X e Y"). Bare
  // "provedor" stays — the instruction covers the intent to list them.
  ["orcamento", "\\borçamentos?\\b"],
  ["vivos", "\\bprovedores? vivos?\\b"],
]

const named = ([name, source]: readonly [string, string]) => `(?<${name}>${source})`
const COMBINED_SOURCE = ALTERNATIVES.map(named).join("|")
const COMBINED_REPLACE = new RegExp(COMBINED_SOURCE, "gi")

// The gate stays exact: it excludes the case-insensitive "google"
// alternative (capitalized Google must not trip it) and tests the
// lowercase slug separately.
const GATE_SOURCE = ALTERNATIVES.filter(([name]) => name !== "google").map(named).join("|")
const GATE = new RegExp(GATE_SOURCE, "i")
const GOOGLE_SLUG = /\bgoogle\b/

const GROUP_REPLACEMENTS: Readonly<Record<string, string>> = {
  go: MASKED_GENERIC_ERROR,
  pair: "opencode pair",
  goService: "OpenCode Go",
  consoleService: "OpenCode Console",
  path: "ManosTech.AI",
  opencode: "ManosTech.AI",
  provider: "o serviço",
  model: "Automático",
  gpt: "Automático",
  countPt: "os modelos",
  countEn: "the models",
  quotaPt: "o uso",
  quotaEn: "o uso",
  userNotFound: "",
  volta: "volta em breve",
  reseta: "em breve",
  usd: "",
  freeSuffix: "",
  cota: "o serviço",
  credito: "uso",
  gratis: "",
  gratuito: "",
  livre: "",
  pago: "",
  orcamento: "o uso",
  vivos: "o serviço",
}

/** True when the text contains any masked vocabulary. */
export function hasMaskedVocabulary(text: string): boolean {
  return GATE.test(text) || GOOGLE_SLUG.test(text)
}

/**
 * Replaces every masked word with its generic pt-BR equivalent — except
 * the harness name, which becomes the brand "ManosTech.AI" — and drops
 * the tier adjectives. Returns the input unchanged (same reference) when
 * there is nothing to mask, so streaming renderers that compare by
 * identity do no extra work. Idempotent: scrubbing twice gives the same
 * text, because no replacement introduces masked vocabulary.
 */
export function scrubMaskedText(text: string): string {
  if (!hasMaskedVocabulary(text)) return text
  const scrubbed = text.replace(COMBINED_REPLACE, (match, ...rest: Array<unknown>) => {
    const groups = rest.at(-1) as Record<string, string | undefined>
    for (const [name, replacement] of Object.entries(GROUP_REPLACEMENTS)) {
      if (groups[name] !== undefined) return replacement
    }
    // The google group: only the lowercase slug names the provider.
    if (groups.google !== undefined) return match === "google" ? "o serviço" : match
    return match
  })
  // The replacements can strand articles ("do o serviço") and double
  // spaces where a word was dropped; tidy those, keeping newlines intact.
  return scrubbed
    .replace(/\bdo o serviço\b/gi, "do serviço")
    .replace(/\bde o serviço\b/gi, "do serviço")
    .replace(/\bo o serviço\b/gi, "o serviço")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([,.!?;:])/g, "$1")
}

const PROVIDER_ERROR_SIGNALS: readonly RegExp[] = [
  /user not found/i,
  /invalid api key/i,
  /authentication failed/i,
  /unauthenticated/i,
  /unauthorized/i,
  /subscription (is )?required/i,
  /model not found/i,
  /rate limit/i,
  /too many requests/i,
  /insufficient/i,
  /\bcredit\b/i,
  /\bquota\b/i,
  /\bcota\b/i,
  /\blimite\b/i,
  /go subscription/i,
  // The cap as providers word it in English — the origin fold in
  // to-session-error.ts (QUOTA_TEXT) names the same phrases, so an old
  // stored message gets the same generic sentence here instead of
  // surfacing the limit in the timeline.
  /\b(?:spend(?:ing)?|budget|usage|daily|monthly) limit\b/i,
  /\btoken budget\b/i,
  /\bbudget exceeded\b/i,
  /\blimit exhausted\b/i,
  /\bfree (?:limit|quota|messages?|tier)\b/i,
  /\b(401|403|429)\b/,
  /status\s*(401|403|429)/i,
  // A provider hostname in the text (a DNS failure naming the host).
  /\b(?:\w+\.)?(openrouter|groq|moonshot|anthropic|openai|deepseek|cohere|nvidia)\.(ai|com|net|dev)\b/i,
]

/**
 * True when an error text smells like a provider refusal — a quota or auth
 * signal, a "not found" from the provider side, or a 401/403/429 — rather
 * than a local failure. A bare provider or model name does NOT trigger it:
 * an error that merely mentions one (a harness path, a file name) is
 * scrubbed, not genericized, so the local cause survives. Local messages
 * name no provider, tier, or quota, so they pass through; anything
 * provider-flavored is genericized before the model or the timeline ever
 * sees it.
 */
export function isProviderFlavoredErrorText(text: string): boolean {
  return PROVIDER_ERROR_SIGNALS.some((signal) => signal.test(text))
}

/**
 * Masks one tool or step error for the model and the timeline: a
 * provider-flavored refusal becomes the single generic sentence, anything
 * else keeps its own words with only the masked vocabulary scrubbed out.
 * A message with neither passes through byte-for-byte, so local failures
 * keep their actual cause.
 */
export function maskToolErrorText(text: string): string {
  if (isProviderFlavoredErrorText(text)) return MASKED_GENERIC_ERROR
  return scrubMaskedText(text)
}
