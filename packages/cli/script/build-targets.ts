// Which CLI binaries `script/build.ts` compiles: one per OS/arch/libc, with an
// x64 `baseline` variant (no AVX2) for the machines the desktop supports.
export type BuildTarget = {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}

const binary = "opencode"

export const allBuildTargets: BuildTarget[] = [
  { os: "linux", arch: "arm64" },
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "x64", avx2: false },
  { os: "linux", arch: "arm64", abi: "musl" },
  { os: "linux", arch: "x64", abi: "musl" },
  { os: "linux", arch: "x64", abi: "musl", avx2: false },
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "darwin", arch: "x64", avx2: false },
  { os: "win32", arch: "arm64" },
  { os: "win32", arch: "x64" },
  { os: "win32", arch: "x64", avx2: false },
]

export function targetName(item: BuildTarget) {
  return [
    binary,
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.avx2 === false ? "baseline" : undefined,
    item.abi,
  ]
    .filter(Boolean)
    .join("-")
}

export function selectBuildTargets(options: {
  requestedTarget?: string
  single: boolean
  baseline: boolean
  platform: string
  arch: string
}): BuildTarget[] {
  if (options.requestedTarget !== undefined)
    return selectRequestedTarget(options.requestedTarget, options.baseline)
  if (options.single)
    return allBuildTargets.filter((item) => {
      if (item.os !== options.platform || item.arch !== options.arch) return false
      if (item.avx2 === false) return options.baseline
      return item.abi === undefined
    })
  return allBuildTargets
}

// A requested target names both its plain and baseline binaries (`windows-x64`
// is `opencode-windows-x64` and `opencode-windows-x64-baseline`); --baseline
// picks the baseline one, which is what the desktop bundles. Targets without
// a baseline variant (arm64) resolve to their only binary either way.
function selectRequestedTarget(requestedTarget: string, baseline: boolean): BuildTarget[] {
  const requested = `${binary}-${requestedTarget}`
  const candidates = allBuildTargets.filter((item) => targetName(item).replace("-baseline", "") === requested)
  if (candidates.length === 0) throw new Error(`Unknown build target: ${requestedTarget}`)
  const plain = candidates.find((item) => !targetName(item).includes("-baseline")) ?? candidates[0]
  const baselineTarget = candidates.find((item) => targetName(item).includes("-baseline"))
  return [baseline && baselineTarget ? baselineTarget : plain]
}
