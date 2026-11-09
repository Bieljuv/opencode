import { describe, expect, test } from "bun:test"
import { isGatewayActive, resolveGatewayBaseUrl, todayInSaoPaulo } from "./gateway"

describe("isGatewayActive", () => {
  test("needs the connection, the key, and the panel URL together", () => {
    const table: Array<{
      input: { connected: boolean; apiKey: string | undefined; gatewayUrl: string | undefined }
      active: boolean
    }> = [
      { input: { connected: true, apiKey: "key-1", gatewayUrl: "https://gw.exemplo/v1" }, active: true },
      { input: { connected: false, apiKey: "key-1", gatewayUrl: "https://gw.exemplo/v1" }, active: false },
      { input: { connected: true, apiKey: undefined, gatewayUrl: "https://gw.exemplo/v1" }, active: false },
      { input: { connected: true, apiKey: "key-1", gatewayUrl: undefined }, active: false },
      { input: { connected: false, apiKey: undefined, gatewayUrl: undefined }, active: false },
    ]

    for (const row of table) expect(isGatewayActive(row.input)).toBe(row.active)
  })
})

describe("resolveGatewayBaseUrl", () => {
  test("the panel URL wins, then the environment, then the package default", () => {
    const fallback = "https://painel-manostech.manostech.workers.dev/api/gateway"

    expect(
      resolveGatewayBaseUrl({
        panelUrl: "https://gw.exemplo/v1",
        env: { MANOSTECH_GATEWAY_URL: "http://127.0.0.1:9/v1" },
        fallback,
      }),
    ).toBe("https://gw.exemplo/v1")
    expect(
      resolveGatewayBaseUrl({
        panelUrl: undefined,
        env: { MANOSTECH_GATEWAY_URL: "http://127.0.0.1:9/v1" },
        fallback,
      }),
    ).toBe("http://127.0.0.1:9/v1")
    expect(resolveGatewayBaseUrl({ panelUrl: undefined, env: {}, fallback })).toBe(fallback)
  })
})

describe("todayInSaoPaulo", () => {
  test("the day follows America/Sao_Paulo, not UTC", () => {
    // 02:00 UTC is still 23:00 the day before in São Paulo (UTC-3).
    expect(todayInSaoPaulo(Date.parse("2026-11-09T02:00:00Z"))).toBe("2026-11-08")
    expect(todayInSaoPaulo(Date.parse("2026-11-09T03:00:00Z"))).toBe("2026-11-09")
    expect(todayInSaoPaulo(Date.parse("2026-11-10T02:59:59Z"))).toBe("2026-11-09")
  })
})
