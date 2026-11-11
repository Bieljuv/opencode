export * as Agent from "./agent.js"

import { Schema } from "effect"
import { ephemeral, inventory } from "./event.js"
import { optional } from "./schema.js"
import { Model } from "./model.js"
import { Permission } from "./permission.js"
import { Provider } from "./provider.js"
import { PositiveInt, statics } from "./schema.js"

const Updated = ephemeral({ type: "agent.updated", schema: {} })

export const ID = Schema.String.pipe(Schema.brand("Agent.ID"), Schema.annotate({ identifier: "Agent.ID" }))
export type ID = typeof ID.Type

export const Name = Schema.String.pipe(Schema.brand("Agent.Name"))
export type Name = typeof Name.Type

export const Color = Schema.String.annotate({ identifier: "Agent.Color" })
export type Color = typeof Color.Type

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  name: Name,
  model: Model.Ref.pipe(optional),
  request: Provider.Request,
  system: Schema.String.pipe(optional),
  description: Schema.String.pipe(optional),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  hidden: Schema.Boolean,
  color: Color.pipe(optional),
  steps: PositiveInt.pipe(optional),
  permissions: Permission.Ruleset,
})
  .annotate({ identifier: "Agent.Info" })
  .pipe(
    statics(() => ({
      default: (id: ID) =>
        ({
          id,
          name: Name.make(id),
          request: { settings: {}, headers: {}, body: {} },
          mode: "primary",
          hidden: false,
          // ManosTech: every agent starts capped (audit C-04); see DEFAULT_MAX_STEPS.
          steps: DEFAULT_MAX_STEPS,
          permissions: [
            { action: "*", resource: "*", effect: "allow" },
            { action: "read", resource: "*.env", effect: "ask" },
            { action: "read", resource: "*.env.*", effect: "ask" },
            { action: "read", resource: "*.env.example", effect: "allow" },
            // ManosTech: approval before acting. File edits ask the user
            // first instead of running silently; the user can answer
            // "always" once per project and the rule is saved.
            { action: "edit", resource: "*", effect: "ask" },
            // ManosTech: mutating shell commands ask the user first
            // (see ShellParse.isMutatingCommand). Read-only commands keep
            // using the "shell" action and stay allowed.
            { action: "shell.mutate", resource: "*", effect: "ask" },
          ],
        }) satisfies Info,
    })),
  )

export const Event = {
  Updated,
  Definitions: inventory(Updated),
}

/**
 * ManosTech: default step cap per turn (audit C-04). A turn without a cap can
 * spin until the context fills, spending usage in silence. 50 steps is enough
 * for a full build (create files, run checks, fix failures) while still
 * stopping a stuck turn on its own; the agent then summarizes what is done
 * and what is left instead of looping. Any agent may override it with an
 * explicit `steps` value in its own config.
 */
export const DEFAULT_MAX_STEPS = 50
