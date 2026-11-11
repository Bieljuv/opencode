import { describe, expect, test } from "bun:test"
import {
  planBlock,
  planUsageBlocks,
  planUsageResetInMs,
  planUsageTone,
  planUsageToneClass,
  shouldShowUsageWarning,
  shouldShowWeeklyUsageWarning,
  type PlanUsage,
} from "./plan-usage"
import { dict as dictBr } from "../runtime/i18n/br"
import { dict as dictEn } from "../runtime/i18n/en"

describe("plan usage tone class", () => {
  test("maps each tone to a v2 state background class that Tailwind generates", () => {
    // Regression: bg-success / bg-warning / bg-danger had no color token,
    // so the bar blocks computed transparent. The v2 state fg tokens are
    // the saturated state colors (see planUsageToneClass).
    expect(planUsageToneClass("ok")).toBe("bg-v2-state-fg-success")
    expect(planUsageToneClass("warn")).toBe("bg-v2-state-fg-warning")
    expect(planUsageToneClass("danger")).toBe("bg-v2-state-fg-danger")
  })
})

describe("plan usage tone", () => {
  test("stays green below 70%, yellow to 89%, red from 90%", () => {
    expect(planUsageTone(0)).toBe("ok")
    expect(planUsageTone(69)).toBe("ok")
    expect(planUsageTone(70)).toBe("warn")
    expect(planUsageTone(89)).toBe("warn")
    expect(planUsageTone(90)).toBe("danger")
    expect(planUsageTone(100)).toBe("danger")
    // Over the cap still reads as danger, never a fourth tone.
    expect(planUsageTone(150)).toBe("danger")
  })
})

describe("plan usage bar blocks", () => {
  test("fills one block per 10%, rounded, clamped to the ten blocks", () => {
    expect(planUsageBlocks(0)).toBe(0)
    expect(planUsageBlocks(4)).toBe(0)
    expect(planUsageBlocks(5)).toBe(1)
    expect(planUsageBlocks(14)).toBe(1)
    expect(planUsageBlocks(15)).toBe(2)
    expect(planUsageBlocks(85)).toBe(9)
    expect(planUsageBlocks(95)).toBe(10)
    expect(planUsageBlocks(100)).toBe(10)
    expect(planUsageBlocks(150)).toBe(10)
    expect(planUsageBlocks(-5)).toBe(0)
  })
})

describe("usage warning trigger", () => {
  test("fires at 75% in the app-root watcher, once a day, and never below it or after being warned", () => {
    const usage = (percent: number, warnedToday: boolean): PlanUsage => ({
      percent,
      resetsAt: "2026-11-11T03:00:00Z",
      warnedToday,
      blocked: false,
      weeklyWarned: false,
    })

    expect(shouldShowUsageWarning(usage(74, false), true)).toBe(false)
    expect(shouldShowUsageWarning(usage(75, false), true)).toBe(true)
    expect(shouldShowUsageWarning(usage(100, false), true)).toBe(true)
    expect(shouldShowUsageWarning(usage(150, false), true)).toBe(true)
    // Warned today: the push stays off until tomorrow.
    expect(shouldShowUsageWarning(usage(75, true), true)).toBe(false)
    expect(shouldShowUsageWarning(usage(100, true), true)).toBe(false)
    // Without the watcher (e.g. the Settings usage screen) there is no warning.
    expect(shouldShowUsageWarning(usage(100, false))).toBe(false)
    expect(shouldShowUsageWarning(usage(100, false), false)).toBe(false)
  })
})

describe("weekly usage warning trigger", () => {
  test("fires at 75% of the week, once per cycle, and never below it or after being warned", () => {
    const usage = (percent: number, weeklyWarned: boolean): PlanUsage => ({
      percent: 10,
      resetsAt: "2026-11-11T03:00:00Z",
      warnedToday: false,
      blocked: false,
      weekly: {
        percent,
        resetsAt: "2026-11-16T03:00:00Z",
        blocked: false,
        releasesAt: undefined,
      },
      weeklyWarned,
    })

    expect(shouldShowWeeklyUsageWarning(usage(74, false), true)).toBe(false)
    expect(shouldShowWeeklyUsageWarning(usage(75, false), true)).toBe(true)
    expect(shouldShowWeeklyUsageWarning(usage(100, false), true)).toBe(true)
    // Warned this cycle: the push stays off until the next cycle.
    expect(shouldShowWeeklyUsageWarning(usage(75, true), true)).toBe(false)
    expect(shouldShowWeeklyUsageWarning(usage(100, true), true)).toBe(false)
    // Without the watcher there is no warning, and without a weekly
    // limit there is nothing to warn about.
    expect(shouldShowWeeklyUsageWarning(usage(100, false))).toBe(false)
    expect(shouldShowWeeklyUsageWarning(usage(100, false), false)).toBe(false)
    const noWeekly: PlanUsage = {
      percent: 10,
      resetsAt: "2026-11-11T03:00:00Z",
      warnedToday: false,
      blocked: false,
      weeklyWarned: false,
    }
    expect(shouldShowWeeklyUsageWarning(noWeekly, true)).toBe(false)
  })
})

describe("plan block", () => {
  test("locks the composer on any spent allowance, with the latest release, and unlocks when all clear", () => {
    const base: PlanUsage = {
      percent: 10,
      resetsAt: "2026-11-11T03:00:00Z",
      warnedToday: false,
      blocked: false,
      weeklyWarned: false,
    }

    // Nothing spent: no block, the composer stays open.
    expect(planBlock(base)).toBeUndefined()
    // Daily spent: the release is midnight.
    expect(planBlock({ ...base, blocked: true })).toEqual({ releasesAt: "2026-11-11T03:00:00Z" })
    // Weekly spent: the release is the cooldown end.
    expect(
      planBlock({
        ...base,
        weekly: {
          percent: 100,
          resetsAt: "2026-11-16T03:00:00Z",
          blocked: true,
          releasesAt: "2026-11-11T19:00:00Z",
        },
      }),
    ).toEqual({ releasesAt: "2026-11-11T19:00:00Z" })
    // Monthly spent: the release is the turn of the month.
    expect(
      planBlock({
        ...base,
        monthly: {
          percent: 100,
          resetsAt: "2026-12-01T03:00:00Z",
          blocked: true,
          releasesAt: "2026-12-01T03:00:00Z",
        },
      }),
    ).toEqual({ releasesAt: "2026-12-01T03:00:00Z" })
    // Daily and weekly spent together: the composer unlocks only when
    // the LATEST release passes (tomorrow's midnight, not today's
    // cooldown end).
    expect(
      planBlock({
        ...base,
        resetsAt: "2026-11-12T03:00:00Z",
        blocked: true,
        weekly: {
          percent: 100,
          resetsAt: "2026-11-16T03:00:00Z",
          blocked: true,
          releasesAt: "2026-11-11T19:00:00Z",
        },
      }),
    ).toEqual({ releasesAt: "2026-11-12T03:00:00Z" })
    // A spent allowance without a release instant falls back to its
    // own reset (the weekly without a cooldown end).
    expect(
      planBlock({
        ...base,
        weekly: {
          percent: 100,
          resetsAt: "2026-11-16T03:00:00Z",
          blocked: true,
          releasesAt: undefined,
        },
      }),
    ).toEqual({ releasesAt: "2026-11-16T03:00:00Z" })
    // High usage without a block never locks.
    expect(
      planBlock({
        ...base,
        percent: 99,
        weekly: {
          percent: 99,
          resetsAt: "2026-11-16T03:00:00Z",
          blocked: false,
          releasesAt: undefined,
        },
      }),
    ).toBeUndefined()
  })
})

describe("usage warning push copy", () => {
  test("never names a model, provider, free/paid tier, quota, limit, credits or routing", () => {
    // The push is the client's own plan warning: the mask is absolute,
    // so the copy must not leak what runs behind the plan.
    const forbidden = [
      "opencode",
      "model",
      "modelo",
      "provider",
      "provedor",
      "free",
      "grátis",
      "gratis",
      "paid",
      "pago",
      "quota",
      "cota",
      "limit",
      "limite",
      "credit",
      "crédito",
      "credito",
      "routing",
      "roteamento",
      "us$",
    ]

    for (const dict of [dictEn, dictBr]) {
      for (const key of [
        "client.usage.warningPush.title",
        "client.usage.warningPush.body",
        "client.usage.weeklyWarningPush.title",
        "client.usage.weeklyWarningPush.body",
        "client.usage.blocked.message",
      ] as const) {
        const text = dict[key]

        expect(text).toBeDefined()

        for (const word of forbidden) {
          expect(text.toLowerCase()).not.toContain(word)
        }
      }
    }
  })
})

describe("plan usage reset countdown", () => {
  test("measures the milliseconds to the reset instant, never negative", () => {
    const now = Date.parse("2026-11-09T12:00:00Z")

    expect(planUsageResetInMs("2026-11-10T03:00:00Z", now)).toBe(15 * 3_600_000)
    expect(planUsageResetInMs("2026-11-09T12:00:00Z", now)).toBe(0)
    expect(planUsageResetInMs("2026-11-09T11:00:00Z", now)).toBe(0)
  })

  test("an unparseable reset instant means no countdown", () => {
    expect(planUsageResetInMs("meia-noite", Date.now())).toBeUndefined()
    expect(planUsageResetInMs("", Date.now())).toBeUndefined()
  })
})
