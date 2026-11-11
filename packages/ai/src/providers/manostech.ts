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
 * across its shared provider keys — free first, paid when needed. The two
 * static models `auto` (chat) and `auto-image` (image) are the only routes
 * the app knows; the server picks the model behind each one, so no model,
 * provider, or tier ever surfaces in the app.
 *
 * baseURL precedence: provider settings (the panel-reported gateway URL,
 * delivered by the core plugin from the connected credential) > the
 * MANOSTECH_GATEWAY_URL environment override (tests) > the default below.
 * The default is the panel's live gateway: the panel serves the
 * OpenAI-compatible API at /v1, and the compatible route appends
 * /chat/completions — so the default must end in /v1, not /api/gateway
 * (that path does not exist on the panel and answers 404). Verified live:
 * POST /v1/chat/completions without a key answers 401, not 404.
 */

// o caminho real do gateway no painel — /v1, sem /api/gateway
export const DEFAULT_BASE_URL = "https://painel-manostech.manostech.workers.dev/v1"

export const id = ProviderID.make("manostech")

/** The single route the app knows. The panel confirms the id when the gateway goes live. */
export const MODEL_ID = "auto"

/** The image route the app knows. The gateway only accepts "manostech-auto" on /v1/images/generations, so the catalog model carries a body overlay that rewrites this id on the wire (see the core plugin). */
export const MODEL_IMAGE_ID = "auto-image"

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

/** Image entrypoint: same OpenAI-compatible images protocol, through the gateway's own configure so the provider stays "manostech" and the base URL stays the panel's /v1. */
export const imageModel = (modelID: string, settings: Settings) => {
  const input = toConfig(settings)
  return configure(input).image(modelID, input.providerOptions)
}

export * as ManosTech from "./manostech.js"
