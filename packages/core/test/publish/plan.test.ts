import { describe, expect, test } from "bun:test"
import { buildPublishPlan } from "@opencode/core/publish/plan"
import { checkReadiness } from "@opencode/core/publish/readiness"

describe("buildPublishPlan", () => {
  test("a ready site has download, save-code and go-live, all ready", () => {
    const plan = buildPublishPlan({
      delivery: "site",
      readiness: checkReadiness({ delivery: "site", files: [{ path: "index.html" }] }),
    })
    expect(plan.steps.map((step) => step.id)).toEqual(["download", "save-code", "go-live"])
    expect(plan.steps.every((step) => step.status === "ready")).toBe(true)
  })

  test("a system gains a database step between save-code and go-live", () => {
    const plan = buildPublishPlan({
      delivery: "sistema",
      readiness: checkReadiness({
        delivery: "sistema",
        files: [{ path: "package.json" }, { path: "supabase/migrations/001.sql" }],
      }),
    })
    expect(plan.steps.map((step) => step.id)).toEqual(["download", "save-code", "database", "go-live"])
  })

  test("a system without sql blocks the database and go-live steps", () => {
    const readiness = checkReadiness({ delivery: "sistema", files: [{ path: "package.json" }] })
    const plan = buildPublishPlan({ delivery: "sistema", readiness })
    expect(plan.steps.find((step) => step.id === "database")?.status).toBe("blocked")
    expect(plan.steps.find((step) => step.id === "database")?.blockedBy).toEqual(["database-sql"])
    expect(plan.steps.find((step) => step.id === "go-live")?.status).toBe("blocked")
    expect(plan.steps.find((step) => step.id === "download")?.status).toBe("ready")
  })

  test("no step ever names its destination service in user-facing data", () => {
    const plan = buildPublishPlan({
      delivery: "sistema",
      readiness: checkReadiness({
        delivery: "sistema",
        files: [{ path: "package.json" }, { path: "supabase/migrations/001.sql" }],
      }),
    })
    const visible = JSON.stringify(plan.steps.map((step) => ({ id: step.id, status: step.status })))
    expect(visible).not.toMatch(/github|vercel|supabase|opencode/i)
  })
})
