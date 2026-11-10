import { describe, expect, test } from "bun:test"
import type { ClientUsage, WeeklyUsage } from "@opencode/plugin/gui"
import {
  selectWeeklyRelease,
  selectWeeklyUsage,
  weeklyUsageBlocks,
  weeklyUsageResetInMs,
  weeklyUsageResetParts,
  weeklyUsageTone,
  weeklyUsageToneClass,
} from "./weekly-usage"

const weekly = (overrides: Partial<WeeklyUsage> = {}): WeeklyUsage => ({
  percent: 42,
  resetsAt: "2026-11-17T03:00:00Z",
  blocked: false,
  releasesAt: undefined,
  ...overrides,
})

const usage = (overrides: Partial<ClientUsage> = {}): ClientUsage => ({
  percent: 40,
  resetsAt: "2026-11-10T03:00:00Z",
  weekly: weekly(),
  ...overrides,
})

describe("weekly usage tone", () => {
  test("stays green below 70%, yellow to 89%, red from 90%", () => {
    expect(weeklyUsageTone(0)).toBe("ok")
    expect(weeklyUsageTone(69)).toBe("ok")
    expect(weeklyUsageTone(70)).toBe("warn")
    expect(weeklyUsageTone(89)).toBe("warn")
    expect(weeklyUsageTone(90)).toBe("danger")
    expect(weeklyUsageTone(100)).toBe("danger")
    // Over the cap still reads as danger, never a fourth tone.
    expect(weeklyUsageTone(150)).toBe("danger")
  })
})

describe("weekly usage bar blocks", () => {
  test("fills one block per 10%, rounded, clamped to the ten blocks", () => {
    expect(weeklyUsageBlocks(0)).toBe(0)
    expect(weeklyUsageBlocks(4)).toBe(0)
    expect(weeklyUsageBlocks(5)).toBe(1)
    expect(weeklyUsageBlocks(14)).toBe(1)
    expect(weeklyUsageBlocks(15)).toBe(2)
    expect(weeklyUsageBlocks(50)).toBe(5)
    expect(weeklyUsageBlocks(87)).toBe(9)
    expect(weeklyUsageBlocks(95)).toBe(10)
    expect(weeklyUsageBlocks(100)).toBe(10)
    expect(weeklyUsageBlocks(150)).toBe(10)
  })
})

describe("weekly usage tone class", () => {
  test("maps each tone to a v2 state background class that Tailwind generates", () => {
    expect(weeklyUsageToneClass("ok")).toBe("bg-v2-state-fg-success")
    expect(weeklyUsageToneClass("warn")).toBe("bg-v2-state-fg-warning")
    expect(weeklyUsageToneClass("danger")).toBe("bg-v2-state-fg-danger")
  })
})

describe("weekly usage reset", () => {
  test("counts down to the reset instant, and never below zero", () => {
    const now = Date.parse("2026-11-10T00:00:00Z")

    expect(weeklyUsageResetInMs("2026-11-10T03:00:00Z", now)).toBe(3 * 3_600_000)
    expect(weeklyUsageResetInMs("2026-11-09T23:00:00Z", now)).toBe(0)
    expect(weeklyUsageResetInMs("não é um instante", now)).toBeUndefined()
  })

  test("splits the countdown into days, hours and minutes", () => {
    expect(weeklyUsageResetParts(0)).toEqual({ days: 0, hours: 0, minutes: 0 })
    expect(weeklyUsageResetParts(90 * 60_000)).toEqual({ days: 0, hours: 1, minutes: 30 })
    expect(weeklyUsageResetParts(25 * 3_600_000)).toEqual({ days: 1, hours: 1, minutes: 0 })
    expect(weeklyUsageResetParts((6 * 24 + 3) * 3_600_000 + 15 * 60_000)).toEqual({
      days: 6,
      hours: 3,
      minutes: 15,
    })
  })
})

describe("weekly usage visibility", () => {
  test("no client usage, or a client without a weekly limit, means no bar", () => {
    expect(selectWeeklyUsage(undefined)).toBeUndefined()
    expect(selectWeeklyUsage(usage({ weekly: undefined }))).toBeUndefined()
  })

  test("a client with a weekly limit shows the weekly usage", () => {
    const value = weekly({ percent: 87 })

    expect(selectWeeklyUsage(usage({ weekly: value }))).toBe(value)
  })
})

describe("weekly usage release", () => {
  test("only a blocked week shows a release instant", () => {
    expect(selectWeeklyRelease(undefined)).toBeUndefined()
    expect(selectWeeklyRelease(weekly({ blocked: false, releasesAt: "2026-11-10T17:00:00Z" }))).toBeUndefined()
    expect(selectWeeklyRelease(weekly({ blocked: true, releasesAt: undefined }))).toBeUndefined()
    expect(selectWeeklyRelease(weekly({ blocked: true, releasesAt: "2026-11-10T17:00:00Z" }))).toBe(
      "2026-11-10T17:00:00Z",
    )
  })
})
