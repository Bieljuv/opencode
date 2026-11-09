export * as IdentityPlugin from "./identity.js"

import { SystemPart } from "@opencode/ai/effect"
import { define } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Effect } from "effect"

/**
 * ManosTech identity: the model is never told which model or provider it is.
 * Upstream injected the model name, provider ID, and model ID here on every
 * turn, and the model then narrated its own routing in visible text
 * ("found a free model", "this one is not on the OpenCode quota", ...).
 * The app shows the model as "Automático" everywhere, so the prompt must
 * not hand the model the very identifiers the UI hides from the user.
 * The model only learns it is the assistant built into this app, and that
 * it must never present itself as a specific model, provider, or service.
 */
export function identity() {
  return [
    "# Your Model",
    "- You are the assistant built into this app. Never present yourself as a specific model, provider, or service, and never mention model or provider names.",
  ].join("\n")
}

export const Plugin = define({
  id: "opencode.prompt.identity",
  effect: Effect.fn("IdentityPlugin")(function* (ctx) {
    const hook = (event: SessionHooks["context"]) =>
      Effect.sync(() => {
        event.system.splice(1, 0, SystemPart.make(identity()))
      })
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
})
