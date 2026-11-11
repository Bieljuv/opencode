import { describe, expect, test } from "bun:test"
import { transitionExportLogs } from "./export-logs"

describe("export.requested", () => {
  test("available starts the export", () => {
    const next = transitionExportLogs("idle", { type: "export.requested", available: true })

    expect(next.state).toBe("exporting")
    expect(next.effects).toEqual([{ type: "do-export" }])
  })

  test("unavailable does nothing", () => {
    const next = transitionExportLogs("idle", { type: "export.requested", available: false })

    expect(next.state).toBe("idle")
    expect(next.effects).toEqual([])
  })

  test("a second click while exporting does nothing", () => {
    const next = transitionExportLogs("exporting", { type: "export.requested", available: true })

    expect(next.state).toBe("exporting")
    expect(next.effects).toEqual([])
  })

  test("exporting again after a finished export restarts it", () => {
    const next = transitionExportLogs("exported", { type: "export.requested", available: true })

    expect(next.state).toBe("exporting")
    expect(next.effects).toEqual([{ type: "do-export" }])
  })
})

describe("export result", () => {
  test("success shows the confirmation", () => {
    const next = transitionExportLogs("exporting", { type: "export.succeeded" })

    expect(next.state).toBe("exported")
    expect(next.effects).toEqual([])
  })

  test("failure shows the generic error", () => {
    const next = transitionExportLogs("exporting", { type: "export.failed" })

    expect(next.state).toBe("failed")
    expect(next.effects).toEqual([])
  })

  test("a late success after the export already finished changes nothing", () => {
    const next = transitionExportLogs("exported", { type: "export.succeeded" })

    expect(next.state).toBe("exported")
    expect(next.effects).toEqual([])
  })

  test("a late failure with nothing exporting changes nothing", () => {
    const next = transitionExportLogs("idle", { type: "export.failed" })

    expect(next.state).toBe("idle")
    expect(next.effects).toEqual([])
  })
})
