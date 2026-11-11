import { existsSync } from "node:fs"
import path from "node:path"

/**
 * The video tools the installer bundles for the HyperFrames flow: Node (to
 * run the HyperFrames CLI) and FFmpeg + ffprobe (to render and mix sound).
 * They live under `resources/manostech-tools/<platform>-<arch>/`, staged on
 * the build machine only — the binaries are too large for git, so the
 * directory is git-ignored and restored by `script/fetch-manostech-tools.ts`.
 * When nothing is staged the app still ships and the skill reports the
 * missing tools instead of rendering; nothing here ever asks the user to
 * install anything.
 */
export interface ManostechTools {
  readonly dir: string
  readonly ffmpeg: string
  readonly ffprobe: string
  readonly node: string
}

export function manostechToolsDirName(platform: string, arch: string): string {
  return `${platform}-${arch}`
}

function executableName(name: string, platform: string): string {
  return platform === "win32" ? `${name}.exe` : name
}

/** The staged tools for this platform, or undefined when the build did not stage them. */
export function resolveManostechTools(input: {
  resourcesRoot: string
  platform?: string
  arch?: string
}): ManostechTools | undefined {
  const platform = input.platform ?? process.platform
  const arch = input.arch ?? process.arch
  const dir = path.join(input.resourcesRoot, "manostech-tools", manostechToolsDirName(platform, arch))
  const ffmpeg = path.join(dir, executableName("ffmpeg", platform))
  const ffprobe = path.join(dir, executableName("ffprobe", platform))
  const node = path.join(dir, executableName("node", platform))

  if (!existsSync(ffmpeg) || !existsSync(ffprobe) || !existsSync(node)) return undefined

  return { dir, ffmpeg, ffprobe, node }
}

/**
 * Environment additions for the sidecar service, so the agent's shell finds
 * the bundled tools on PATH and can also address them by variable. Added to
 * the inherited environment, never replacing it: the staged directory goes
 * first so the bundled tools win over anything on the machine.
 */
export function manostechToolsEnv(
  tools: ManostechTools | undefined,
  inheritedPath: string | undefined,
): Record<string, string> {
  if (!tools) return {}
  const delimiter = process.platform === "win32" ? ";" : ":"

  return {
    MANOSTECH_TOOLS_DIR: tools.dir,
    MANOSTECH_FFMPEG: tools.ffmpeg,
    MANOSTECH_FFPROBE: tools.ffprobe,
    MANOSTECH_NODE: tools.node,
    PATH: inheritedPath ? `${tools.dir}${delimiter}${inheritedPath}` : tools.dir,
  }
}
