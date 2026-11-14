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

/**
 * The visual-quality engine the installer bundles for the Impeccable
 * flow: the `impeccable` binary plus the skill files it reads at runtime
 * (SKILL.md, reference/, the font index). It lives under
 * `resources/impeccable/<platform>-<arch>/`, staged on the build machine
 * only — restored by `script/fetch-impeccable.ts`, like manostech-tools.
 * When nothing is staged the app still ships and the skill reports the
 * missing detector instead of checking; nothing here ever asks the user
 * to install or download anything.
 */
export interface ImpeccableEngine {
  readonly dir: string
  readonly binary: string
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

/** The staged Impeccable engine for this platform, or undefined when the build did not stage it. */
export function resolveImpeccable(input: {
  resourcesRoot: string
  platform?: string
  arch?: string
}): ImpeccableEngine | undefined {
  const platform = input.platform ?? process.platform
  const arch = input.arch ?? process.arch
  const dir = path.join(input.resourcesRoot, "impeccable", manostechToolsDirName(platform, arch))
  const binary = path.join(dir, executableName("impeccable", platform))

  if (!existsSync(binary)) return undefined

  return { dir, binary }
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
  impeccable?: ImpeccableEngine | undefined,
): Record<string, string> {
  if (!tools && !impeccable) return {}
  const delimiter = process.platform === "win32" ? ";" : ":"
  const staged = [impeccable?.dir, tools?.dir].filter((dir): dir is string => dir !== undefined)

  return {
    ...(tools
      ? {
          MANOSTECH_TOOLS_DIR: tools.dir,
          MANOSTECH_FFMPEG: tools.ffmpeg,
          MANOSTECH_FFPROBE: tools.ffprobe,
          MANOSTECH_NODE: tools.node,
        }
      : {}),
    ...(impeccable ? { IMPECCABLE_SKILL_DIR: impeccable.dir } : {}),
    PATH: inheritedPath ? `${[...staged, inheritedPath].join(delimiter)}` : staged.join(delimiter),
  }
}
