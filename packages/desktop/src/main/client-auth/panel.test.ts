import { afterAll, describe, expect, test } from "bun:test"
import {
  changePassword,
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

      return Response.json({ token: "tok-1", mustChange: false, client }, { status: 200 })
    }

    if (url.pathname === "/api/auth/cliente/trocar-senha" && request.method === "POST") {
      if (request.headers.get("authorization") !== "Bearer tok-1")
        return Response.json({ erro: "não autorizado" }, { status: 401 })

      if (typeof body.nova_senha !== "string" || body.nova_senha.length < 8)
        return Response.json({ erro: "a nova senha tem que ter pelo menos 8 caracteres" }, { status: 400 })

      return Response.json({ ok: true }, { status: 200 })
    }

    if (url.pathname === "/api/auth/cliente/sessao" && request.method === "GET")
      return request.headers.get("authorization") === "Bearer tok-1"
        ? Response.json({
            client,
            mustChange: false,
            origin: "desktop",
            device_id: "dev-1",
            expires_at: "2026-12-09T03:27:00Z",
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

  test("a rejected id token maps to google-unavailable", async () => {
    const result = await googleLogin(base, { idToken: "ruim", deviceId: "dev-1" })

    expect(result).toEqual({ ok: false, error: { tag: "google-unavailable" } })
  })
})

afterAll(() => server.stop())
