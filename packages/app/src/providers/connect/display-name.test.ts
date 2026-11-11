import { describe, expect, test } from "bun:test"
import { maskConnectorDisplayName } from "./display-name"

describe("maskConnectorDisplayName", () => {
  test("the internal product name reads as the product brand", () => {
    expect(maskConnectorDisplayName("opencode")).toBe("ManosTech.AI")
    expect(maskConnectorDisplayName("Opencode Docs")).toBe("ManosTech.AI Docs")
    expect(maskConnectorDisplayName("my-opencode-server")).toBe("my-ManosTech.AI-server")
  })

  test("a connector the user named themselves stays verbatim", () => {
    expect(maskConnectorDisplayName("github")).toBe("github")
    expect(maskConnectorDisplayName("meu-servidor")).toBe("meu-servidor")
    expect(maskConnectorDisplayName("")).toBe("")
  })
})
