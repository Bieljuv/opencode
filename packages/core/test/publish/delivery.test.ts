import { describe, expect, test } from "bun:test"
import { detectDelivery } from "@opencode/core/publish/delivery"

describe("detectDelivery", () => {
  test("a database folder makes it a system, even next to a static entry point", () => {
    expect(detectDelivery([{ path: "index.html" }, { path: "supabase/migrations/001.sql" }])).toBe("sistema")
  })

  test("a sql file anywhere makes it a system", () => {
    expect(detectDelivery([{ path: "db/schema.sql" }])).toBe("sistema")
  })

  test("a database dependency in package.json makes it a system", () => {
    expect(
      detectDelivery([
        {
          path: "package.json",
          content: JSON.stringify({ dependencies: { pg: "^8.0.0", react: "^19.0.0" } }),
        },
      ]),
    ).toBe("sistema")
  })

  test("a server framework dependency makes it a system", () => {
    expect(
      detectDelivery([
        { path: "package.json", content: JSON.stringify({ dependencies: { express: "^5.0.0" } }) },
      ]),
    ).toBe("sistema")
  })

  test("a plain web project without system signals is a site", () => {
    expect(
      detectDelivery([
        { path: "package.json", content: JSON.stringify({ dependencies: { react: "^19.0.0" } }) },
        { path: "index.html" },
      ]),
    ).toBe("site")
  })

  test("a static page alone is a site", () => {
    expect(detectDelivery([{ path: "index.html" }])).toBe("site")
  })

  test("a project with no entry point is a demo", () => {
    expect(detectDelivery([{ path: "README.md" }])).toBe("demo")
    expect(detectDelivery([])).toBe("demo")
  })

  test("a malformed package.json does not crash detection", () => {
    expect(detectDelivery([{ path: "package.json", content: "{not json" }, { path: "index.html" }])).toBe("site")
  })
})
