import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { manostechToolsEnv, resolveManostechTools, type ManostechTools } from "./manostech-tools"

function staged(resourcesRoot: string, platform: string, arch: string, files: string[]): string {
  const dir = path.join(resourcesRoot, "manostech-tools", `${platform}-${arch}`)
  mkdirSync(dir, { recursive: true })
  for (const file of files) writeFileSync(path.join(dir, file), "fake binary")
  return dir
}

const cases = [
  {
    name: "win32-x64 with all three binaries resolves",
    platform: "win32",
    arch: "x64",
    files: ["ffmpeg.exe", "ffprobe.exe", "node.exe"],
    resolves: true,
  },
  {
    name: "win32-x64 missing ffprobe does not resolve",
    platform: "win32",
    arch: "x64",
    files: ["ffmpeg.exe", "node.exe"],
    resolves: false,
  },
  {
    name: "win32-x64 with bare names (no .exe) does not resolve",
    platform: "win32",
    arch: "x64",
    files: ["ffmpeg", "ffprobe", "node"],
    resolves: false,
  },
  {
    name: "linux-x64 with all three binaries resolves",
    platform: "linux",
    arch: "x64",
    files: ["ffmpeg", "ffprobe", "node"],
    resolves: true,
  },
  {
    name: "darwin-arm64 with nothing staged does not resolve",
    platform: "darwin",
    arch: "arm64",
    files: [],
    resolves: false,
  },
]

describe("resolveManostechTools", () => {
  for (const item of cases) {
    test(item.name, () => {
      const resourcesRoot = mkdtempSync(path.join(tmpdir(), "manostech-tools-test-"))
      const dir = staged(resourcesRoot, item.platform, item.arch, item.files)
      const tools = resolveManostechTools({ resourcesRoot, platform: item.platform, arch: item.arch })

      if (!item.resolves) {
        expect(tools).toBeUndefined()
        return
      }

      expect(tools).toEqual({
        dir,
        ffmpeg: path.join(dir, item.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"),
        ffprobe: path.join(dir, item.platform === "win32" ? "ffprobe.exe" : "ffprobe"),
        node: path.join(dir, item.platform === "win32" ? "node.exe" : "node"),
      })
    })
  }
})

describe("manostechToolsEnv", () => {
  test("no staged tools adds nothing to the environment", () => {
    expect(manostechToolsEnv(undefined, "C:\\Windows\\System32")).toEqual({})
  })

  test("staged tools go first on PATH and are addressable by variable", () => {
    const tools: ManostechTools = {
      dir: "C:\\tools",
      ffmpeg: "C:\\tools\\ffmpeg.exe",
      ffprobe: "C:\\tools\\ffprobe.exe",
      node: "C:\\tools\\node.exe",
    }
    const env = manostechToolsEnv(tools, "C:\\Windows\\System32")

    expect(env.MANOSTECH_TOOLS_DIR).toBe("C:\\tools")
    expect(env.MANOSTECH_FFMPEG).toBe("C:\\tools\\ffmpeg.exe")
    expect(env.MANOSTECH_FFPROBE).toBe("C:\\tools\\ffprobe.exe")
    expect(env.MANOSTECH_NODE).toBe("C:\\tools\\node.exe")
    expect(env.PATH?.startsWith("C:\\tools")).toBe(true)
    expect(env.PATH).toContain("C:\\Windows\\System32")
  })

  test("without an inherited PATH the staged directory is the whole PATH", () => {
    const tools: ManostechTools = {
      dir: "/opt/tools",
      ffmpeg: "/opt/tools/ffmpeg",
      ffprobe: "/opt/tools/ffprobe",
      node: "/opt/tools/node",
    }

    expect(manostechToolsEnv(tools, undefined).PATH).toBe("/opt/tools")
  })
})
