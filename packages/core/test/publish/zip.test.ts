import { describe, expect, test } from "bun:test"
import { crc32, createZip } from "@opencode/core/publish/zip"

const text = new TextEncoder()
const decode = new TextDecoder()

describe("createZip", () => {
  test("a known entry keeps its bytes verbatim with the right crc", () => {
    const content = text.encode("hello")
    const zip = createZip([{ path: "hello.txt", content }])
    expect(zip[0]).toBe(0x50)
    expect(zip[1]).toBe(0x4b)
    expect(crc32(content)).toBe(0x3610a686)
    // The stored bytes follow the local header (30 bytes) plus the name.
    const nameOffset = 30
    expect(decode.decode(zip.slice(nameOffset, nameOffset + 9))).toBe("hello.txt")
    expect(decode.decode(zip.slice(nameOffset + 9, nameOffset + 14))).toBe("hello")
  })

  test("the same entries always produce the same bytes", () => {
    const entries = [{ path: "a.txt", content: text.encode("a") }]
    expect(createZip(entries)).toEqual(createZip(entries))
  })

  test("an empty archive is a valid end-of-central-directory record", () => {
    const zip = createZip([])
    expect(zip.length).toBe(22)
    expect(zip[0]).toBe(0x50)
    expect(zip[1]).toBe(0x4b)
    expect(zip[2]).toBe(0x05)
    expect(zip[3]).toBe(0x06)
  })

  test("nested paths keep their slashes", () => {
    const zip = createZip([{ path: "src/app.ts", content: text.encode("x") }])
    expect(decode.decode(zip)).toContain("src/app.ts")
  })
})
