import { describe, expect, test } from "bun:test"
import {
  planUsageBlocks,
  planUsageResetInMs,
  planUsageTone,
  planUsageToneClass,
  shouldShowUsageWarning,
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
  test("fires at 85% in the app-root watcher, once a day, and never below it or after being warned", () => {
    const usage = (percent: number, warnedToday: boolean): PlanUsage => ({
      percent,
      resetsAt: "2026-11-11T03:00:00Z",
      warnedToday,
      blocked: false,
    })

    expect(shouldShowUsageWarning(usage(84, false), true)).toBe(false)
    expect(shouldShowUsageWarning(usage(85, false), true)).toBe(true)
    expect(shouldShowUsageWarning(usage(100, false), true)).toBe(true)
    expect(shouldShowUsageWarning(usage(150, false), true)).toBe(true)
    // Warned today: the push stays off until tomorrow.
    expect(shouldShowUsageWarning(usage(85, true), true)).toBe(false)
    expect(shouldShowUsageWarning(usage(100, true), true)).toBe(false)
    // Without the watcher (e.g. the Settings usage screen) there is no warning.
    expect(shouldShowUsageWarning(usage(100, false))).toBe(false)
    expect(shouldShowUsageWarning(usage(100, false), false)).toBe(false)
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
      for (const key of ["client.usage.warningPush.title", "client.usage.warningPush.body"] as const) {
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
