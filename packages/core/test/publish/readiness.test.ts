import { describe, expect, test } from "bun:test"
import { checkReadiness } from "@opencode/core/publish/readiness"

describe("checkReadiness", () => {
  test("a complete system is publishable", () => {
    const result = checkReadiness({
      delivery: "sistema",
      files: [
        { path: "package.json" },
        { path: "supabase/migrations/001.sql" },
        { path: ".env.example" },
        { path: "src/app.ts", content: "export const app = 1" },
      ],
    })
    expect(result.publishable).toBe(true)
    expect(result.items.every((item) => item.status === "ready")).toBe(true)
  })

  test("a system without its database sql cannot publish", () => {
    const result = checkReadiness({ delivery: "sistema", files: [{ path: "package.json" }] })
    expect(result.publishable).toBe(false)
    expect(result.items.find((item) => item.id === "database-sql")?.status).toBe("missing")
  })

  test("a system without an env example is attention, not a blocker", () => {
    const result = checkReadiness({
      delivery: "sistema",
      files: [{ path: "package.json" }, { path: "supabase/migrations/001.sql" }],
    })
    expect(result.publishable).toBe(true)
    expect(result.items.find((item) => item.id === "env-example")?.status).toBe("attention")
  })

  test("a .env file inside the project blocks publishing", () => {
    const result = checkReadiness({
      delivery: "site",
      files: [{ path: "index.html" }, { path: ".env" }],
    })
    expect(result.publishable).toBe(false)
    expect(result.items.find((item) => item.id === "secrets-not-in-project")?.status).toBe("missing")
  })

  test("browser storage as the final store is flagged for a system", () => {
    const result = checkReadiness({
      delivery: "sistema",
      files: [
        { path: "package.json" },
        { path: "supabase/migrations/001.sql" },
        { path: "src/store.ts", content: "localStorage.setItem('orders', JSON.stringify(orders))" },
      ],
    })
    expect(result.items.find((item) => item.id === "final-storage")?.status).toBe("attention")
  })

  test("a site skips the database items", () => {
    const result = checkReadiness({ delivery: "site", files: [{ path: "index.html" }] })
    expect(result.publishable).toBe(true)
    expect(result.items.some((item) => item.id === "database-sql")).toBe(false)
  })
})
