export * as PublishPlan from "./plan.js"

import type { DeliveryType } from "./delivery.js"
import type { Readiness } from "./readiness.js"

/**
 * The guided publish flow, in the user's own language. Step ids are internal
 * only: the destination service behind each step (code hosting, database,
 * hosting) is a code-level `provider` that the UI never renders, so the
 * client never has to know a connector name to publish (Gabriel, 13:10
 * 2026-11-11). The user confirms each step; the app never publishes silently.
 */
export type PublishStepId = "download" | "save-code" | "database" | "go-live"

export type PublishStepStatus = "ready" | "blocked" | "done"

export interface PublishStep {
  readonly id: PublishStepId
  /** Internal destination key, used for routing only — never shown to the user. */
  readonly provider: "local" | "code-host" | "database" | "host"
  readonly status: PublishStepStatus
  /** Readiness item ids that keep this step blocked, when blocked. */
  readonly blockedBy: readonly string[]
}

export interface Plan {
  readonly delivery: DeliveryType
  readonly steps: readonly PublishStep[]
}

/**
 * Build the plan from the delivery type and the readiness checklist. The
 * download is always available; saving the code comes next; a system also
 * needs its database connected before it can go live. A step only unblocks
 * when the checklist items behind it are ready.
 */
export function buildPublishPlan(input: { delivery: DeliveryType; readiness: Readiness }): Plan {
  const missing = new Set(
    input.readiness.items.filter((item) => item.status === "missing").map((item) => item.id),
  )
  const steps: PublishStep[] = [
    { id: "download", provider: "local", status: "ready", blockedBy: [] },
    { id: "save-code", provider: "code-host", status: missing.size > 0 ? "blocked" : "ready", blockedBy: [...missing] },
  ]
  if (input.delivery === "sistema") {
    const databaseBlocked = missing.has("database-sql")
    steps.push({
      id: "database",
      provider: "database",
      status: databaseBlocked ? "blocked" : "ready",
      blockedBy: databaseBlocked ? ["database-sql"] : [],
    })
  }
  const goLiveBlocked = [...missing]
  steps.push({
    id: "go-live",
    provider: "host",
    status: goLiveBlocked.length > 0 ? "blocked" : "ready",
    blockedBy: goLiveBlocked,
  })
  return { delivery: input.delivery, steps }
}
