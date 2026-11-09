import type { ProviderPackage } from "../provider-package.js"
import type { ProviderAuthOption } from "../route/auth-options.js"
import { ProviderID, type RequestOptions } from "../schema/index.js"
import { configure as configureCompatible } from "./openai-compatible.js"
import type { OpenAIProviderOptionsInput } from "./openai-options.js"
import { toConfig } from "./settings.js"

/**
 * ManosTech gateway: the app never holds a provider key. The client API key
 * (issued by the ManosTech panel, per client, renewed monthly) authenticates
 * the app against the ManosTech server, and the server routes each request
 * across its shared provider keys — free first, paid when needed. The single
 * static model `auto` is the only route the app knows; the server picks the
 * model behind it, so no model, provider, or tier ever surfaces in the app.
 *
 * baseURL precedence: provider settings (the panel-reported gateway URL,
 * delivered by the core plugin from the connected credential) > the
 * MANOSTECH_GATEWAY_URL environment override (tests) > the default below.
 * The default is a placeholder the panel front reports and replaces once
 * the gateway is live — the gateway is not live yet.
 */

// caminho do gateway — frente do painel define e reporta
export const DEFAULT_BASE_URL = "https://painel-manostech.manostech.workers.dev/api/gateway"

export const id = ProviderID.make("manostech")

/** The single route the app knows. The panel confirms the id when the gateway goes live. */
export const MODEL_ID = "auto"

export type Config = Omit<RequestOptions, "providerOptions"> &
  ProviderAuthOption<"optional"> & {
    readonly baseURL?: string
    readonly providerOptions?: OpenAIProviderOptionsInput
  }

export type Settings = ProviderPackage.Settings &
  OpenAIProviderOptionsInput & {
    readonly apiKey?: string | false
    readonly baseURL?: string
  }

export function resolveBaseURL(settings: { baseURL?: string | undefined }, env: Record<string, string | undefined>) {
  return settings.baseURL ?? env.MANOSTECH_GATEWAY_URL ?? DEFAULT_BASE_URL
}

export const configure = (input: Config = {}) => {
  const baseURL = input.baseURL ?? process.env.MANOSTECH_GATEWAY_URL ?? DEFAULT_BASE_URL
  return configureCompatible({ ...input, provider: "manostech", baseURL })
}

export const provider = configure()

export const model: ProviderPackage.Model<Settings, OpenAIProviderOptionsInput> = (modelID, settings) =>
  configure(toConfig(settings)).model(modelID)

export * as ManosTech from "./manostech.js"
