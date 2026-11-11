import { createHash } from "node:crypto"
import { afterAll, describe, expect, test } from "bun:test"
import {
  authorizeUrl,
  createPkce,
  createState,
  exchangeCodeForIdToken,
  loopbackRedirectUri,
  parseAuthReturn,
  startLoopbackListener,
} from "./google"
import { nativeT } from "../native/translations"

// Um endpoint de token falso: a troca real é com o Google, mas o envio
// (form-urlencoded + PKCE) é o mesmo contra qualquer URL. O último corpo
// recebido fica guardado para os testes conferirem o que foi enviado.
let lastBody: URLSearchParams | undefined
const tokenServer = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = new URLSearchParams(await request.text())
    lastBody = body

    if (
      body.get("grant_type") === "authorization_code" &&
      body.get("code") === "code-1" &&
      body.get("client_id") === "cid" &&
      body.get("code_verifier") === "verifier" &&
      body.get("redirect_uri") === loopbackRedirectUri(51820)
    )
      return Response.json({ id_token: "idtok", access_token: "acctok" })

    if (body.get("code") === "no-idtok")
      return Response.json({ access_token: "acctok" })

    if (body.get("code") === "bad-json")
      return new Response("{não-json", { status: 200, headers: { "content-type": "application/json" } })

    return Response.json({ error: "invalid_grant" }, { status: 400 })
  },
})

const env = { MANOSTECH_GOOGLE_TOKEN_URL: `http://127.0.0.1:${tokenServer.port}` }

describe("createPkce", () => {
  test("the challenge is the S256 of the verifier", () => {
    const { verifier, challenge } = createPkce()

    expect(verifier.length).toBeGreaterThan(40)
    expect(challenge).toBe(createHash("sha256").update(verifier).digest().toString("base64url"))
  })

  test("two flows never share a verifier", () => {
    expect(createPkce().verifier).not.toBe(createPkce().verifier)
    expect(createState()).not.toBe(createState())
  })
})

describe("loopbackRedirectUri", () => {
  test("builds the loopback redirect with the ephemeral port", () => {
    expect(loopbackRedirectUri(51820)).toBe("http://127.0.0.1:51820/auth/google")
  })
})

describe("authorizeUrl", () => {
  test("the redirect is the loopback address", () => {
    const url = new URL(
      authorizeUrl({ clientId: "cid", state: "st", challenge: "ch", redirectUri: loopbackRedirectUri(51820) }),
    )

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth")
    expect(url.searchParams.get("client_id")).toBe("cid")
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:51820/auth/google")
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("state")).toBe("st")
  })
})

describe("parseAuthReturn", () => {
  test("accepts the code and state on the loopback", () => {
    expect(parseAuthReturn("http://127.0.0.1:51820/auth/google?code=abc&state=st")).toEqual({
      kind: "code",
      code: "abc",
      state: "st",
    })
  })

  test("accepts the return with a trailing slash before the query", () => {
    expect(parseAuthReturn("http://127.0.0.1:51820/auth/google/?code=abc&state=st")).toEqual({
      kind: "code",
      code: "abc",
      state: "st",
    })
  })

  test("an error return is an error, not a code", () => {
    expect(parseAuthReturn("http://127.0.0.1:51820/auth/google?error=access_denied")).toEqual({ kind: "error" })
  })

  test("an error return keeps the state when present", () => {
    expect(parseAuthReturn("http://127.0.0.1:51820/auth/google?error=access_denied&state=st")).toEqual({
      kind: "error",
      state: "st",
    })
  })

  test("the custom scheme is not a Google return anymore", () => {
    expect(parseAuthReturn("com.manostech.editor:/auth/google?code=abc&state=st")).toBeUndefined()
    expect(parseAuthReturn("manostech://auth/google?code=abc&state=st")).toBeUndefined()
  })

  test("anything else is not ours", () => {
    expect(parseAuthReturn("http://127.0.0.1:51820/auth/google")).toBeUndefined()
    expect(parseAuthReturn("http://127.0.0.1:51820/other?code=abc&state=st")).toBeUndefined()
    expect(parseAuthReturn("http://localhost:51820/auth/google?code=abc&state=st")).toBeUndefined()
    expect(parseAuthReturn("http://127.0.0.2:51820/auth/google?code=abc&state=st")).toBeUndefined()
    expect(parseAuthReturn("https://127.0.0.1:51820/auth/google?code=abc&state=st")).toBeUndefined()
    expect(parseAuthReturn("https://example.com/?code=abc&state=st")).toBeUndefined()
    expect(parseAuthReturn("com.manostech.editor:/console/authorized?window=1")).toBeUndefined()
  })
})

describe("exchangeCodeForIdToken", () => {
  test("a valid code returns the id token", async () => {
    expect(
      await exchangeCodeForIdToken(env, {
        clientId: "cid",
        code: "code-1",
        codeVerifier: "verifier",
        redirectUri: loopbackRedirectUri(51820),
      }),
    ).toEqual({ ok: true, idToken: "idtok" })
  })

  test("sends the client secret when the build has one", async () => {
    // O endpoint de token do Google exige o segredo para clientes
    // Desktop; sem ele, a troca falha com 400 invalid_request
    // (Gabriel, 3 tentativas em 2026-11-11).
    expect(
      await exchangeCodeForIdToken(env, {
        clientId: "cid",
        clientSecret: "segredo",
        code: "code-1",
        codeVerifier: "verifier",
        redirectUri: loopbackRedirectUri(51820),
      }),
    ).toEqual({ ok: true, idToken: "idtok" })
    expect(lastBody?.get("client_secret")).toBe("segredo")
  })

  test("sends no client secret when the build has none", async () => {
    expect(
      await exchangeCodeForIdToken(env, {
        clientId: "cid",
        code: "code-1",
        codeVerifier: "verifier",
        redirectUri: loopbackRedirectUri(51820),
      }),
    ).toEqual({ ok: true, idToken: "idtok" })
    expect(lastBody?.get("client_secret")).toBeNull()
  })

  test("a rejected code reports the status and the Google error code", async () => {
    expect(
      await exchangeCodeForIdToken(env, {
        clientId: "cid",
        code: "ruim",
        codeVerifier: "verifier",
        redirectUri: loopbackRedirectUri(51820),
      }),
    ).toEqual({ ok: false, failure: { reason: "rejected", status: 400, error: "invalid_grant" } })
  })

  test("a 200 without an id token is a bad response", async () => {
    expect(
      await exchangeCodeForIdToken(env, {
        clientId: "cid",
        code: "no-idtok",
        codeVerifier: "verifier",
        redirectUri: loopbackRedirectUri(51820),
      }),
    ).toEqual({ ok: false, failure: { reason: "bad-response" } })
  })

  test("a 200 with malformed JSON is a bad response", async () => {
    expect(
      await exchangeCodeForIdToken(env, {
        clientId: "cid",
        code: "bad-json",
        codeVerifier: "verifier",
        redirectUri: loopbackRedirectUri(51820),
      }),
    ).toEqual({ ok: false, failure: { reason: "bad-response" } })
  })

  test("an unreachable token endpoint is a network failure", async () => {
    const result = await exchangeCodeForIdToken(
      { MANOSTECH_GOOGLE_TOKEN_URL: "http://127.0.0.1:1" },
      {
        clientId: "cid",
        code: "code-1",
        codeVerifier: "verifier",
        redirectUri: loopbackRedirectUri(51820),
      },
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.reason).toBe("network")
    if (result.failure.reason !== "network") return
    expect(result.failure.error.length).toBeGreaterThan(0)
  })
})

describe("startLoopbackListener", () => {
  test("the redirect is loopback on an ephemeral port", async () => {
    const listener = await startLoopbackListener("st")

    try {
      const redirect = new URL(listener.redirectUri)

      expect(redirect.protocol).toBe("http:")
      expect(redirect.hostname).toBe("127.0.0.1")
      expect(redirect.port).not.toBe("")
      expect(redirect.pathname).toBe("/auth/google")
    } finally {
      listener.close()
    }
  })

  test("captures the code and answers with the success page", async () => {
    const listener = await startLoopbackListener("st")

    try {
      const response = await fetch(`${listener.redirectUri}?code=abc&state=st`)

      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("text/html")
      expect(await response.text()).toContain(nativeT("desktop.google.loopback.success.title"))
      await expect(listener.code).resolves.toEqual({ kind: "code", code: "abc", state: "st" })
    } finally {
      listener.close()
    }
  })

  test("an error return resolves as an error with the error page", async () => {
    const listener = await startLoopbackListener("st")

    try {
      const response = await fetch(`${listener.redirectUri}?error=access_denied&state=st`)

      expect(response.status).toBe(200)
      expect(await response.text()).toContain(nativeT("desktop.google.loopback.error.title"))
      await expect(listener.code).resolves.toEqual({ kind: "error", state: "st" })
    } finally {
      listener.close()
    }
  })

  test("a wrong state is refused and the listener keeps waiting", async () => {
    const listener = await startLoopbackListener("st")

    try {
      const refused = await fetch(`${listener.redirectUri}?code=abc&state=wrong`)

      expect(refused.status).toBe(400)

      const response = await fetch(`${listener.redirectUri}?code=abc&state=st`)

      expect(response.status).toBe(200)
      await expect(listener.code).resolves.toEqual({ kind: "code", code: "abc", state: "st" })
    } finally {
      listener.close()
    }
  })

  test("a path outside the return is refused and the listener keeps waiting", async () => {
    const listener = await startLoopbackListener("st")

    try {
      const origin = new URL(listener.redirectUri).origin
      const refused = await fetch(`${origin}/other?code=abc&state=st`)

      expect(refused.status).toBe(404)

      const response = await fetch(`${listener.redirectUri}?code=abc&state=st`)

      expect(response.status).toBe(200)
      await expect(listener.code).resolves.toEqual({ kind: "code", code: "abc", state: "st" })
    } finally {
      listener.close()
    }
  })

  test("the listener closes after resolving", async () => {
    const listener = await startLoopbackListener("st")

    try {
      await fetch(`${listener.redirectUri}?code=abc&state=st`)
      await expect(listener.code).resolves.toEqual({ kind: "code", code: "abc", state: "st" })
      await expect(fetch(`${listener.redirectUri}?code=abc&state=st`)).rejects.toThrow()
    } finally {
      listener.close()
    }
  })
})

afterAll(() => tokenServer.stop())
