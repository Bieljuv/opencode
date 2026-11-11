import type { Accessor } from "solid-js"
import { Schema } from "effect"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { Persistence } from "@/runtime/persistence/schema"

/**
 * The multi-agent toggle the user picked in the composer. It travels to the
 * server as prompt metadata (`manostechMultiAgent`); the agent only splits
 * work across parallel subagents while it is on. Off by default.
 */
export const MultiAgentState = Persistence.struct({
  multiAgent: Schema.Boolean,
})

export type MultiAgentSelection = {
  current: Accessor<boolean>
  set: (multiAgent: boolean) => void
  ready: Accessor<boolean>
}

/** The global, persisted multi-agent selection. Call once per composer controller; every prompt it sends reads it. */
export function useMultiAgent(): MultiAgentSelection {
  const [store, setStore, _, ready] = persisted(Persist.global("manostech-multi-agent"), MultiAgentState, {
    multiAgent: false,
  })

  return {
    current: () => store.multiAgent,
    set: (multiAgent) => setStore("multiAgent", multiAgent),
    ready,
  }
}
