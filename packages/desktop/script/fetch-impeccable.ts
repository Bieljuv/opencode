#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { cp, mkdir, readFile, rm, stat } from "node:fs/promises"
import path from "node:path"

// Stages the bundled Impeccable engine (pbakaus/impeccable, Apache 2.0)
// into packages/desktop/resources/impeccable/win32-x64/ from the official
// release asset, plus the skill files the engine reads at runtime
// (SKILL.md + reference/, copied from the ported skill in the plugin) and
// the font index the engine reads for its font catalog. The engine binary
// is ~21.5 MB — under the 100 MB GitHub file limit, but the precedent is
// build-time fetch (manostech-tools), never a committed binary. The
// release workflow runs this before the pack; without it the installer
// ships without the engine and the skill reports the detector missing
// instead of checking.
//
// Pinned versions live here; bump them deliberately, never to "latest".
const ENGINE_VERSION = "0.1.24"
const ENGINE_URL = `https://github.com/pbakaus/impeccable/releases/download/engine-v${ENGINE_VERSION}/impeccable-windows-x64.exe`
const ENGINE_SHA256 = "c4e71217677f53beaabec1cd4823a9bb2587355615f1170cf5508e69be4587bc"
const UPSTREAM_COMMIT = "1995764b4936f2bfbf4eb719cb37b384a45ceacb"
const FONT_INDEX_URL = `https://raw.githubusercontent.com/pbakaus/impeccable/${UPSTREAM_COMMIT}/skill/scripts/data/font-index.json`
const FONT_INDEX_SHA256 = "47edbdfaf27073c47033d1ac7dfee881be49e2dcbda7671d1157300481dde6da"

const dir = path.resolve(import.meta.dir, "..")
const out = path.join(dir, "resources", "impeccable", "win32-x64")
const tmp = path.join(dir, "resources", ".fetch-impeccable")
const skillSrc = path.resolve(dir, "..", "plugins", "manostech-skills", "skills", "impeccable")

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex")
}

async function download(url: string, dest: string, expectedSha256: string) {
  const response = await fetch(url, { redirect: "follow" })

  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`)

  await Bun.write(dest, response)
  const size = (await stat(dest)).size

  if (size === 0) throw new Error(`Downloaded an empty file: ${url}`)

  const actual = await sha256(dest)

  if (actual !== expectedSha256) throw new Error(`Checksum mismatch for ${url}: got ${actual}`)

  console.log(`Downloaded ${path.basename(dest)} (${(size / 1024 / 1024).toFixed(1)} MB, sha256 verified)`)
}

await rm(tmp, { recursive: true, force: true })
await mkdir(tmp, { recursive: true })
await mkdir(out, { recursive: true })

try {
  const engineDest = path.join(tmp, "impeccable-windows-x64.exe")
  const fontDest = path.join(tmp, "font-index.json")
  await download(ENGINE_URL, engineDest, ENGINE_SHA256)
  await download(FONT_INDEX_URL, fontDest, FONT_INDEX_SHA256)

  await cp(engineDest, path.join(out, "impeccable.exe"))
  await cp(path.join(skillSrc, "SKILL.md"), path.join(out, "SKILL.md"))
  await cp(path.join(skillSrc, "reference"), path.join(out, "reference"), { recursive: true })
  await mkdir(path.join(out, "scripts", "data"), { recursive: true })
  await cp(fontDest, path.join(out, "scripts", "data", "font-index.json"))

  for (const name of ["impeccable.exe", "SKILL.md", path.join("reference", "ios.md"), path.join("scripts", "data", "font-index.json")]) {
    const size = (await stat(path.join(out, name))).size

    if (size === 0) throw new Error(`Staged an empty file: ${name}`)
  }

  const engineSize = (await stat(path.join(out, "impeccable.exe"))).size
  console.log(`Staged impeccable.exe (${(engineSize / 1024 / 1024).toFixed(1)} MB) + skill files in ${out}`)
} finally {
  await rm(tmp, { recursive: true, force: true })
}

console.log(`Impeccable engine ready in ${out}`)
