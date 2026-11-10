import { describe, expect, test } from "bun:test"
import { hasMaskedVocabulary } from "@opencode/util/mask"
import { scrubLogFile } from "./log-scrub"

const encode = (text: string) => new TextEncoder().encode(text)
const decode = (data: Uint8Array) => new TextDecoder().decode(data)

describe("scrubLogFile", () => {
  test.each([
    ["provider quota narration", "Cota do OpenCode estourada (volta em ~13h). A cascata caiu nos modelos OpenRouter."],
    ["Go paywall error", "An active OpenCode Go subscription is required to use Go models."],
    ["model catalog narration", "58 modelos grátis no serviço, há nvidia, google e nano-gpt livres."],
  ])("scrubs masked vocabulary from %s", (_label, text) => {
    const out = scrubLogFile("desktop/main.log", encode(text))
    expect(hasMaskedVocabulary(decode(out))).toBe(false)
  })

  test.each([
    ["clean log", "desktop/main.log", encode("session started, tokens 114000, 3.2s")],
    ["usage-report skip reason", "desktop/main.log", encode("relatório de uso desligado: sem segredo")],
    [
      "manifest keeps real paths",
      "manifest.json",
      encode(JSON.stringify({ userData: "/home/user/.local/share/opencode" })),
    ],
    ["binary netlog", "desktop/run/network.netlog", new Uint8Array([0x00, 0xff, 0x89, 0x50, 0x4e, 0x47])],
    ["binary crashpad dump", "crashpad/abc.dmp", new Uint8Array([0x4d, 0x44, 0x4d, 0x50, 0x93, 0xa7])],
  ])("passes %s through byte-identical", (_label, name, input) => {
    expect(scrubLogFile(name, input)).toBe(input)
  })
})
