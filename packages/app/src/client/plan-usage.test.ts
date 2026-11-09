import { describe, expect, test } from "bun:test"
import { planUsageBlocks, planUsageResetInMs, planUsageTone } from "./plan-usage"

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
