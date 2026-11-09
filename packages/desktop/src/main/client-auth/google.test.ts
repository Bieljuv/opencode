import { createHash } from "node:crypto"
import { afterAll, describe, expect, test } from "bun:test"
import { authorizeUrl, createPkce, createState, exchangeCodeForIdToken, parseAuthReturn } from "./google"

// Um endpoint de token falso: a troca real é com o Google, mas o envio
// (form-urlencoded + PKCE) é o mesmo contra qualquer URL.
const tokenServer = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = new URLSearchParams(await request.text())

    if (
      body.get("grant_type") === "authorization_code" &&
      body.get("code") === "code-1" &&
      body.get("client_id") === "cid" &&
      body.get("code_verifier") === "verifier" &&
      body.get("redirect_uri") === "manostech://auth/google"
    )
      return Response.json({ id_token: "idtok", access_token: "acctok" })

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

describe("authorizeUrl", () => {
  test("builds the Google authorize URL with the app deep-link return", () => {
    const url = new URL(authorizeUrl({ clientId: "cid", state: "st", challenge: "ch" }))

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth")
    expect(url.searchParams.get("client_id")).toBe("cid")
    expect(url.searchParams.get("redirect_uri")).toBe("manostech://auth/google")
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("state")).toBe("st")
  })
})

describe("parseAuthReturn", () => {
  test("accepts the code and state", () => {
    expect(parseAuthReturn("manostech://auth/google?code=abc&state=st")).toEqual({
      kind: "code",
      code: "abc",
      state: "st",
    })
  })

  test("an error return is an error, not a code", () => {
    expect(parseAuthReturn("manostech://auth/google?error=access_denied")).toEqual({ kind: "error" })
  })

  test("anything else is not ours", () => {
    expect(parseAuthReturn("manostech://console/authorized?window=1")).toBeUndefined()
    expect(parseAuthReturn("manostech://auth/google")).toBeUndefined()
    expect(parseAuthReturn("https://example.com/?code=abc&state=st")).toBeUndefined()
  })
})

describe("exchangeCodeForIdToken", () => {
  test("a valid code returns the id token", async () => {
    expect(
      await exchangeCodeForIdToken(env, { clientId: "cid", code: "code-1", codeVerifier: "verifier" }),
    ).toBe("idtok")
  })

  test("a rejected code returns undefined", async () => {
    expect(await exchangeCodeForIdToken(env, { clientId: "cid", code: "ruim", codeVerifier: "verifier" })).toBe(
      undefined,
    )
  })
})

afterAll(() => tokenServer.stop())
