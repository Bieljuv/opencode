import { expect, test } from "bun:test"
import { statSync } from "node:fs"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Configuration, CustomWindowsSignTaskConfiguration } from "electron-builder"
import { getConfig } from "./electron-builder.config"
import { CLI_BINARIES, nodePtyPackage } from "./script/utils"

// Use electron-builder's matcher so the tests also cover its glob and directory traversal semantics.
const { FileMatcher } = createRequire(import.meta.resolve("electron-builder"))("app-builder-lib/out/fileMatcher")

const channels = [
  { channel: "dev", appId: "com.manostech.editor.dev" },
  { channel: "beta", appId: "com.manostech.editor.beta" },
  { channel: "prod", appId: "com.manostech.editor" },
] as const

function load(channel: string, target?: string, signCommand?: string): Configuration {
  const previous = process.env.OPENCODE_CHANNEL
  const previousTarget = process.env.OPENCODE_TARGET
  const previousSignCommand = process.env.MANOSTECH_SIGN_CMD
  process.env.OPENCODE_CHANNEL = channel

  if (target !== undefined) process.env.OPENCODE_TARGET = target
  else delete process.env.OPENCODE_TARGET

  if (signCommand !== undefined) process.env.MANOSTECH_SIGN_CMD = signCommand
  else delete process.env.MANOSTECH_SIGN_CMD

  try {
    return getConfig()
  } finally {
    delete process.env.OPENCODE_CHANNEL
    delete process.env.OPENCODE_TARGET
    delete process.env.MANOSTECH_SIGN_CMD

    if (previous !== undefined) process.env.OPENCODE_CHANNEL = previous

    if (previousTarget !== undefined) process.env.OPENCODE_TARGET = previousTarget

    if (previousSignCommand !== undefined) process.env.MANOSTECH_SIGN_CMD = previousSignCommand
  }
}

function trimFilter(dir: string, config: Configuration) {
  const patterns = Array.isArray(config.files) ? config.files.flatMap((value) => (value ? [String(value)] : [])) : []

  return new FileMatcher(dir, "", (value: string) => value, [
    "**/*",
    ...patterns.filter((value) => value.startsWith("!")),
  ]).createFilter()
}

test.each(channels)("channel identity for $channel", ({ channel, appId }) => {
  const config = load(channel)
  expect(config.appId).toBe(appId)
  // Every channel updates from the same GitHub Releases feed (one release line for now).
  expect(config.publish).toEqual({
    provider: "github",
    owner: "BielJuv",
    repo: "opencode",
    channel: "latest",
  })
  expect(config.extraMetadata?.desktopName).toBe(`${appId}.desktop`)
  // The executable must never end in `.desktop`: libappimage resolves the
  // AppImage's desktop entry by globbing `*.desktop`, and an ELF matching
  // that glob breaks integration (anomalyco/opencode#51867).
  expect(config.linux?.executableName).toBe(appId.replace(/\.desktop$/, ""))
  expect(config.linux?.executableName).not.toMatch(/\.desktop$/)
  // The installed `.desktop` filename still derives from `desktopName` so
  // window association (StartupWMClass/desktop file basename) is unchanged.
  expect(config.linux?.syncDesktopName).toBe(true)
  expect(config.linux?.desktop?.entry?.StartupWMClass).toBe(appId)
  // One reverse-DNS scheme for every channel: the OS hands the app every
  // deep link (`/auth/google`, `/console/authorized`, `/open`) on it, and
  // Google only accepts a dotted scheme as a redirect URI.
  expect(config.protocols?.schemes).toEqual(["com.manostech.editor"])

  for (const fpm of [config.deb?.fpm, config.rpm?.fpm]) {
    expect(fpm).toContainEqual(expect.stringContaining(`/usr/share/metainfo/${appId}.metainfo.xml`))
    expect(
      fpm?.some((entry) => entry.endsWith("opencode-desktop.desktop=/usr/share/applications/opencode-desktop.desktop")),
    ).toBe(channel === "prod")
  }

  // Shared Electron binaries must not ship /usr/lib/.build-id links that collide with other Electron RPMs.
  // fpm rejects flags after the first src=dest mapping, so the flag must come first.
  expect(config.rpm?.fpm?.[0]).toBe("--rpm-rpmbuild-define=_build_id_links none")
  expect(config.deb?.fpm).not.toContain("--rpm-rpmbuild-define=_build_id_links none")
})

test("legacy Linux launcher stays hidden", async () => {
  const desktop = await Bun.file(path.join(import.meta.dirname, "resources/linux/opencode-desktop.desktop")).text()
  expect(desktop).toContain("Exec=/opt/OpenCode/ai.opencode %U")
  expect(desktop).toContain("Icon=ai.opencode")
  expect(desktop).toContain("StartupWMClass=ai.opencode.desktop")
  expect(desktop).toContain("NoDisplay=true")
})

test.each(channels)("macOS bundle for $channel", ({ channel }) => {
  const config = load(channel)
  expect(config.mac?.icon).toBe(channel === "prod" ? "resources/icons/icon.icon" : "resources/icons/icon.icns")
  expect(config.dmg?.icon).toBe(channel === "prod" ? "resources/icons/icon.icns" : undefined)
  // The prod override must keep the rest of the shared macOS settings.
  expect(config.mac?.target).toEqual(["dmg", "zip"])

  for (const key of [
    "NSMicrophoneUsageDescription",
    "NSDocumentsFolderUsageDescription",
    "NSDesktopFolderUsageDescription",
    "NSDownloadsFolderUsageDescription",
    "NSNetworkVolumesUsageDescription",
    "NSRemovableVolumesUsageDescription",
  ])
    expect(config.mac?.extendInfo?.[key], key).toMatch(/\S/)
})

test("the production Icon Composer package references its bundled artwork", async () => {
  const icon = await Bun.file(path.join(import.meta.dirname, "icons/prod/icon.icon/icon.json")).json()
  expect(icon["supported-platforms"]).toEqual({ squares: ["macOS"] })
  const image = icon.groups[0].layers[0]["image-name"]
  expect(await Bun.file(path.join(import.meta.dirname, "icons/prod/icon.icon/Assets", image)).exists()).toBe(true)
})

test("shared packaging defaults", async () => {
  const config = load("dev")
  // Packaging runs in secretless build jobs; Windows signing only happens
  // when MANOSTECH_SIGN_CMD is configured (audit item I13) — without it
  // the installer ships unsigned exactly as today, and the updater must
  // not start demanding a signature it never had.
  expect(config.mac?.sign).toBeUndefined()
  expect(config.mac?.notarize).toBeUndefined()
  expect(config.win?.signtoolOptions).toBeUndefined()
  expect(config.win?.verifyUpdateCodeSignature).toBe(false)
  expect(config.dmg?.sign).not.toBe(true)
  expect(config.mac?.extendInfo?.NSAutoFillRequiresTextContentTypeForOneTimeCodeOnMac).toBe(true)
  const include = path.join(import.meta.dirname, "resources/windows/installer.nsh")
  expect(config.nsis?.include).toBe(include)
  expect(await Bun.file(include).exists()).toBe(true)
  expect(config.files).toContain("!resources/opencode-cli*")
  // The bundled video tools ship only when the build machine staged them
  // (resources/manostech-tools/, git-ignored); the filter lists the
  // directory so a staged build packs it and an unstaged build packs
  // nothing extra.
  expect(config.extraResources).toEqual([
    {
      from: "resources/",
      to: "",
      filter: ["opencode-cli", "opencode-cli.exe", "opencode-cli.version", "manostech-tools/**"],
    },
  ])
})

test.each(channels)("windows signing hook for $channel", ({ channel }) => {
  const unsigned = load(channel)
  expect(unsigned.win?.signtoolOptions).toBeUndefined()
  expect(unsigned.win?.verifyUpdateCodeSignature).toBe(false)

  const signed = load(channel, undefined, "signtool sign /a")
  expect(typeof signed.win?.signtoolOptions?.sign).toBe("function")
  expect(signed.win?.signtoolOptions?.signingHashAlgorithms).toEqual(["sha256"])
  expect(signed.win?.verifyUpdateCodeSignature).toBe(true)
})

test("windows signing hook runs the configured command with the file path last", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-sign-hook-"))
  try {
    const stub = path.join(dir, "sign-stub.mjs")
    const log = path.join(dir, "calls.log")
    await writeFile(
      stub,
      `import { appendFileSync } from "node:fs"\nappendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n")\n`,
    )
    const target = path.join(dir, "editor-ia-manostech-win-x64.exe")
    const config = load("dev", undefined, `node ${stub} ${log} "--marker=hello world"`)
    const sign = config.win?.signtoolOptions?.sign
    expect(typeof sign).toBe("function")
    await sign({ path: target } as unknown as CustomWindowsSignTaskConfiguration)
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(calls).toEqual([[log, "--marker=hello world", target]])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("windows signing hook fails the build when the configured command fails", async () => {
  const config = load("dev", undefined, `node -e "process.exit(3)"`)
  const sign = config.win?.signtoolOptions?.sign
  expect(typeof sign).toBe("function")
  await expect(
    sign({ path: "editor-ia-manostech-win-x64.exe" } as unknown as CustomWindowsSignTaskConfiguration),
  ).rejects.toThrow(/Failed to sign .* \(exit code 3\)/)
})

test("trims external dependencies without excluding runtime files", () => {
  const fileStats = statSync(import.meta.filename)
  const dirStats = statSync(import.meta.dirname)
  const filter = trimFilter(import.meta.dirname, load("dev"))

  for (const prefix of ["node_modules/", "node_modules/parent/node_modules/"]) {
    const included = (file: string, stats = fileStats) => filter(path.join(import.meta.dirname, prefix, file), stats)

    // One file for each excluded pattern, including each brace alternative.
    for (const file of [
      "@zip.js/zip.js/dist/zip.js",
      ...["index.cjs", "index.min.js", "index-fflate.js", "deno.json", "eslint.config.mjs"].map(
        (name) => `@zip.js/zip.js/${name}`,
      ),
      ...["d.ts", "d.cts", "d.mts", "d.ts.map", "d.cts.map", "d.mts.map", "js.map", "cjs.map", "mjs.map"].map(
        (extension) => `unrelated/dist/index.${extension}`,
      ),
      "ajv/lib/core.ts",
      "ajv-formats/src/formats.ts",
      "js-yaml/dist/js-yaml.js",
      "js-yaml/dist/js-yaml.min.js",
      "js-yaml/dist/js-yaml.mjs.map",
      "js-yaml/bin/js-yaml.js",
    ]) {
      expect(included(file)).toBe(false)
    }

    for (const file of [
      "@zip.js/zip.js/index.js",
      "@zip.js/zip.js/lib/z-worker-inline.js",
      "electron-updater/out/main.js",
      "electron-updater/out/MacUpdater.js",
      "electron-updater/out/NsisUpdater.js",
      "electron-updater/out/providers/GitHubProvider.js",
      "builder-util-runtime/out/httpExecutor.js",
      "ajv/dist/ajv.js",
      "ajv/dist/refs/json-schema-draft-07.json",
      "ajv-formats/dist/formats.js",
      "js-yaml/index.js",
      "js-yaml/dist/js-yaml.mjs",
      "unrelated/dist/index.js",
      "unrelated/dist/index.cjs",
      "unrelated/dist/data.json",
      "unrelated/src/index.ts",
      ...["@zip.js/zip.js", "electron-updater", "builder-util-runtime", "ajv", "ajv-formats", "js-yaml"].flatMap(
        (name) => [`${name}/package.json`, `${name}/LICENSE`],
      ),
    ]) {
      expect(included(file)).toBe(true)
    }

    expect(included("@zip.js/zip.js/dist", dirStats)).toBe(false)
    expect(included("@zip.js/zip.js/lib", dirStats)).toBe(true)
  }

  for (const item of CLI_BINARIES) {
    const targetFilter = trimFilter(import.meta.dirname, load("prod", item.target))
    const active = nodePtyPackage(item.target)

    for (const candidate of CLI_BINARIES) {
      const pkg = nodePtyPackage(candidate.target)
      const included = targetFilter(path.join(import.meta.dirname, "node_modules", pkg, "lib/index.js"), fileStats)
      expect(included).toBe(pkg === active)
    }
  }
})

test("the trimmed Zip.js package can still export compressed logs", async () => {
  const config = load("dev")
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-zip-package-"))
  const source = path.dirname(fileURLToPath(import.meta.resolve("@zip.js/zip.js/package.json")))
  const filter = trimFilter(dir, config)

  try {
    await cp(source, dir, {
      recursive: true,
      filter: (file) =>
        filter(path.join(dir, "node_modules/@zip.js/zip.js", path.relative(source, file)), statSync(file)),
    })
    const zip = await import(pathToFileURL(path.join(dir, "index.js")).href)
    const writer = new zip.ZipWriter(new zip.BlobWriter("application/zip"))
    await writer.add("desktop.log", new zip.BlobReader(new Blob(["diagnostic log\n".repeat(100)])))
    const reader = new zip.ZipReader(new zip.BlobReader(await writer.close()))
    const entries = await reader.getEntries()
    expect(entries.map((entry: { filename: string }) => entry.filename)).toEqual(["desktop.log"])
    expect(entries[0].compressionMethod).toBe(8)
    expect(await entries[0].getData(new zip.TextWriter())).toBe("diagnostic log\n".repeat(100))
    await reader.close()
    await zip.terminateWorkers()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
