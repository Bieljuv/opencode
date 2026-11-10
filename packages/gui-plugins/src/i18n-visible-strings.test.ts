import { describe, expect, test } from "bun:test"
import browserBr from "./browser/i18n/br"
import browserEn from "./browser/i18n/en"
import debugBr from "./debug/i18n/br"
import debugEn from "./debug/i18n/en"
import detailsBr from "./details/i18n/br"
import detailsEn from "./details/i18n/en"
import pairingEn from "./pairing/i18n/en"
import sshBr from "./ssh/i18n/br"
import sshEn from "./ssh/i18n/en"
import terminalBr from "./terminal/i18n/br"
import terminalEn from "./terminal/i18n/en"
import wslBr from "./wsl/i18n/br"
import wslEn from "./wsl/i18n/en"

describe("visible strings", () => {
  test("never name OpenCode", async () => {
    // The product never shows its upstream name in plugin copy: the server is "the server" and
    // the app is "the app". Config file names never appear either.
    const dictionaries = [
      ["browser-br", browserBr],
      ["browser-en", browserEn],
      ["debug-br", debugBr],
      ["debug-en", debugEn],
      ["details-br", detailsBr],
      ["details-en", detailsEn],
      ["pairing-en", pairingEn],
      ["ssh-br", sshBr],
      ["ssh-en", sshEn],
      ["terminal-br", terminalBr],
      ["terminal-en", terminalEn],
      ["wsl-br", wslBr],
      ["wsl-en", wslEn],
    ] as const

    const violations = dictionaries.flatMap(([locale, dict]) =>
      Object.entries(dict).flatMap(([key, value]) => {
        const problems: string[] = []
        if (value.includes("opencode.json") || value.includes("cli.json")) problems.push("names a config file")
        if (value.toLowerCase().includes("opencode")) problems.push("names OpenCode")
        return problems.map((problem) => `${locale}:${key} ${problem}: ${JSON.stringify(value)}`)
      }),
    )

    expect(violations).toEqual([])
  })
})
