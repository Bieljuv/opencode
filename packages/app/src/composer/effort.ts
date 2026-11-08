import type { Accessor } from "solid-js"
import { Schema } from "effect"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { Persistence } from "@/runtime/persistence/schema"

/**
 * The effort the user picked for the automatic router. The router still chooses the model itself; the effort only
 * steers how much work it puts into the answer. It travels to the server as prompt metadata (`manostechEffort`).
 */
export type RouterEffort = "automatico" | "rapido" | "equilibrado" | "aprofundado"

export const ROUTER_EFFORTS: readonly RouterEffort[] = ["automatico", "rapido", "equilibrado", "aprofundado"]

/** Reads an effort back from an untyped menu value; anything else is not an effort. */
export function parseRouterEffort(value: string): RouterEffort | undefined {
  return ROUTER_EFFORTS.find((effort) => effort === value)
}

/** The i18n key for each effort's dropdown label. */
export const ROUTER_EFFORT_LABEL_KEYS = {
  automatico: "composer.effort.automatic",
  rapido: "composer.effort.fast",
  equilibrado: "composer.effort.balanced",
  aprofundado: "composer.effort.deep",
} as const

export const RouterEffortState = Persistence.struct({
  effort: Schema.Literals(["automatico", "rapido", "equilibrado", "aprofundado"]),
})

export type RouterEffortSelection = {
  current: Accessor<RouterEffort>
  set: (effort: RouterEffort) => void
  ready: Accessor<boolean>
}

/** The global, persisted effort selection. Call once per composer controller; every prompt it sends reads it. */
export function useRouterEffort(): RouterEffortSelection {
  const [store, setStore, _, ready] = persisted(Persist.global("manostech-router-effort"), RouterEffortState, {
    effort: "automatico",
  })

  return {
    current: () => store.effort,
    set: (effort) => setStore("effort", effort),
    ready,
  }
}
