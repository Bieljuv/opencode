import { Effect } from "effect"
import { define } from "@opencode/plugin/effect/plugin"
import { Form } from "@opencode/schema/form"
import { Integration } from "@opencode/schema/integration"
import { Model } from "@opencode/schema/model"
import { Flag } from "../../flag.js"
import { Provider } from "../../provider.js"
import { configuredSettings } from "./configured.js"
import { credentialSettings, metadataSettings } from "./credential-settings.js"

/**
 * ManosTech gateway: the app never holds a provider key. The desktop main
 * connects the client API key (issued by the ManosTech panel, per client)
 * as this integration's key, and the server routes each request across its
 * shared provider keys. The single static model `auto` is the only route
 * the app knows; the server picks the model behind it.
 *
 * Availability follows the normal rule: the provider record carries
 * integrationID `manostech`, so it only joins `Model.available()` while a
 * credential is connected — no key, no model, nothing to pick or leak.
 * The flag gates the whole registration: with `manostech-gateway` off (the
 * release default) the integration and the provider do not exist.
 *
 * The panel-reported gateway URL reaches the provider settings through the
 * key method's hidden `gatewayUrl` form answer, which the main supplies
 * when it connects the key — the same credential-metadata seam the
 * Cloudflare AI Gateway plugin uses for its account and gateway IDs.
 * The panel never reports a URL in practice, so the main falls back to
 * the package default (the panel's live gateway, /v1) when none is stored.
 * Precedence: panel URL (credential) > config baseURL > MANOSTECH_GATEWAY_URL
 * env > the package default.
 */

const providerID = Provider.ID.make("manostech")

const gatewayUrlField = Form.StringField.make({
  type: "string",
  key: "gatewayUrl",
  title: "Gateway URL",
  format: "uri",
  hidden: true,
})

export const ManosTechGatewayPlugin = define({
  id: "opencode.provider.manostech",
  effect: Effect.fn(function* (ctx) {
    if (!(yield* Flag.enabled("manostech-gateway"))) return

    const configured = yield* configuredSettings(providerID)
    yield* ctx.integration.transform((editor) => {
      editor.update(providerID, (integration) => {
        integration.name = "ManosTech"
      })
      editor.method.update({
        integrationID: providerID,
        method: {
          type: "key",
          label: "ManosTech API key",
          form:
            typeof configured?.baseURL === "string" ? undefined : Form.Fields.make([gatewayUrlField]),
        },
      })
    })
    // The key method's form answers are stored as credential metadata.
    const login = yield* credentialSettings(ctx, providerID, (value) => {
      if (value.type !== "key") return {}
      const settings = metadataSettings(value.metadata, ["gatewayUrl"])
      return typeof settings.gatewayUrl === "string" ? { baseURL: settings.gatewayUrl } : {}
    })
    yield* ctx.provider.transform((providers) => {
      if (!providers.get(providerID)) {
        providers.add({
          info: {
            ...Provider.Info.empty(providerID),
            name: "ManosTech",
            package: "@opencode/ai/providers/manostech",
            integrationID: Integration.ID.make("manostech"),
          },
          models: [Model.Info.default(providerID, Model.ID.make("auto"))],
        })
      }
      if (typeof login.settings.baseURL === "string") {
        providers.update(providerID, (provider) => {
          provider.settings = Provider.mergeOverlay(provider.settings, login.settings)
        })
      }
    })
  }),
})
