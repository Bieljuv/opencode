import { describe, expect, test } from "bun:test"
import { errorDetailsForDisplay } from "./details"
import { dict as br } from "../../runtime/i18n/br"
import { dict as en } from "../../runtime/i18n/en"

// Every shape the error page can receive, each carrying something the mask
// forbids on screen: provider/model names, a response body, a stack trace.
const hostileErrors: Array<{ name: string; error: unknown; leaked: string[] }> = [
  {
    name: "ProviderModelNotFoundError",
    error: {
      name: "ProviderModelNotFoundError",
      data: { providerID: "openai", modelID: "gpt-4o", suggestions: ["openai/gpt-4o-mini"] },
    },
    leaked: ["openai", "gpt-4o", "gpt-4o-mini"],
  },
  {
    name: "APIError with response body",
    error: {
      name: "APIError",
      data: {
        message: "model not found",
        statusCode: 404,
        responseBody: '{"error":{"message":"Model anthropic/claude-sonnet-4 not found"}}',
      },
    },
    leaked: ["anthropic", "claude-sonnet-4", "Model anthropic"],
  },
  {
    name: "ProviderAuthError",
    error: {
      name: "ProviderAuthError",
      data: { providerID: "deepseek", message: "invalid api key for deepseek" },
    },
    leaked: ["deepseek"],
  },
  {
    name: "Error with stack trace",
    error: Object.assign(new Error("authentication failed for groq"), {
      stack: "ProviderAuthError: authentication failed for groq\n    at node_modules/@opencode/core/src/provider.ts:42:11",
    }),
    leaked: ["groq", "provider.ts", "ProviderAuthError"],
  },
  {
    name: "plain string naming a model",
    error: "Modelo não encontrado: moonshot/kimi-k3.1-pro (custo US$ 2,00)",
    leaked: ["moonshot", "kimi-k3.1-pro", "US$"],
  },
]

const forbiddenWords = ["modelo", "model", "provedor", "provider", "grátis", "gratuito", "free", "custo", "cost", "US$", "quota"]

describe("errorDetailsForDisplay", () => {
  for (const { name: locale, dict } of [
    { name: "br", dict: br },
    { name: "en", dict: en },
  ] as const) {
    describe(`locale ${locale}`, () => {
      const t = (key: "error.page.details.masked") => dict[key]

      test("shows only the masked line, never the error itself", () => {
        for (const { error, leaked } of hostileErrors) {
          const shown = errorDetailsForDisplay(error, t)

          expect(shown).toBe(dict["error.page.details.masked"])
          for (const token of leaked) expect(shown).not.toContain(token)
        }
      })

      test("the masked line itself names no model, provider, quota or cost", () => {
        const shown = errorDetailsForDisplay(hostileErrors[0].error, t)

        for (const word of forbiddenWords) expect(shown.toLowerCase()).not.toContain(word)
      })
    })
  }
})
