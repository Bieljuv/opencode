import { describe, expect, test } from "bun:test"
import {
  AuthenticationError,
  ContentPolicyError,
  InvalidProviderOutputError,
  InvalidRequestError,
  UnsupportedOperationError,
  AIError,
  ProviderID,
  ProviderInternalError,
  QuotaExceededError,
  RateLimitError,
  TransportError,
  UnknownProviderError,
  ToolFailure,
  HttpContext,
} from "@opencode/ai/effect"
import { RequestExecutor } from "@opencode/ai/route"
import { Permission } from "@opencode/core/permission"
import { ID } from "@opencode/core/model"
import { ModelResolver } from "@opencode/core/model-resolver"
import { Provider } from "@opencode/core/provider"
import { Tool } from "@opencode/schema/tool"
import { toSessionError } from "@opencode/core/session/to-session-error"
import { SessionRunnerRetry } from "@opencode/core/session/runner/retry"
import { StepFailedError } from "@opencode/core/session/error"

const llm = (reason: AIError["reason"]) => new AIError({ reason })

describe("toSessionError", () => {
  test("maps every AI error reason to the open wire type", () => {
    expect(toSessionError(llm(new RateLimitError({ message: "rate", retryAfterMs: 123 })))).toEqual({
      type: "provider.rate-limit",
      message: "O serviço está ocupado no momento. Tente novamente em instantes.",
      retryAfterMs: 123,
    })
    expect(toSessionError(llm(new AuthenticationError({ message: "auth" }))).type).toBe("provider.auth")
    expect(toSessionError(llm(new QuotaExceededError({ message: "quota", retryAfterMs: 456 })))).toEqual({
      type: "provider.exhausted",
      message: "Tente novamente mais tarde.",
    })
    expect(toSessionError(llm(new ContentPolicyError({ message: "blocked" }))).type).toBe("provider.content-filter")
    expect(
      toSessionError(llm(new TransportError({ message: "transport", transport: "http", operation: "request" }))).type,
    ).toBe("provider.transport")
    expect(toSessionError(llm(new ProviderInternalError({ message: "internal", retryAfterMs: 789 })))).toEqual({
      type: "provider.internal",
      message: "O serviço falhou. Tente novamente.",
      retryAfterMs: 789,
    })
    expect(toSessionError(llm(new InvalidProviderOutputError({ message: "output" }))).type).toBe(
      "provider.invalid-output",
    )
    expect(toSessionError(llm(new InvalidRequestError({ message: "request" }))).type).toBe("provider.invalid-request")
    expect(
      toSessionError(
        llm(
          new UnsupportedOperationError({
            message: "no compact endpoint",
            operation: "compact",
            provider: ProviderID.make("provider"),
            route: "route",
          }),
        ),
      ),
    ).toEqual({ type: "provider.unsupported-operation", message: "Esta operação não é suportada." })
    expect(toSessionError(llm(new UnknownProviderError({ message: "unknown" }))).type).toBe("provider.unknown")
  })

  test("collapses free, Go, and credit limits into one generic exhaustion error", () => {
    const fail = (url: string, body: unknown, headers?: Record<string, string>) =>
      RequestExecutor.httpFailure({
        message: "Rate limit exceeded. Please try again later.",
        url,
        status: 429,
        responseHeaders: headers,
        responseBody: JSON.stringify(body),
      })

    const freeBody = {
      type: "error",
      error: { type: "FreeUsageLimitError", message: "Rate limit exceeded. Please try again later." },
    }
    const free = fail("https://opencode.ai/inference/openai/v1/chat/completions", freeBody, { "retry-after": "3600" })
    expect(SessionRunnerRetry.isRetryable(free)).toBe(false)
    expect(toSessionError(free)).toEqual({
      type: "provider.exhausted",
      message: "Tente novamente mais tarde.",
    })

    const paid = fail(
      "https://opencode.ai/inference/openai/v1/chat/completions",
      { error: { type: "server_error", message: "Upstream request failed: Rate limit exceeded." } },
      { "retry-after": "45" },
    )
    expect(SessionRunnerRetry.isRetryable(paid)).toBe(true)
    expect(toSessionError(paid)).toMatchObject({ type: "provider.rate-limit", retryAfterMs: 45_000 })

    const goBody = {
      type: "error",
      error: { type: "GoUsageLimitError", message: "Go usage limit exceeded" },
      metadata: { workspace: "wrk_go_limit", limitName: "5 hour" },
    }
    const go = fail("https://opencode.ai/inference/go/openai/v1/chat/completions", goBody, { "retry-after": "120" })
    expect(SessionRunnerRetry.isRetryable(go)).toBe(false)
    expect(toSessionError(go)).toEqual({
      type: "provider.exhausted",
      message: "Tente novamente mais tarde.",
    })

    const credit = RequestExecutor.httpFailure({
      message: "Credit limit exceeded.",
      url: "https://opencode.ai/inference/openai/v1/chat/completions",
      status: 402,
      responseBody: JSON.stringify({
        type: "error",
        error: { type: "CreditLimitExceeded", message: "Credit limit exceeded." },
      }),
    })
    expect(toSessionError(credit)).toEqual({
      type: "provider.exhausted",
      message: "Tente novamente mais tarde.",
    })

    const other = fail(
      "https://api.openai.com/v1/chat/completions",
      { error: { type: "rate_limit_error", message: "Too many requests" } },
      { "retry-after": "10" },
    )
    expect(SessionRunnerRetry.isRetryable(other)).toBe(true)
    expect(toSessionError(other)).toMatchObject({ type: "provider.rate-limit", retryAfterMs: 10_000 })
  })

  test("collapses limit refusals the classifier misses into the generic exhaustion error", () => {
    const exhausted = { type: "provider.exhausted", message: "Tente novamente mais tarde." }

    // A free-limit refusal worded as a plain rate limit — no
    // FreeUsageLimitError code anywhere — used to reach the runner as a
    // throttle, which retried the same model until the turn died instead
    // of hopping. The cap is in the message, so it is exhaustion.
    const worded = RequestExecutor.httpFailure({
      message: "You have used all your free messages today.",
      url: "https://opencode.ai/inference/openai/v1/chat/completions",
      status: 429,
      responseBody: JSON.stringify({
        error: { type: "rate_limit_error", message: "You have used all your free messages today." },
      }),
    })
    expect(toSessionError(worded)).toEqual(exhausted)

    // Same refusal, underscored code the exact-code match misses.
    const underscored = RequestExecutor.httpFailure({
      message: "Rate limit exceeded. Please try again later.",
      url: "https://opencode.ai/inference/openai/v1/chat/completions",
      status: 429,
      responseBody: JSON.stringify({ error: { type: "free_usage_limit", message: "Rate limit exceeded." } }),
    })
    expect(toSessionError(underscored)).toEqual(exhausted)

    // A gateway guarding a cap with 403: an auth error by status, a quota
    // refusal by content.
    const forbidden = RequestExecutor.httpFailure({
      message: "Free message allowance exhausted for today.",
      url: "https://api.example.com/v1/chat/completions",
      status: 403,
      responseBody: JSON.stringify({ error: { type: "forbidden", message: "Free message allowance exhausted." } }),
    })
    expect(toSessionError(forbidden)).toEqual(exhausted)

    // A plain throttle stays a throttle: no cap signal anywhere.
    const throttle = RequestExecutor.httpFailure({
      message: "Too many requests. Please try again later.",
      url: "https://api.example.com/v1/chat/completions",
      status: 429,
      responseBody: JSON.stringify({ error: { type: "rate_limit_error", message: "Too many requests." } }),
    })
    expect(toSessionError(throttle)).toMatchObject({ type: "provider.rate-limit" })
  })

  test("collapses a limit type carried by a step failure into the generic exhaustion error", () => {
    const free = new StepFailedError({
      error: { type: "provider.free-limit", message: "Free usage limit reached." },
    })
    expect(toSessionError(free)).toEqual({
      type: "provider.exhausted",
      message: "Tente novamente mais tarde.",
    })
    const other = new StepFailedError({
      error: { type: "provider.internal", message: "The service failed." },
    })
    expect(toSessionError(other)).toEqual({ type: "provider.internal", message: "The service failed." })
  })

  test("collapses model and workspace budget limits into one generic exhaustion error", () => {
    const refuse = (body: unknown) =>
      RequestExecutor.httpFailure({
        message: "A budget policy for this model has been reached.",
        url: "https://opencode.ai/inference/openai/v1/chat/completions",
        status: 429,
        responseBody: JSON.stringify(body),
      })
    const modelBody = {
      type: "error",
      error: { type: "BudgetLimitError", message: "A budget policy for this model has been reached." },
      metadata: { coverage: "models", resetsAt: "2026-11-01T00:00:00.000Z" },
    }
    const model = refuse(modelBody)
    expect(SessionRunnerRetry.isRetryable(model)).toBe(false)
    expect(toSessionError(model)).toEqual({
      type: "provider.exhausted",
      message: "Tente novamente mais tarde.",
    })

    // Google clients get Google's envelope, with the same metadata in its ErrorInfo.
    const all = refuse({
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message: "Policy budget exceeded",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "BudgetLimitError",
            domain: "opencode.ai",
            metadata: { coverage: "all", resetsAt: "2026-11-01T00:00:00.000Z" },
          },
        ],
      },
    })
    expect(SessionRunnerRetry.isRetryable(all)).toBe(false)
    expect(toSessionError(all)).toEqual({
      type: "provider.exhausted",
      message: "Tente novamente mais tarde.",
    })
  })

  test("collapses the ChatGPT usage limit whichever way the failure arrives", () => {
    const body = JSON.stringify({ error: { code: "subscription_sharing_usage_limit_exceeded", message: "Limit" } })
    for (const reason of [
      new RateLimitError({ message: "Too many requests", body }),
      new UnknownProviderError({ message: "Request failed", body }),
    ])
      // The body rides along as data: the ChatGPT retry hook reads it to
      // veto retries of token-sharing codes. No surface renders it.
      expect(toSessionError(llm(reason))).toEqual({
        type: "provider.exhausted",
        message: "Tente novamente mais tarde.",
        response: { body },
      })
  })

  test("collapses a ManosTech gateway daily-limit 429 into only the generic message", () => {
    // The gateway answers in pt-BR; the body may name its own internals,
    // so the mapped error must carry none of it — no URL, no key, no
    // model, no provider, no word for the cap.
    const body = JSON.stringify({
      erro: "limite diário excedido",
      reseta_em: "2026-11-10T03:00:00Z",
      detalhe: "manostech/auto",
    })
    const gateway = RequestExecutor.httpFailure({
      message: "limite diário excedido",
      url: "https://painel-manostech.manostech.workers.dev/v1/chat/completions",
      status: 429,
      responseBody: body,
    })

    expect(SessionRunnerRetry.isRetryable(gateway)).toBe(false)
    const mapped = toSessionError(gateway)
    expect(mapped).toEqual({ type: "provider.exhausted", message: "Tente novamente mais tarde." })
    const shown = JSON.stringify(mapped)
    for (const leak of ["painel-manostech", "manostech", "auto", "limite", "cota", "gateway", "reseta_em"])
      expect(shown).not.toContain(leak)
  })

  test("collapses the ManosTech gateway real 403 caps into the generic exhaustion error", () => {
    // The gateway answers a spent daily/monthly plan with 403 and its own
    // code (`limite_diario_atingido` / `limite_mensal_atingido`). By status
    // that is an auth error, and the runner retried the same model until
    // the turn died instead of hopping to the next connected model — the
    // gateway's own live keys (DeepSeek, Moonshot, Nvidia) sat unused.
    const exhausted = { type: "provider.exhausted", message: "Tente novamente mais tarde." }
    for (const code of ["limite_diario_atingido", "limite_mensal_atingido"]) {
      const gateway = RequestExecutor.httpFailure({
        message: "Tente novamente mais tarde.",
        url: "https://painel-manostech.manostech.workers.dev/v1/chat/completions",
        status: 403,
        responseBody: JSON.stringify({
          error: { message: "Tente novamente mais tarde.", type: code, code },
        }),
      })
      expect(toSessionError(gateway)).toEqual(exhausted)
    }
    // The trial block is not a cap to hop from: it stays auth, so the
    // session layer can keep blocking the trial the way it already does.
    const trial = RequestExecutor.httpFailure({
      message: "Tente novamente mais tarde.",
      url: "https://painel-manostech.manostech.workers.dev/v1/chat/completions",
      status: 403,
      responseBody: JSON.stringify({
        error: { message: "Tente novamente mais tarde.", type: "teste_expirado", code: "teste_expirado" },
      }),
    })
    expect(toSessionError(trial)).toMatchObject({ type: "provider.auth" })
  })

  test("maps the ManosTech gateway expired client key to its own error, never the generic one", () => {
    // The gateway answers an expired monthly client key with 401 and its
    // own code (`chave_expirada`). It keeps its own type and message: the
    // runner ends the turn with it (no hop, no retry) and the timeline
    // tells the user to send the message again — the generic exhaustion
    // message would hide that the session expired and that retrying works.
    // The trial block is still auth: only the expired KEY is key-expired.
    const gateway = RequestExecutor.httpFailure({
      message: "A chave expirou. Faça login novamente.",
      url: "https://painel-manostech.manostech.workers.dev/v1/chat/completions",
      status: 401,
      responseBody: JSON.stringify({
        error: { message: "A chave expirou. Faça login novamente.", type: "chave_expirada", code: "chave_expirada" },
      }),
    })
    expect(toSessionError(gateway)).toEqual({
      type: "provider.key-expired",
      message: "Sua sessão expirou. Envie sua mensagem novamente em instantes.",
    })
    const shown = JSON.stringify(toSessionError(gateway))
    for (const leak of ["chave_expirada", "chave", "painel-manostech", "manostech", "gateway", "login"])
      expect(shown).not.toContain(leak)
  })

  test("collapses a credit-balance refusal into the generic exhaustion error", () => {
    // Anthropic refuses a spent account with 400 and an invalid-request
    // type; the runner treated it as a malformed request and never hopped.
    const exhausted = { type: "provider.exhausted", message: "Tente novamente mais tarde." }
    const anthropic = RequestExecutor.httpFailure({
      message: "Your credit balance is too low to access the Anthropic API.",
      url: "https://api.anthropic.com/v1/messages",
      status: 400,
      responseBody: JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Your credit balance is too low to access the Anthropic API.",
        },
      }),
    })
    expect(toSessionError(anthropic)).toEqual(exhausted)
    // OpenRouter refuses with 402 when the account has no credits left.
    const openrouter = RequestExecutor.httpFailure({
      message: "Insufficient credits. Add more credits to your account.",
      url: "https://openrouter.ai/api/v1/chat/completions",
      status: 402,
      responseBody: JSON.stringify({ error: { message: "Insufficient credits.", code: 402 } }),
    })
    expect(toSessionError(openrouter)).toEqual(exhausted)
  })

  test("genericizes a provider-flavored tool failure instead of passing its words through", () => {
    // A tool surfaces the provider's refusal with no nested error — the
    // path the proof hit: the model quoted "User not found" and the quota
    // lines into visible prose.
    for (const message of [
      "User not found",
      "OpenRouter via ponte do OpenCode quebrou (401)",
      "cota grátis estourou",
      "An active OpenCode Go subscription is required to use Go models.",
    ]) {
      expect(toSessionError(new Tool.Error({ message }))).toEqual({
        type: "tool.execution",
        message: "Tente novamente mais tarde.",
      })
      expect(toSessionError(new ToolFailure({ message }))).toEqual({
        type: "tool.execution",
        message: "Tente novamente mais tarde.",
      })
    }
    // A local tool failure keeps its actual cause.
    expect(toSessionError(new Tool.Error({ message: "ENOENT: no such file" }))).toEqual({
      type: "tool.execution",
      message: "ENOENT: no such file",
    })
    // A plain Error carrying a provider refusal is genericized too.
    expect(toSessionError(new Error("User not found"))).toEqual({
      type: "unknown",
      message: "Tente novamente mais tarde.",
    })
  })

  test("preserves the permission rejection type without exposing internal fields", () => {
    const blocked = new Permission.BlockedError({ rules: [], permission: "external_directory", resources: [] })
    expect(toSessionError(blocked)).toEqual({
      type: "permission.rejected",
      message: "Permission denied: external_directory",
    })
    expect(toSessionError(new ToolFailure({ message: blocked.message, error: blocked }))).toEqual({
      type: "permission.rejected",
      message: "Permission denied: external_directory",
    })
    expect(toSessionError(new Tool.Error({ message: "failed" }))).toEqual({
      type: "tool.execution",
      message: "failed",
    })
  })

  test("preserves provider HTTP status without exposing runtime diagnostics", () => {
    const http = new HttpContext({
      url: "https://example.com",
      status: 413,
      headers: { "x-request-id": "request-1" },
    })
    expect(
      toSessionError(
        llm(
          new InvalidRequestError({
            message: "too large",
            classification: "context-overflow",
            parameter: "messages",
            body: '{"error":"context limit"}',
            http,
            cause: new Error("request failed"),
          }),
        ),
      ),
    ).toEqual({
      // A prompt the model cannot hold is a capacity failure, not a bad
      // request: the type hops to a bigger model, while the status and the
      // body (data only, never rendered) are preserved as before.
      type: "provider.context-too-long",
      message: "Tente novamente mais tarde.",
      status: 413,
      response: { body: '{"error":"context limit"}' },
    })
    expect(
      toSessionError(
        llm(
          new ProviderInternalError({
            message: "bad gateway",
            http: new HttpContext({ url: "https://example.com", status: 502, headers: {} }),
          }),
        ),
      ),
    ).toEqual({
      type: "provider.internal",
      message: "O serviço falhou. Tente novamente.",
      status: 502,
    })
  })

  test("preserves provider response body without HTTP status", () => {
    expect(toSessionError(llm(new RateLimitError({ message: "Slow down", body: '{"error":"rate limit"}' })))).toEqual({
      type: "provider.rate-limit",
      message: "O serviço está ocupado no momento. Tente novamente em instantes.",
      response: { body: '{"error":"rate limit"}' },
    })
  })

  test("maps token-sharing failures while preserving HTTP and stream bodies", () => {
    const cases = [
      ["subscription_sharing_user_not_eligible", "token sharing isn't available for this account"],
      ["subscription_sharing_usage_unavailable", "Try again later"],
      ["subscription_sharing_unsupported_capability", "Remove the unsupported feature"],
      ["subscription_sharing_route_not_supported", "Check the configured endpoint"],
      ["subscription_sharing_invalid_user", "Reconnect to ChatGPT"],
      ["subscription_sharing_user_unavailable", "Try again later"],
      ["chatpass_v2_scope_not_authorized", "isn't authorized for this request"],
      ["chatpass_v2_invalid_authorization_context", "isn't authorized for this request"],
    ] as const
    for (const [code, guidance] of cases) {
      for (const body of [
        JSON.stringify({ error: { code, message: "Request failed" } }),
        JSON.stringify({ type: "response.failed", response: { error: { code, message: "Request failed" } } }),
      ]) {
        const error = toSessionError(llm(new UnknownProviderError({ message: "Request failed", body })))
        expect(error.message).toContain(guidance)
        expect(error.response).toEqual({ body })
      }
    }
  })

  test("never leaks the provider's own words into the visible message", () => {
    const leaked = toSessionError(
      llm(
        new RateLimitError({
          message: "Rate limit exceeded for model openrouter/openrouter/free (Free Models Router). Free quota exhausted.",
          retryAfterMs: 60_000,
        }),
      ),
    )
    // "Free quota exhausted" names a cap, not a throttle: the router hops
    // to the next model instead of retrying the same one, so the refusal
    // collapses into the generic exhaustion error — which still leaks
    // nothing (no model, no provider, no tier, no quota).
    expect(leaked).toEqual({
      type: "provider.exhausted",
      message: "Tente novamente mais tarde.",
    })
    expect(leaked.message).not.toContain("openrouter")
    expect(leaked.message).not.toContain("free")
    expect(leaked.message).not.toContain("quota")
  })

  test("names no host when the network is unreachable", () => {
    const error = toSessionError(
      llm(
        new TransportError({
          message: "getaddrinfo ENOTFOUND api.openrouter.ai",
          transport: "http",
          operation: "request",
          code: "ENOTFOUND",
        }),
      ),
    )
    expect(error).toEqual({
      type: "provider.transport",
      message: "Não foi possível alcançar o servidor. Verifique a conexão com a internet.",
    })
    expect(error.message).not.toContain("openrouter")
  })

  test("passes internal failures through unchanged", () => {
    // Internal failures name no model, provider, tier, or quota, and the
    // user needs the actual cause. Provider failures never reach this
    // branch: they arrive as AIError and are genericized above.
    expect(toSessionError(new Error("boom: something internal happened"))).toEqual({
      type: "unknown",
      message: "boom: something internal happened",
    })
    expect(toSessionError("boom")).toEqual({ type: "unknown", message: "boom" })
  })

  test("preserves unresolved provider endpoint errors", () => {
    const error = new ModelResolver.UnresolvedProviderVariablesError({
      providerID: Provider.ID.make("cloudflare-workers-ai"),
      modelID: ID.make("model"),
      variables: ["CLOUDFLARE_ACCOUNT_ID"],
    })
    expect(toSessionError(error)).toEqual({
      type: "provider.no-route",
      message: "CLOUDFLARE_ACCOUNT_ID is required to resolve the provider endpoint",
    })
  })

  test("preserves provider configuration and initialization errors", () => {
    const configuration = new ModelResolver.ModelConfigurationError({
      providerID: Provider.ID.make("azure"),
      modelID: ID.make("gpt-5.4-nano"),
      package: "@opencode/ai/providers/azure/responses",
      detail: "Azure requires resourceName or baseURL",
    })
    expect(toSessionError(configuration)).toEqual({
      type: "provider.no-route",
      message: "Azure requires resourceName or baseURL",
    })
    const initialization = new ModelResolver.ModelInitializationError({
      providerID: Provider.ID.make("custom"),
      modelID: ID.make("model"),
      package: "@opencode/ai/providers/custom",
      phase: "load",
      detail: "Provider package @opencode/ai/providers/custom is broken",
    })
    expect(toSessionError(initialization)).toEqual({
      type: "provider.no-route",
      message: "Provider package @opencode/ai/providers/custom is broken",
    })
  })

  test("retries rate limits, provider-internal, transport, and unrecognized failures", () => {
    const eligible = [
      llm(new RateLimitError({ message: "rate" })),
      llm(new ProviderInternalError({ message: "internal" })),
      llm(new TransportError({ message: "transport", transport: "http", operation: "request" })),
      llm(new UnknownProviderError({ message: "unknown" })),
    ]
    const ineligible = [
      llm(new AuthenticationError({ message: "auth" })),
      llm(new QuotaExceededError({ message: "quota" })),
      llm(new ContentPolicyError({ message: "blocked" })),
      llm(new InvalidProviderOutputError({ message: "output" })),
      llm(new InvalidRequestError({ message: "request" })),
      llm(new UnsupportedOperationError({ message: "unsupported", operation: "compact" })),
    ]

    expect(eligible.map(SessionRunnerRetry.isRetryable)).toEqual([true, true, true, true])
    expect(ineligible.map(SessionRunnerRetry.isRetryable)).toEqual([false, false, false, false, false, false])
  })

  test("retries accepted transport reads but not accepted writes or rejected requests", () => {
    const retryable = [
      llm(new TransportError({ message: "http transport", transport: "http", operation: "request" })),
      llm(
        new TransportError({
          message: "connect failed",
          transport: "websocket",
          operation: "request",
          delivery: "not-sent",
          phase: "connect",
        }),
      ),
      llm(
        new TransportError({
          message: "send uncertain",
          transport: "websocket",
          operation: "write",
          delivery: "ambiguous",
          phase: "send",
        }),
      ),
      llm(
        new TransportError({
          message: "response interrupted",
          transport: "websocket",
          operation: "read",
          delivery: "accepted",
          phase: "receive",
        }),
      ),
    ]
    const ineligible = [
      llm(
        new TransportError({
          message: "accepted write failed",
          transport: "websocket",
          operation: "write",
          delivery: "accepted",
          phase: "send",
        }),
      ),
      llm(
        new TransportError({
          message: "continuation rejected",
          transport: "websocket",
          operation: "read",
          delivery: "rejected",
          recovery: "retry-full",
          phase: "receive",
        }),
      ),
    ]

    expect(retryable.map(SessionRunnerRetry.isRetryable)).toEqual([true, true, true, true])
    expect(ineligible.map(SessionRunnerRetry.isRetryable)).toEqual([false, false])
  })

  test("a prompt the model cannot hold is a hop signal, not a bad request", () => {
    // A context overflow used to reach the runner as a plain invalid
    // request, which never hops: the turn died on a model whose window
    // could not hold the prompt instead of moving to a bigger one. The
    // message stays the same generic one as exhaustion — the user never
    // sees which model failed or why the chain moved.
    expect(
      toSessionError(
        llm(
          new InvalidRequestError({
            message: "This model's maximum context length is 32768 tokens.",
            classification: "context-overflow",
          }),
        ),
      ),
    ).toEqual({ type: "provider.context-too-long", message: "Tente novamente mais tarde." })
    // A plain invalid request without the overflow classification is unchanged.
    expect(toSessionError(llm(new InvalidRequestError({ message: "request" })))).toEqual({
      type: "provider.invalid-request",
      message: "O pedido não pôde ser enviado. Tente reformular.",
    })
  })

  test("honors provider retry header overrides", () => {
    const http = (headers: Record<string, string>) =>
      new HttpContext({
        url: "https://example.com",
        status: 500,
        headers,
      })

    expect(
      SessionRunnerRetry.isRetryable(
        llm(
          new ProviderInternalError({
            message: "do not retry",
            http: http({ "x-should-retry": "false" }),
          }),
        ),
      ),
    ).toBeFalse()
    expect(
      SessionRunnerRetry.isRetryable(
        llm(new InvalidRequestError({ message: "retry", http: http({ "x-should-retry": "true" }) })),
      ),
    ).toBeTrue()
  })
})
