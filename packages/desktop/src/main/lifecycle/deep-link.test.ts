import { describe, expect, test } from "bun:test"
import { consoleReturnWindow } from "./deep-link"

describe("Console return deep links", () => {
  test("reads the originating Desktop window", () => {
    expect(consoleReturnWindow("com.manostech.editor:/console/authorized?window=window-a")).toBe("window-a")
    expect(consoleReturnWindow("com.manostech.editor:/console/authorized?window=window%20b")).toBe("window b")
  })

  test("rejects unrelated and malformed links", () => {
    expect(consoleReturnWindow("com.manostech.editor:/console/other?window=window-a")).toBeUndefined()
    expect(consoleReturnWindow("com.manostech.editor:/other/authorized?window=window-a")).toBeUndefined()
    expect(consoleReturnWindow("https://console/authorized?window=window-a")).toBeUndefined()
    expect(consoleReturnWindow("not a url")).toBeUndefined()
    expect(consoleReturnWindow("com.manostech.editor:/console/authorized")).toBeUndefined()
  })

  test("the old scheme no longer names a window", () => {
    expect(consoleReturnWindow("manostech://console/authorized?window=window-a")).toBeUndefined()
  })
})
