import { afterAll, describe, expect, test } from "bun:test"
import {
  changePassword,
  ensureApiKey,
  fetchApiKey,
  fetchDailyUsage,
  forgotPassword,
  googleLogin,
  login,
  trialStatus,
  validateSession,
} from "./panel"

const client = { id: "c-1", name: "Ana", email: "ana@exemplo.com", plan: "desktop", ai_mode: "gratis" }

// Um painel falso que responde exatamente como o painel ao vivo
// (deploy b15b91a0): login sem expires_at nem trial, /sessao no lugar
// de /eu, trocar-senha com { nova_senha }, Google com id_token.
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    const body: Record<string, unknown> =
      request.method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {}

    if (url.pathname === "/api/auth/cliente/login" && request.method === "POST") {
      if (body.origin !== "desktop" || typeof body.device_id !== "string")
        return Response.json({ erro: "informe e-mail, senha, origin e device_id válidos" }, { status: 400 })

      // O painel, com o gateway, devolve a chave do cliente e a URL do
      // gateway junto do login; sem elas, o app mantém o guardado.
      return Response.json(
        { token: "tok-1", mustChange: false, client, api_key: "key-1", gateway_url: "https://gw.exemplo/v1" },
        { status: 200 },
      )
    }

    if (url.pathname === "/api/uso" && request.method === "GET") {
      if (request.headers.get("authorization") !== "Bearer key-1")
        return Response.json({ erro: "não autorizado" }, { status: 401 })

      return Response.json({ usado_percentual: 85, reseta_em: "2026-11-10T03:00:00Z" }, { status: 200 })
    }

    if (url.pathname === "/api/auth/cliente/trocar-senha" && request.method === "POST") {
      if (request.headers.get("authorization") !== "Bearer tok-1")
        return Response.json({ erro: "não autorizado" }, { status: 401 })

      if (typeof body.nova_senha !== "string" || body.nova_senha.length < 8)
        return Response.json({ erro: "a nova senha tem que ter pelo menos 8 caracteres" }, { status: 400 })

      return Response.json({ ok: true }, { status: 200 })
    }

    if (url.pathname === "/api/auth/cliente/esqueci-senha" && request.method === "POST") {
      if (typeof body.email !== "string" || !body.email.includes("@"))
        return Response.json({ erro: "informe um e-mail válido" }, { status: 400 })

      // O painel responde a mesma mensagem genérica exista o e-mail ou
      // não; o app nunca mostra o texto do servidor.
      return Response.json(
        { ok: true, mensagem: "Se o e-mail estiver cadastrado, você receberá uma senha temporária." },
        { status: 200 },
      )
    }

    if (url.pathname === "/api/auth/cliente/sessao" && request.method === "GET")
      return request.headers.get("authorization") === "Bearer tok-1"
        ? Response.json({
            client,
            mustChange: false,
            origin: "desktop",
            device_id: "dev-1",
            expires_at: "2026-12-09T03:27:00Z",
            api_key: "key-2",
            gateway_url: "https://gw.exemplo/v1",
          })
        : Response.json({ erro: "não autorizado" }, { status: 401 })

    if (url.pathname === "/api/auth/google" && request.method === "POST") {
      if (body.token !== "idtok" || body.origin !== "desktop")
        return Response.json({ erro: "token do Google inválido" }, { status: 401 })

      return Response.json(
        {
          token: "tok-1",
          mustChange: false,
          client: { ...client, trial_ends_at: "2026-11-09T06:00:00Z", is_trial: true },
          trial_ends_at: "2026-11-09T06:00:00Z",
          is_trial: true,
          api_key: "key-1",
          gateway_url: "https://gw.exemplo/v1",
        },
        { status: 200 },
      )
    }

    return Response.json({ erro: "não encontrado" }, { status: 404 })
  },
})

const base = `http://127.0.0.1:${server.port}`

describe("trialStatus", () => {
  test("no end means a paid account", () => {
    expect(trialStatus(null, Date.parse("2026-11-09T04:00:00Z"))).toBe("paid")
  })

  test("before the end is a trial, after it is expired", () => {
    expect(trialStatus("2026-11-09T06:00:00Z", Date.parse("2026-11-09T05:59:59Z"))).toBe("trial")
    expect(trialStatus("2026-11-09T06:00:00Z", Date.parse("2026-11-09T06:00:00Z"))).toBe("trial-expired")
  })
})

describe("login", () => {
  test("a valid login returns the session, with no trial and no expiry yet", async () => {
    const result = await login(base, { email: "ana@exemplo.com", password: "senha", deviceId: "dev-1" })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.token).toBe("tok-1")
      expect(result.value.client.email).toBe("ana@exemplo.com")
      expect(result.value.trial_ends_at).toBeNull()
      expect(result.value.expires_at).toBeNull()
    }
  })

  test("a login that carries the gateway key and URL passes them through", async () => {
    const result = await login(base, { email: "ana@exemplo.com", password: "senha", deviceId: "dev-1" })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.apiKey).toBe("key-1")
      expect(result.value.gatewayUrl).toBe("https://gw.exemplo/v1")
    }
  })

  test("a login without gateway fields leaves them undefined (keeps the stored ones)", async () => {
    const plain = Bun.serve({
      port: 0,
      fetch: () => Response.json({ token: "tok-1", mustChange: false, client }, { status: 200 }),
    })

    try {
      const result = await login(`http://127.0.0.1:${plain.port}`, {
        email: "ana@exemplo.com",
        password: "senha",
        deviceId: "dev-1",
      })

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.apiKey).toBeUndefined()
        expect(result.value.gatewayUrl).toBeUndefined()
      }
    } finally {
      plain.stop()
    }
  })

  test("a login whose current key is still valid returns api_key null and stays logged in", async () => {
    // O painel devolve api_key: null quando a chave corrente ainda vale
    // (só devolve em claro uma chave nova). Antes, o null quebrava o
    // decode e o login caía em "unknown" para todo cliente recorrente.
    const plain = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json(
          { token: "tok-1", mustChange: false, client, api_key: null, gateway_url: null },
          { status: 200 },
        ),
    })

    try {
      const result = await login(`http://127.0.0.1:${plain.port}`, {
        email: "ana@exemplo.com",
        password: "senha",
        deviceId: "dev-1",
      })

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.apiKey).toBeUndefined()
        expect(result.value.gatewayUrl).toBeUndefined()
      }
    } finally {
      plain.stop()
    }
  })

  test("a wrong password maps to invalid-credentials", async () => {
    const failing = Bun.serve({
      port: 0,
      fetch: () => Response.json({ erro: "E-mail ou senha inválidos." }, { status: 401 }),
    })

    try {
      const result = await login(`http://127.0.0.1:${failing.port}`, {
        email: "ana@exemplo.com",
        password: "errada",
        deviceId: "dev-1",
      })

      expect(result).toEqual({ ok: false, error: { tag: "invalid-credentials" } })
    } finally {
      failing.stop()
    }
  })

  test("an expired trial maps to trial-expired, from the live erro field", async () => {
    const failing = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json(
          { erro: "teste_expirado", mensagem: "O período de teste de 3 horas terminou." },
          { status: 403 },
        ),
    })

    try {
      const result = await login(`http://127.0.0.1:${failing.port}`, {
        email: "ana@exemplo.com",
        password: "senha",
        deviceId: "dev-1",
      })

      expect(result).toEqual({ ok: false, error: { tag: "trial-expired" } })
    } finally {
      failing.stop()
    }
  })

  test("an unreachable panel maps to network", async () => {
    const result = await login("http://127.0.0.1:1", { email: "a@b.com", password: "x", deviceId: "dev-1" })

    expect(result).toEqual({ ok: false, error: { tag: "network" } })
  })
})

describe("forgotPassword", () => {
  test("a 200 answers ok, whatever the email", async () => {
    const result = await forgotPassword(base, "ana@exemplo.com")

    expect(result).toEqual({ ok: true, value: { sent: true } })
  })

  test("a rate-limited recovery maps to unknown (the screen stays generic)", async () => {
    const limited = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({ erro: "Muitas tentativas. Tente novamente em alguns minutos." }, { status: 429 }),
    })

    try {
      const result = await forgotPassword(`http://127.0.0.1:${limited.port}`, "ana@exemplo.com")

      expect(result).toEqual({ ok: false, error: { tag: "unknown" } })
    } finally {
      limited.stop()
    }
  })

  test("an unreachable panel maps to network", async () => {
    const result = await forgotPassword("http://127.0.0.1:1", "ana@exemplo.com")

    expect(result).toEqual({ ok: false, error: { tag: "network" } })
  })
})

describe("changePassword", () => {
  test("a successful change clears mustChange", async () => {
    const result = await changePassword(base, { token: "tok-1", next: "nova-senha" })

    expect(result).toEqual({ ok: true, value: { mustChange: false } })
  })

  test("a short password maps to password-too-short", async () => {
    const result = await changePassword(base, { token: "tok-1", next: "curta" })

    expect(result).toEqual({ ok: false, error: { tag: "password-too-short" } })
  })
})

describe("validateSession", () => {
  test("a valid token returns the session info, without a new token", async () => {
    const result = await validateSession(base, "tok-1")

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.client.email).toBe("ana@exemplo.com")
      expect(result.value.expires_at).toBe("2026-12-09T03:27:00Z")
      expect(result.value.mustChange).toBe(false)
    }
  })

  test("a session validation that renews the key passes the new one through", async () => {
    const result = await validateSession(base, "tok-1")

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.apiKey).toBe("key-2")
      expect(result.value.gatewayUrl).toBe("https://gw.exemplo/v1")
    }
  })

  test("a revoked token maps to invalid-credentials", async () => {
    const result = await validateSession(base, "tok-revogado")

    expect(result).toEqual({ ok: false, error: { tag: "invalid-credentials" } })
  })
})

describe("googleLogin", () => {
  test("a valid id token returns a session with the trial end", async () => {
    const result = await googleLogin(base, { idToken: "idtok", deviceId: "dev-1" })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.token).toBe("tok-1")
      expect(result.value.trial_ends_at).toBe("2026-11-09T06:00:00Z")
      expect(result.value.client.email).toBe("ana@exemplo.com")
    }
  })

  test("a Google login that carries the gateway key and URL passes them through", async () => {
    const result = await googleLogin(base, { idToken: "idtok", deviceId: "dev-1" })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.apiKey).toBe("key-1")
      expect(result.value.gatewayUrl).toBe("https://gw.exemplo/v1")
    }
  })

  test("a rejected id token maps to google-unavailable", async () => {
    const result = await googleLogin(base, { idToken: "ruim", deviceId: "dev-1" })

    expect(result).toEqual({ ok: false, error: { tag: "google-unavailable" } })
  })
})

describe("fetchDailyUsage", () => {
  test("a valid key returns the daily percent and the reset instant", async () => {
    expect(await fetchDailyUsage(base, "key-1")).toEqual({
      percent: 85,
      resetsAt: "2026-11-10T03:00:00Z",
    })
  })

  test("a response without a weekly object hides only the weekly bar", async () => {
    const usage = await fetchDailyUsage(base, "key-1")

    expect(usage?.weekly).toBeUndefined()
  })

  test("a weekly object comes back with the daily one", async () => {
    const weekly = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          usado_percentual: 40,
          reseta_em: "2026-11-10T03:00:00Z",
          semanal: {
            limite_tokens: 80_000_000,
            usado_tokens: 69_600_000,
            usado_percentual: 87,
            bloqueado: false,
            liberacao_em: null,
            reseta_em: "2026-11-17T03:00:00Z",
          },
        }),
    })

    try {
      expect(await fetchDailyUsage(`http://127.0.0.1:${weekly.port}`, "key-1")).toEqual({
        percent: 40,
        resetsAt: "2026-11-10T03:00:00Z",
        weekly: { percent: 87, resetsAt: "2026-11-17T03:00:00Z", blocked: false, releasesAt: undefined },
      })
    } finally {
      weekly.stop()
    }
  })

  test("a blocked week carries the release instant", async () => {
    const blocked = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          usado_percentual: 100,
          reseta_em: "2026-11-10T03:00:00Z",
          semanal: {
            limite_tokens: 80_000_000,
            usado_tokens: 80_000_000,
            usado_percentual: 100,
            bloqueado: true,
            liberacao_em: "2026-11-10T17:00:00Z",
            reseta_em: "2026-11-17T03:00:00Z",
          },
        }),
    })

    try {
      const usage = await fetchDailyUsage(`http://127.0.0.1:${blocked.port}`, "key-1")

      expect(usage?.weekly).toEqual({
        percent: 100,
        resetsAt: "2026-11-17T03:00:00Z",
        blocked: true,
        releasesAt: "2026-11-10T17:00:00Z",
      })
    } finally {
      blocked.stop()
    }
  })

  test("no weekly limit, or a malformed weekly object, hides only the weekly bar", async () => {
    const noLimit = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          usado_percentual: 40,
          reseta_em: "2026-11-10T03:00:00Z",
          semanal: {
            limite_tokens: null,
            usado_tokens: 0,
            usado_percentual: 0,
            bloqueado: false,
            liberacao_em: null,
            reseta_em: "2026-11-17T03:00:00Z",
          },
        }),
    })

    const malformed = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          usado_percentual: 40,
          reseta_em: "2026-11-10T03:00:00Z",
          semanal: {
            limite_tokens: 80_000_000,
            usado_tokens: 0,
            usado_percentual: 150,
            bloqueado: false,
            liberacao_em: null,
            reseta_em: "2026-11-17T03:00:00Z",
          },
        }),
    })

    try {
      const withoutLimit = await fetchDailyUsage(`http://127.0.0.1:${noLimit.port}`, "key-1")

      expect(withoutLimit?.percent).toBe(40)
      expect(withoutLimit?.weekly).toBeUndefined()

      const malformedUsage = await fetchDailyUsage(`http://127.0.0.1:${malformed.port}`, "key-1")

      expect(malformedUsage?.percent).toBe(40)
      expect(malformedUsage?.weekly).toBeUndefined()
    } finally {
      noLimit.stop()
      malformed.stop()
    }
  })

  test("a wrong key, a bad shape, and an unreachable panel all mean no data (fail-open)", async () => {
    expect(await fetchDailyUsage(base, "key-errada")).toBeUndefined()
    expect(await fetchDailyUsage("http://127.0.0.1:1", "key-1")).toBeUndefined()

    const outOfRange = Bun.serve({
      port: 0,
      fetch: () => Response.json({ usado_percentual: 150, reseta_em: "2026-11-10T03:00:00Z" }),
    })

    try {
      expect(await fetchDailyUsage(`http://127.0.0.1:${outOfRange.port}`, "key-1")).toBeUndefined()
    } finally {
      outOfRange.stop()
    }
  })
})

describe("fetchApiKey", () => {
  test("a newly generated key comes back in clear", async () => {
    const fresh = Bun.serve({
      port: 0,
      fetch: (request) => {
        if (request.headers.get("authorization") !== "Bearer tok-1")
          return Response.json({ erro: "não autorizado" }, { status: 401 })

        return Response.json(
          {
            api_key: "key-2",
            key_prefix: "mk_key-2",
            plan: "desktop",
            cycle_start_at: "2026-11-09T03:00:00Z",
            renews_at: "2026-12-09T03:00:00Z",
            gerada_agora: true,
          },
          { status: 200 },
        )
      },
    })

    try {
      expect(await fetchApiKey(`http://127.0.0.1:${fresh.port}`, "tok-1")).toBe("key-2")
    } finally {
      fresh.stop()
    }
  })

  test("a still-valid current key returns null and keeps the stored one", async () => {
    const current = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json(
          {
            api_key: null,
            key_prefix: "mk_key-1",
            plan: "desktop",
            cycle_start_at: "2026-10-09T03:00:00Z",
            renews_at: "2026-12-09T03:00:00Z",
            gerada_agora: false,
          },
          { status: 200 },
        ),
    })

    try {
      expect(await fetchApiKey(`http://127.0.0.1:${current.port}`, "tok-1")).toBeUndefined()
    } finally {
      current.stop()
    }
  })

  test("a revoked token and an unreachable panel mean no key (fail-open)", async () => {
    const revoked = Bun.serve({
      port: 0,
      fetch: () => Response.json({ erro: "não autorizado" }, { status: 401 }),
    })

    try {
      expect(await fetchApiKey(`http://127.0.0.1:${revoked.port}`, "tok-1")).toBeUndefined()
    } finally {
      revoked.stop()
    }

    expect(await fetchApiKey("http://127.0.0.1:1", "tok-1")).toBeUndefined()
  })
})

describe("ensureApiKey", () => {
  // Um painel que conta quantas vezes a rota da chave foi chamada: o
  // contrato aqui é QUANDO o app busca — sem chave guardada (o caso do
  // login num aparelho novo) ou com o ciclo mensal vencido — e não só o
  // que a rota devolve (isso o `fetchApiKey` acima já prova).
  function keyServer(mode: "fresh" | "null" | "unauthorized") {
    let hits = 0
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        if (new URL(request.url).pathname !== "/api/auth/cliente/api-key")
          return Response.json({ erro: "não encontrado" }, { status: 404 })

        hits += 1

        if (mode === "unauthorized") return Response.json({ erro: "não autorizado" }, { status: 401 })
        if (request.headers.get("authorization") !== "Bearer tok-1")
          return Response.json({ erro: "não autorizado" }, { status: 401 })

        return Response.json(
          {
            api_key: mode === "fresh" ? "key-2" : null,
            key_prefix: "mk_key-2",
            plan: "desktop",
            cycle_start_at: "2026-11-09T03:00:00Z",
            renews_at: "2026-12-09T03:00:00Z",
            gerada_agora: mode === "fresh",
          },
          { status: 200 },
        )
      },
    })

    return { base: `http://127.0.0.1:${server.port}`, hits: () => hits, stop: () => server.stop() }
  }

  test("a stored key that is not due is never fetched", async () => {
    const server = keyServer("fresh")

    try {
      expect(await ensureApiKey(server.base, { token: "tok-1", storedApiKey: "key-1" })).toBeUndefined()
      expect(server.hits()).toBe(0)
    } finally {
      server.stop()
    }
  })

  test("a stored key whose cycle ended is fetched again", async () => {
    const server = keyServer("fresh")

    try {
      expect(
        await ensureApiKey(server.base, { token: "tok-1", storedApiKey: "key-1", renewsDue: true }),
      ).toBe("key-2")
      expect(server.hits()).toBe(1)
    } finally {
      server.stop()
    }
  })

  test("no stored key fetches the key right away", async () => {
    const server = keyServer("fresh")

    try {
      expect(await ensureApiKey(server.base, { token: "tok-1", storedApiKey: undefined })).toBe("key-2")
      expect(server.hits()).toBe(1)
    } finally {
      server.stop()
    }
  })

  test("no stored key and no new key from the panel means nothing to save", async () => {
    const server = keyServer("null")

    try {
      expect(await ensureApiKey(server.base, { token: "tok-1", storedApiKey: undefined })).toBeUndefined()
      expect(server.hits()).toBe(1)
    } finally {
      server.stop()
    }
  })

  test("a revoked token and an unreachable panel mean no key (fail-open)", async () => {
    const server = keyServer("unauthorized")

    try {
      expect(await ensureApiKey(server.base, { token: "tok-1", storedApiKey: undefined })).toBeUndefined()
      expect(server.hits()).toBe(1)
    } finally {
      server.stop()
    }

    expect(await ensureApiKey("http://127.0.0.1:1", { token: "tok-1", storedApiKey: undefined })).toBeUndefined()
  })
})

afterAll(() => server.stop())
