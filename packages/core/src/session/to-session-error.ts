import { AIError, ToolFailure, type FinishReasonDetails } from "@opencode/ai/effect"
import { Tool } from "@opencode/schema/tool"
import { SessionError } from "@opencode/schema/session-error"
import { MASKED_GENERIC_ERROR, maskToolErrorText } from "@opencode/util/mask"
import { Permission } from "../permission.js"
import { Integration } from "../integration.js"
import { AgentNotFoundError, StepFailedError } from "./error.js"
import { ModelResolver } from "../model-resolver.js"
import { ModelRetry } from "../model-retry.js"
import { SessionRouter } from "./router.js"
import { SessionRunnerModel } from "./runner/model.js"

const tokenSharingMessages = {
  subscription_sharing_user_not_eligible:
    "ChatGPT token sharing isn't available for this account. Connect with an API key or choose another provider.",
  subscription_sharing_usage_limit_exceeded:
    "ChatGPT usage limit reached. Check ChatGPT Settings → Usage for details.",
  subscription_sharing_usage_unavailable: "ChatGPT usage can't be checked right now. Try again later.",
  subscription_sharing_unsupported_capability:
    "This request uses a feature ChatGPT token sharing doesn't support. Remove the unsupported feature and try again.",
  subscription_sharing_route_not_supported:
    "ChatGPT token sharing doesn't support this API route. Check the configured endpoint and HTTP method.",
  subscription_sharing_invalid_user: "This ChatGPT connection is no longer valid. Reconnect to ChatGPT.",
  subscription_sharing_user_unavailable: "Your ChatGPT account is temporarily unavailable. Try again later.",
  chatpass_v2_scope_not_authorized:
    "This ChatGPT connection isn't authorized for this request. Reconnect to ChatGPT or choose another connection.",
  chatpass_v2_invalid_authorization_context:
    "This ChatGPT connection isn't authorized for this request. Reconnect to ChatGPT or choose another connection.",
}

/**
 * ManosTech: provider errors never reach the user with the provider's own
 * words. The raw message can name the model, its tier, or its limits
 * ("free tier quota for model X", "rate limit for ..."), and the timeline
 * renders it verbatim — as do tool results that carry a mapped failure.
 * Every type gets one short generic message in pt-BR; the type, HTTP
 * status, and retry delay stay, because the retry logic and the timeline
 * need them. The raw body is kept only as data (the ChatGPT plugin reads
 * it to veto retries of token-sharing codes); no surface renders it.
 * The ChatGPT connection messages below stay: they talk about the user's
 * own connection, not about which AI is answering.
 */
const GENERIC_PROVIDER_MESSAGES: Record<string, string> = {
  "provider.rate-limit": "O serviço está ocupado no momento. Tente novamente em instantes.",
  "provider.auth": "A chave de acesso não foi aceita. Confira a conexão nas Configurações.",
  "provider.content-filter": "O conteúdo foi recusado pelo filtro de segurança.",
  "provider.transport": "Não foi possível alcançar o servidor. Verifique a conexão com a internet.",
  "provider.internal": "O serviço falhou. Tente novamente.",
  "provider.invalid-output": "A resposta veio incompleta. Tente novamente.",
  "provider.invalid-request": "O pedido não pôde ser enviado. Tente reformular.",
  "provider.unsupported-operation": "Esta operação não é suportada.",
  "provider.unknown": "O serviço não respondeu como esperado. Tente novamente.",
  "provider.timeout": "O serviço demorou demais para responder. Tente novamente.",
}

const GENERIC_UNKNOWN_MESSAGE = "Algo deu errado. Tente novamente."

/**
 * ManosTech router: every quota/limit refusal collapses into one generic
 * exhaustion error. The router hops to the next connected model on this
 * type; only when the whole chain is exhausted does the user see the
 * message — with no provider, model, tier, or reset time attached.
 * Nothing here may name what ran out. The response body stays off,
 * except on the ChatGPT token-sharing path below, where the retry hook
 * reads it as data (no surface renders it).
 */
const EXHAUSTED: SessionError.Error = { type: "provider.exhausted", message: MASKED_GENERIC_ERROR }

/**
 * ManosTech router: a prompt the model cannot hold is a capacity failure,
 * not a bad request — the runner hops to a bigger model instead of failing
 * the turn. The message stays the same generic one as exhaustion: the user
 * never sees which model failed or why the chain moved.
 */
const CONTEXT_TOO_LONG: SessionError.Error = {
  type: SessionRouter.CONTEXT_OVERFLOW_TYPE,
  message: "Tente novamente mais tarde.",
}

/**
 * ManosTech gateway: the client's own key expired mid-session (the
 * gateway answers 401 with code `chave_expirada` when the monthly key
 * cycle turned over). This is not a provider failure and not a hop
 * signal: every gateway model shares the same client key, so another
 * model would fail the same way, and no backoff heals a dead key. The
 * turn ends at once with this error itself — never folded into the
 * generic exhaustion message — so the timeline can tell the user what
 * happened and what to do: the app renews the key on its own (the
 * account gate revalidates the session), so sending the message again
 * is enough. The message names no code, key, provider, or model.
 */
const KEY_EXPIRED_MESSAGE = "Sua sessão expirou. Envie sua mensagem novamente em instantes."

function hasKeyExpiredSignal(cause: AIError): boolean {
  const text = [cause.message, cause.reason.body].filter((part) => part !== undefined).join("\n").toLowerCase()
  return text.includes("chave_expirada")
}

/**
 * ManosTech router: a limit refusal does not always arrive classified as
 * one. The classifier only recognizes the exact `FreeUsageLimitError` /
 * `GoUsageLimitError` / `BudgetLimitError` codes and a few quota phrases,
 * so a refusal worded as a plain rate limit — or a 401/403 from a gateway
 * guarding a cap — reaches the runner as a throttle or an auth error, and
 * the runner retries the same model until the turn dies instead of hopping.
 * Any refusal whose code, message, or body names a cap is exhaustion, no
 * matter which reason it was classified under. A plain throttle ("rate
 * limit", "too many requests") carries no cap signal and keeps its retry.
 */
const QUOTA_CODES: ReadonlySet<string> = new Set([
  "freeusagelimiterror",
  "freeusagelimit",
  "gousagelimiterror",
  "gousagelimit",
  "budgetlimiterror",
  "budgetlimit",
  "creditlimitexceeded",
  "insufficientquota",
  "insufficientbalance",
  "quotaexceeded",
  "usagelimitexceeded",
  "usagelimit",
  "monthlylimitexceeded",
  "dailylimitexceeded",
  "spendinglimitexceeded",
  "tokenlimitexceeded",
  "freequotaexceeded",
  "freelimitexceeded",
  "planquotaexceeded",
  // ManosTech gateway caps, as the gateway names them (403): the daily
  // and monthly plan limits. Never `teste_expirado`: the trial block is
  // a session state, handled by the session layer, not a hop signal.
  "limitediarioatingido",
  "limitemensalatingido",
  // A provider that refuses for lack of credit, however it words the code.
  "insufficientcredits",
  "insufficientcredit",
  "creditbalancetoolow",
])

const QUOTA_TEXT: readonly string[] = [
  "free usage limit",
  "free message",
  "free limit",
  "free quota",
  "usage limit",
  "quota exceeded",
  "quota exhausted",
  "quota reached",
  "exceeded your quota",
  "quota limit",
  "budget exceeded",
  "budget limit",
  "limit exhausted",
  "out of credits",
  "no credits",
  "credits exhausted",
  "credit limit",
  "monthly limit",
  "daily limit",
  "spending limit",
  "token budget",
  // The gateway names its caps in the error body (`limite_diario_atingido`,
  // `limite_mensal_atingido`); a provider may also word the cap in pt-BR.
  "limite_diario_atingido",
  "limite_mensal_atingido",
  "limite diário",
  "limite mensal",
  "limite diário excedido",
  "cota excedida",
  // A refusal for lack of credit, however the provider words it.
  "insufficient credit",
  "credit balance is too low",
  "credit balance too low",
  "no credit balance",
  "out of credit",
]

function hasQuotaSignal(cause: AIError): boolean {
  const code = cause.code?.toLowerCase().replace(/[^a-z0-9]/g, "")
  if (code !== undefined && QUOTA_CODES.has(code)) return true
  const text = [cause.message, cause.reason.body].filter((part) => part !== undefined).join("\n").toLowerCase()
  return QUOTA_TEXT.some((signal) => text.includes(signal))
}

export function toSessionError(cause: unknown): SessionError.Error {
  if (cause instanceof AIError) {
    // ChatGPT's usage limit arrives in HTTP and stream errors alike, whatever their reason, so its code decides the type.
    // The retry hook reads the body to veto retries of token-sharing codes, so it rides along as data.
    if (cause.reason.body?.includes("subscription_sharing_usage_limit_exceeded"))
      return { ...EXHAUSTED, response: { body: cause.reason.body } }
    // The ManosTech gateway's expired client key: its own type, so the
    // runner ends the turn with it instead of hopping or retrying — and
    // the raw body stays off, because it carries the gateway's own code.
    // No status either: the error is the whole message, like exhaustion.
    if (hasKeyExpiredSignal(cause))
      return { type: "provider.key-expired", message: KEY_EXPIRED_MESSAGE }
    if (hasQuotaSignal(cause)) return EXHAUSTED
    if (cause.reason._tag === "InvalidRequest" && cause.reason.classification === "context-overflow")
      return {
        ...CONTEXT_TOO_LONG,
        ...(cause.reason.http?.status === undefined ? {} : { status: cause.reason.http.status }),
        ...(cause.reason.body === undefined ? {} : { response: { body: cause.reason.body } }),
      }
    switch (cause.reason._tag) {
      case "RateLimit":
        return providerError("provider.rate-limit", cause.reason)
      case "Authentication":
        return providerError("provider.auth", cause.reason)
      case "QuotaExceeded":
        return EXHAUSTED
      case "ContentPolicy":
        return providerError("provider.content-filter", cause.reason)
      case "Transport":
        if (ModelRetry.isUnreachable(cause)) return unreachable(cause.reason)
        return providerError("provider.transport", cause.reason)
      case "ProviderInternal":
        return providerError("provider.internal", cause.reason)
      case "InvalidProviderOutput":
        return providerError("provider.invalid-output", cause.reason)
      case "InvalidRequest":
        return providerError("provider.invalid-request", cause.reason)
      case "UnsupportedOperation":
        return providerError("provider.unsupported-operation", cause.reason)
      case "UnknownProvider":
        return providerError("provider.unknown", cause.reason)
      case "Timeout":
        return providerError("provider.timeout", cause.reason)
      default: {
        const exhaustive: never = cause.reason
        return exhaustive
      }
    }
  }
  if (cause instanceof Permission.BlockedError) return { type: "permission.rejected", message: cause.message }
  if (cause instanceof Permission.CorrectedError) return { type: "permission.rejected", message: cause.feedback }
  if (cause instanceof ToolFailure || cause instanceof Tool.Error) {
    // ManosTech masking: a tool failure with no nested error used to pass
    // its message through verbatim, so a provider refusal the tool surfaced
    // ("User not found", a quota line, a Go signature) reached the model
    // and the timeline with the provider's own words — and the model then
    // narrated them. A provider-flavored message becomes the single
    // generic sentence; anything else keeps its cause with only the
    // masked vocabulary scrubbed out.
    if (cause.error === undefined)
      return { type: "tool.execution", message: maskToolErrorText(cause.message) }
    // The canonical error is the sole model-visible representation, so a cause
    // with no message must not erase the tool's curated failure message.
    const unwrapped = toSessionError(cause.error)
    return unwrapped.message === "" ? { ...unwrapped, type: "tool.execution", message: cause.message } : unwrapped
  }
  // A step failure can carry an already-typed session error (an older
  // server, a stored message). A limit type inside it is exhaustion, not
  // the limit's own message — otherwise the free-limit line survives.
  if (cause instanceof StepFailedError)
    return SessionRouter.isExhaustionError(cause.error) ? EXHAUSTED : cause.error
  if (cause instanceof ModelResolver.UnsupportedCompactionError)
    return { type: "provider.unsupported-operation", message: cause.message }
  if (cause instanceof AgentNotFoundError) return { type: "unknown", message: cause.message }
  if (
    cause instanceof SessionRunnerModel.ModelNotSelectedError ||
    cause instanceof SessionRunnerModel.ModelUnavailableError ||
    cause instanceof ModelResolver.VariantUnavailableError ||
    cause instanceof ModelResolver.UnsupportedPackageError ||
    cause instanceof ModelResolver.ModelConfigurationError ||
    cause instanceof ModelResolver.ModelInitializationError ||
    cause instanceof ModelResolver.UnresolvedProviderVariablesError
  )
    return { type: "provider.no-route", message: cause.message }
  if (cause instanceof Integration.AuthorizationError) return { type: "provider.auth", message: cause.message }
  // ManosTech: internal failures pass through here unchanged (instruction
  // sources, tool defects, programming errors) — they name no model,
  // provider, tier, or quota, and the user needs the actual cause.
  // Provider failures never reach this branch: they arrive as AIError and
  // are genericized above. The mask is still applied, because a plain
  // Error can carry a provider refusal the classifier never saw ("User
  // not found" from a tool): a message with no provider flavor or masked
  // vocabulary passes through byte-for-byte.
  return {
    type: "unknown",
    message: cause instanceof Error ? maskToolErrorText(cause.message) : maskToolErrorText(String(cause)),
  }
}

export function contentFilterError(summary: string, reason: FinishReasonDetails): SessionError.Error {
  return {
    type: "provider.content-filter",
    message: [reason.category === undefined ? summary : `${summary} (${reason.category})`, reason.explanation]
      .filter(Boolean)
      .join(": "),
  }
}

// Names the network as the problem, so a DNS outage doesn't read like a broken model or provider —
// without naming the host (it can be a provider domain) or quoting the provider's own message.
function unreachable(reason: AIError["reason"]): SessionError.Error {
  return {
    ...providerError("provider.transport", reason),
    message: GENERIC_PROVIDER_MESSAGES["provider.transport"]!,
  }
}

function providerError(type: string, reason: AIError["reason"]): SessionError.Error {
  const status = reason.http?.status
  const retryAfterMs = "retryAfterMs" in reason ? reason.retryAfterMs : undefined
  return {
    type,
    message:
      Object.entries(tokenSharingMessages).find(([code]) => reason.body?.includes(code))?.[1] ??
      GENERIC_PROVIDER_MESSAGES[type] ??
      GENERIC_UNKNOWN_MESSAGE,
    ...(status === undefined ? {} : { status }),
    ...(reason.body === undefined ? {} : { response: { body: reason.body } }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  }
}
