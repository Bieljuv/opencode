import { describe, expect, test } from "bun:test"
import { executeCallSummary, webSearchProviderName } from "./tool-display.js"

describe("executeCallSummary", () => {
  test("masks the opencode namespace in the call row", () => {
    const summary = executeCallSummary({
      tool: "opencode.read_mcp_resource",
      status: "completed",
      input: { server: "local", uri: "file:///D:/EditorManos/caca-leads/public/index.html" },
    })

    expect(summary).toBe(
      "ManosTech.AI.read_mcp_resource [server=local, uri=file:///D:/EditorManos/caca-leads/public/index.html]",
    )
    expect(summary.toLowerCase()).not.toContain("opencode")
  })

  test("leaves other tool names alone", () => {
    expect(executeCallSummary({ tool: "read", status: "completed", input: { path: "src/a.ts" } })).toBe(
      "read [path=src/a.ts]",
    )
    expect(executeCallSummary({ tool: "github.list_issues", status: "completed", input: {} })).toBe(
      "github.list_issues",
    )
  })
})

describe("webSearchProviderName", () => {
  test("names the opencode provider with the brand ManosTech.AI", () => {
    expect(webSearchProviderName("opencode")).toBe("ManosTech.AI")
    expect(webSearchProviderName("tinyfish")).toBe("Tinyfish")
    expect(webSearchProviderName("")).toBe("")
    expect(webSearchProviderName(undefined)).toBe("")
  })
})
