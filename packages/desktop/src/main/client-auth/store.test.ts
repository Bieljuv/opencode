import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createSettingsStore } from "../storage/store"
import {
  MANOSTECH_CLIENT_API_KEY_KEY,
  MANOSTECH_GATEWAY_URL_KEY,
  MANOSTECH_USAGE_WARNED_KEY,
  MANOSTECH_USAGE_WEEKLY_WARNED_KEY,
} from "../storage/keys"

// The gateway credential lives in the main-process store (`getStore` needs
// Electron), so the contract here is the persisted key itself — the exact
// string the next build must keep reading — plus the round-trip through
// the store that backs it. A renamed key would silently orphan every
// saved client key, so the name is the test.
describe("gateway store keys", () => {
  test("the client key, gateway URL, and warned day keep their persisted names", () => {
    expect(MANOSTECH_CLIENT_API_KEY_KEY).toBe("manostech.client.apiKey")
    expect(MANOSTECH_GATEWAY_URL_KEY).toBe("manostech.gateway.url")
    expect(MANOSTECH_USAGE_WARNED_KEY).toBe("manostech.client.usageWarned")
    expect(MANOSTECH_USAGE_WEEKLY_WARNED_KEY).toBe("manostech.client.usageWeeklyWarned")
  })

  test("the key, URL, and warned day round-trip through the settings store", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "opencode-gateway-")), "opencode.settings")
    const store = createSettingsStore(file)

    store.set(MANOSTECH_CLIENT_API_KEY_KEY, "key-1")
    store.set(MANOSTECH_GATEWAY_URL_KEY, "https://gw.exemplo/v1")
    store.set(MANOSTECH_USAGE_WARNED_KEY, "2026-11-09")
    store.set(MANOSTECH_USAGE_WEEKLY_WARNED_KEY, "2026-11-09T03:00:00Z")

    const reopened = createSettingsStore(file)
    expect(reopened.get(MANOSTECH_CLIENT_API_KEY_KEY)).toBe("key-1")
    expect(reopened.get(MANOSTECH_GATEWAY_URL_KEY)).toBe("https://gw.exemplo/v1")
    expect(reopened.get(MANOSTECH_USAGE_WARNED_KEY)).toBe("2026-11-09")
    expect(reopened.get(MANOSTECH_USAGE_WEEKLY_WARNED_KEY)).toBe("2026-11-09T03:00:00Z")

    reopened.delete(MANOSTECH_CLIENT_API_KEY_KEY)
    reopened.delete(MANOSTECH_GATEWAY_URL_KEY)
    reopened.delete(MANOSTECH_USAGE_WARNED_KEY)
    reopened.delete(MANOSTECH_USAGE_WEEKLY_WARNED_KEY)
    expect(createSettingsStore(file).get(MANOSTECH_CLIENT_API_KEY_KEY)).toBeUndefined()
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({})
  })
})
