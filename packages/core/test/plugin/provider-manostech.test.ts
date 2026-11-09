import { describe, expect } from "bun:test"
import { Effect, Schedule } from "effect"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { ManosTechGatewayPlugin } from "@opencode/core/plugin/provider/manostech"
import { Provider } from "@opencode/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const providerID = Provider.ID.make("manostech")

const addPlugin = Effect.fn(function* () {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin, "test")
  yield* ManosTechGatewayPlugin.effect(host)
})

const connectStoredKey = (gatewayUrl: string) =>
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    yield* credentials.create({
      integrationID: Integration.ID.make("manostech"),
      value: Credential.Key.make({
        type: "key",
        key: "key-1",
        metadata: { gatewayUrl },
      }),
    })
  })

const defaultWhen = (predicate: (model: Model.Info | undefined) => boolean) =>
  Effect.gen(function* () {
    const models = yield* Model.Service
    return yield* models.default()
  }).pipe(
    Effect.filterOrFail(predicate, () => new Error("default not applied")),
    Effect.retry({ schedule: Schedule.spaced("1 millis") }),
    Effect.timeout("10 seconds"),
  )

describe("ManosTechGatewayPlugin", () => {
  it.effect("leaves the default alone with no gateway credential", () =>
    Effect.gen(function* () {
      yield* addPlugin()
      const models = yield* Model.Service
      expect(yield* models.configuredDefault()).toBeUndefined()
      expect((yield* models.default())?.providerID).not.toBe(providerID)
    }),
  )

  it.effect("defaults new sessions to the gateway model while a credential is connected", () =>
    Effect.gen(function* () {
      yield* connectStoredKey("https://gw.exemplo/v1")
      yield* addPlugin()
      const models = yield* Model.Service
      expect(yield* models.configuredDefault()).toEqual({ providerID, modelID: Model.ID.make("auto") })
      const resolved = yield* models.default()
      expect(resolved?.providerID).toBe(providerID)
      expect(resolved?.id).toBe(Model.ID.make("auto"))
    }),
  )

  it.effect("keeps an explicitly configured default over the gateway model", () =>
    Effect.gen(function* () {
      const models = yield* Model.Service
      const explicit = { providerID: Provider.ID.make("company"), modelID: Model.ID.make("chat") }
      yield* models.transform((editor) => {
        editor.default.set(explicit.providerID, explicit.modelID)
      })
      yield* connectStoredKey("https://gw.exemplo/v1")
      yield* addPlugin()
      expect(yield* models.configuredDefault()).toEqual(explicit)
    }),
  )

  it.live("defaults to the gateway model when the key connects after startup", () =>
    Effect.gen(function* () {
      yield* addPlugin()
      const integrations = yield* Integration.Service
      yield* integrations.connection.key({
        integrationID: Integration.ID.make("manostech"),
        key: "key-1",
        answer: { gatewayUrl: "https://gw.exemplo/v1" },
      })
      const resolved = yield* defaultWhen(
        (model) => model?.providerID === providerID && model.id === "auto",
      )
      expect(resolved?.providerID).toBe(providerID)
      expect(resolved?.id).toBe(Model.ID.make("auto"))
    }),
  )
})
