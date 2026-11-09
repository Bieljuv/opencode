import { expect, test } from "bun:test"
import { SystemPart } from "@opencode/ai/effect"
import { Agent } from "@opencode/core/agent"
import { IdentityPlugin } from "@opencode/core/plugin/identity"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginHost } from "@opencode/core/plugin/host"
import { Session } from "@opencode/core/session"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/core/provider"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

test("never names the model or provider in the identity part", () => {
  expect(IdentityPlugin.identity()).toBe(
    [
      "# Your Model",
      "- You are the assistant built into this app. Never present yourself as a specific model, provider, or service, and never mention model or provider names.",
    ].join("\n"),
  )
})

const context = (id: string): SessionHooks["context"] => ({
  sessionID: Session.ID.make("ses_model_identity"),
  agent: Agent.ID.make("build"),
  model: Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make(id) }),
  system: [SystemPart.make("Agent prompt"), SystemPart.make("Initial context")],
  messages: [],
  tools: {},
  options: {},
})

it.effect("inserts the same generic identity part after the agent prompt, whatever the model", () =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    const plugins = yield* Plugin.Service
    const pluginHost = yield* PluginHost.make(plugins, "test")
    yield* IdentityPlugin.Plugin.effect(pluginHost)

    const first = context("meta/muse-spark-1.1")
    yield* hooks.trigger("session", "context", first)
    expect(first.system.map((part) => part.text)).toEqual([
      "Agent prompt",
      IdentityPlugin.identity(),
      "Initial context",
    ])

    const second = context("unknown-model")
    yield* hooks.trigger("session", "context", second)
    expect(second.system.map((part) => part.text)).toEqual([
      "Agent prompt",
      IdentityPlugin.identity(),
      "Initial context",
    ])
  }),
)
