#!/usr/bin/env bun
import { $ } from "bun"
import { cp, mkdir, rm, stat } from "node:fs/promises"
import path from "node:path"

// Restores the bundled video tools (Node + FFmpeg) into
// packages/desktop/resources/manostech-tools/win32-x64/ from the official
// distribution zips. The binaries are too large for git (ffmpeg.exe alone is
// ~105 MB), so they live only on the build machine — same precedent as the
// other desktop's vendor/ directory. The release workflow runs this before
// the pack; without it the installer ships without the tools and the app
// reports them missing instead of rendering.
//
// Pinned versions live here; bump them deliberately, never to "latest".
const NODE_VERSION = "22.21.0"
const NODE_URL = `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`
const FFMPEG_URL = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"

const dir = path.resolve(import.meta.dir, "..")
const out = path.join(dir, "resources", "manostech-tools", "win32-x64")
const tmp = path.join(dir, "resources", ".fetch-manostech-tools")

// [file inside the zip, file staged in win32-x64/]
const FFMPEG_WANTED: Array<[string, string]> = [
  ["ffmpeg-release-essentials/bin/ffmpeg.exe", "ffmpeg.exe"],
  ["ffmpeg-release-essentials/bin/ffprobe.exe", "ffprobe.exe"],
]

// The whole Node distribution goes in — not just node.exe: `npx hyperframes`
// needs npm/npx (npm.cmd, npx.cmd, node_modules/npm) from the same zip.

async function download(url: string, dest: string) {
  const response = await fetch(url, { redirect: "follow" })

  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`)

  await Bun.write(dest, response)
  const size = (await stat(dest)).size

  if (size === 0) throw new Error(`Downloaded an empty file: ${url}`)

  console.log(`Downloaded ${path.basename(dest)} (${(size / 1024 / 1024).toFixed(1)} MB)`)
}

async function extract(zip: string, dest: string) {
  // The Gyan zip nests the binaries one level down (ffmpeg-<version>-essentials_build/bin/);
  // flatten that level after extracting so the WANTED paths line up.
  if (process.platform === "win32") {
    await $`powershell -NoProfile -Command Expand-Archive -LiteralPath ${zip} -DestinationPath ${dest} -Force`
  } else {
    await $`unzip -q -o ${zip} -d ${dest}`
  }

  const nested = await $`ls -d ${dest}/ffmpeg-*-essentials_build`.quiet().nothrow()

  if (nested.exitCode === 0) {
    const inner = nested.stdout.toString().trim().split("\n")[0]

    if (inner) {
      await $`cp -R ${inner}/. ${dest}/ffmpeg-release-essentials/`.quiet().nothrow()
      await rm(inner, { recursive: true, force: true })
    }
  }
}

await rm(tmp, { recursive: true, force: true })
await mkdir(tmp, { recursive: true })
await mkdir(out, { recursive: true })

try {
  const nodeZip = path.join(tmp, "node.zip")
  const ffmpegZip = path.join(tmp, "ffmpeg.zip")
  await download(NODE_URL, nodeZip)
  await download(FFMPEG_URL, ffmpegZip)

  const nodeDir = path.join(tmp, "node")
  const ffmpegDir = path.join(tmp, "ffmpeg")
  await extract(nodeZip, nodeDir)
  await extract(ffmpegZip, ffmpegDir)

  // Stage with Node's own cp, not the shell `cp -R`: on the Windows
  // runner the shell copy exited 0, printed "Staged", and node.exe was
  // still missing from out/ (build-windows-x64 failed twice with ENOENT
  // on the verify stat). The ffmpeg copies below already use fs cp and
  // work; the whole Node distribution goes the same way. Verify the
  // extraction first so a missing/empty source fails loud here instead
  // of surfacing later as a missing staged binary.
  const nodeSrc = path.join(nodeDir, `node-v${NODE_VERSION}-win-x64`)
  const nodeExeSrc = path.join(nodeSrc, "node.exe")

  if ((await stat(nodeExeSrc)).size === 0) throw new Error(`Extracted node.exe is empty: ${nodeExeSrc}`)

  await cp(nodeSrc, out, { recursive: true })
  const nodeSize = (await stat(path.join(out, "node.exe"))).size

  if (nodeSize === 0) throw new Error("Staged an empty binary: node.exe")

  console.log(`Staged the Node distribution (node.exe ${(nodeSize / 1024 / 1024).toFixed(1)} MB, npm.cmd, npx.cmd)`)

  for (const [inside, name] of FFMPEG_WANTED) {
    const source = path.join(ffmpegDir, inside)
    await cp(source, path.join(out, name))
    const size = (await stat(path.join(out, name))).size

    if (size === 0) throw new Error(`Staged an empty binary: ${name}`)

    console.log(`Staged ${name} (${(size / 1024 / 1024).toFixed(1)} MB)`)
  }

  for (const name of ["node.exe", "ffmpeg.exe", "ffprobe.exe"]) {
    const size = (await stat(path.join(out, name))).size

    if (size === 0) throw new Error(`Staged an empty binary: ${name}`)
  }
} finally {
  await rm(tmp, { recursive: true, force: true })
}

console.log(`Video tools ready in ${out}`)
