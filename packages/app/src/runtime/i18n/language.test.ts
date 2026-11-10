import { describe, expect, test } from "bun:test"
import { DESKTOP_NATIVE_LOCALES } from "./desktop-native"
import { localizedListParts, richTemplateParts } from "./language"

describe("rich translations", () => {
  test("lets the translated phrase position a rich slot", () => {
    const names = { type: "names" }
    expect(richTemplateParts("Written by {{names}}", { names })).toEqual(["Written by ", names])
    expect(richTemplateParts("{{names}} tarafından yazıldı", { names })).toEqual([names, " tarafından yazıldı"])
  })

  test("keeps list elements intact while localizing punctuation", () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }]
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the check is that no element was stringified
    expect(localizedListParts("en", items).filter((part) => typeof part !== "string")).toEqual(items)
  })
})

describe("dictionaries", () => {
  test("are flat string maps in every locale", async () => {
    const modules = await Promise.all(
      DESKTOP_NATIVE_LOCALES.flatMap((locale) => [
        import(`./${locale}`),
        import(`../../../../ui/src/i18n/${locale}`),
      ]),
    )

    const nested = modules.flatMap((module) =>
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the check is that no value is nested
      Object.entries<unknown>(module.dict).filter(([, value]) => typeof value !== "string"),
    )

    expect(nested).toEqual([])
  })

  test("never name OpenCode outside the service names", async () => {
    // The product never shows its upstream name: only the service names the user connects to
    // (OpenCode Go, OpenCode Console), the `opencode pair` command and the
    // `opencode service get password` command may appear, plus the bare `opencode` CLI command
    // in the install message. Config file names never appear either.
    const allowed = ["OpenCode Go", "OpenCode Console", "opencode pair", "opencode service get password"]
    const scrub = (key: string, value: string) => {
      const withoutAllowed = allowed.reduce((text, phrase) => text.split(phrase).join(""), value)
      return key === "desktop.cli.installed.message"
        ? withoutAllowed.split("opencode").join("")
        : withoutAllowed
    }

    const dictionaries = await Promise.all([
      import("./br").then((module) => ["br", module.dict] as const),
      import("./en").then((module) => ["en", module.dict] as const),
      import("./desktop-native").then((module) => ["desktop-native", module.DESKTOP_NATIVE_ENGLISH] as const),
      import("@opencode/ui/i18n/br").then((module) => ["ui-br", module.dict] as const),
      import("@opencode/ui/i18n/en").then((module) => ["ui-en", module.dict] as const),
    ])

    const violations = dictionaries.flatMap(([locale, dict]) =>
      Object.entries(dict).flatMap(([key, value]) => {
        const problems: string[] = []
        if (value.includes("opencode.json") || value.includes("cli.json")) problems.push("names a config file")
        if (scrub(key, value).toLowerCase().includes("opencode")) problems.push("names OpenCode")
        return problems.map((problem) => `${locale}:${key} ${problem}: ${JSON.stringify(value)}`)
      }),
    )

    expect(violations).toEqual([])
  })
})
