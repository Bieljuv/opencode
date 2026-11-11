export * as PublishReadiness from "./readiness.js"

import type { DeliveryType, ProjectFile } from "./delivery.js"

/**
 * The publish checklist (REGRA DE OURO: toda construção nasce pronta para
 * publicar). Each item carries a stable id the UI maps to plain-language
 * copy — no provider or service name ever travels in the item itself.
 */
export type ReadinessStatus = "ready" | "attention" | "missing"

export interface ReadinessItem {
  readonly id: string
  readonly status: ReadinessStatus
}

export interface Readiness {
  readonly delivery: DeliveryType
  readonly items: readonly ReadinessItem[]
  /** Nothing blocks publishing when this is true. */
  readonly publishable: boolean
}

function hasFile(files: readonly ProjectFile[], name: string): boolean {
  return files.some((file) => file.path === name)
}

function usesBrowserStorageAsDatabase(files: readonly ProjectFile[]): boolean {
  return files.some(
    (file) =>
      file.content !== undefined &&
      file.path.startsWith("src/") &&
      (file.content.includes("localStorage.setItem") || file.content.includes("sessionStorage.setItem")),
  )
}

/**
 * Check the project against the publish rules. A system needs its database
 * SQL inside the project and its secrets declared only as environment
 * variables; a `.env` file inside the project blocks publishing outright
 * because secrets must never ship with the code.
 */
export function checkReadiness(input: { delivery: DeliveryType; files: readonly ProjectFile[] }): Readiness {
  const items: ReadinessItem[] = []
  const entrypoint =
    hasFile(input.files, "package.json") ||
    hasFile(input.files, "index.html") ||
    input.files.some((file) => file.path.startsWith("src/"))
  items.push({ id: "entrypoint", status: entrypoint ? "ready" : "missing" })

  if (input.delivery === "sistema") {
    const hasSql =
      input.files.some((file) => file.path.endsWith(".sql")) ||
      input.files.some((file) => file.path.startsWith("supabase/"))
    items.push({ id: "database-sql", status: hasSql ? "ready" : "missing" })
    items.push({
      id: "env-example",
      status: hasFile(input.files, ".env.example") ? "ready" : "attention",
    })
    items.push({
      id: "final-storage",
      status: usesBrowserStorageAsDatabase(input.files) ? "attention" : "ready",
    })
  }

  items.push({
    id: "secrets-not-in-project",
    status: hasFile(input.files, ".env") ? "missing" : "ready",
  })

  return {
    delivery: input.delivery,
    items,
    publishable: items.every((item) => item.status !== "missing"),
  }
}
