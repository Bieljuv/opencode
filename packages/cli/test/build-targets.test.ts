import { describe, expect, test } from "bun:test"
import { selectBuildTargets, targetName } from "../script/build-targets"

// The release workflow builds the desktop's CLI with
// OPENCODE_TARGET=windows-x64 plus --single --baseline: the desktop expects
// packages/cli/dist/cli-windows-x64-baseline, the baseline binary. A requested
// target used to ignore --baseline and pick the plain binary instead, so the
// desktop found nothing local and silently downloaded the upstream CLI.
describe("selectBuildTargets", () => {
  const cases: Array<{
    name: string
    options: { requestedTarget?: string; single: boolean; baseline: boolean; platform: string; arch: string }
    expected: string[]
  }> = [
    {
      name: "requested target without --baseline builds the plain binary",
      options: { requestedTarget: "windows-x64", single: false, baseline: false, platform: "win32", arch: "x64" },
      expected: ["opencode-windows-x64"],
    },
    {
      name: "requested target with --baseline builds the baseline binary",
      options: { requestedTarget: "windows-x64", single: false, baseline: true, platform: "win32", arch: "x64" },
      expected: ["opencode-windows-x64-baseline"],
    },
    {
      name: "requested musl target with --baseline builds the baseline musl binary",
      options: { requestedTarget: "linux-x64-musl", single: false, baseline: true, platform: "linux", arch: "x64" },
      expected: ["opencode-linux-x64-baseline-musl"],
    },
    {
      name: "requested musl target without --baseline builds the plain musl binary",
      options: { requestedTarget: "linux-x64-musl", single: false, baseline: false, platform: "linux", arch: "x64" },
      expected: ["opencode-linux-x64-musl"],
    },
    {
      name: "requested darwin target with --baseline builds the baseline binary",
      options: { requestedTarget: "darwin-x64", single: false, baseline: true, platform: "darwin", arch: "x64" },
      expected: ["opencode-darwin-x64-baseline"],
    },
    {
      name: "requested arm64 target with --baseline builds its only binary",
      options: { requestedTarget: "windows-arm64", single: false, baseline: true, platform: "win32", arch: "arm64" },
      expected: ["opencode-windows-arm64"],
    },
    {
      name: "requested arm64 target without --baseline builds its only binary",
      options: { requestedTarget: "windows-arm64", single: false, baseline: false, platform: "win32", arch: "arm64" },
      expected: ["opencode-windows-arm64"],
    },
    {
      name: "--single --baseline builds the current platform's plain and baseline binaries",
      options: { single: true, baseline: true, platform: "win32", arch: "x64" },
      expected: ["opencode-windows-x64", "opencode-windows-x64-baseline"],
    },
    {
      name: "--single without --baseline builds the current platform's plain binary",
      options: { single: true, baseline: false, platform: "win32", arch: "x64" },
      expected: ["opencode-windows-x64"],
    },
    {
      name: "--single --baseline on linux builds the linux plain and baseline binaries",
      options: { single: true, baseline: true, platform: "linux", arch: "x64" },
      expected: ["opencode-linux-x64", "opencode-linux-x64-baseline", "opencode-linux-x64-baseline-musl"],
    },
    {
      name: "no flags builds every target",
      options: { single: false, baseline: false, platform: "linux", arch: "x64" },
      expected: [
        "opencode-linux-arm64",
        "opencode-linux-x64",
        "opencode-linux-x64-baseline",
        "opencode-linux-arm64-musl",
        "opencode-linux-x64-musl",
        "opencode-linux-x64-baseline-musl",
        "opencode-darwin-arm64",
        "opencode-darwin-x64",
        "opencode-darwin-x64-baseline",
        "opencode-windows-arm64",
        "opencode-windows-x64",
        "opencode-windows-x64-baseline",
      ],
    },
  ]

  for (const { name, options, expected } of cases) {
    test(name, () => {
      expect(selectBuildTargets(options).map((target) => targetName(target))).toEqual(expected)
    })
  }

  test("unknown requested target throws", () => {
    expect(() =>
      selectBuildTargets({ requestedTarget: "windows-foo", single: false, baseline: false, platform: "win32", arch: "x64" }),
    ).toThrow("Unknown build target: windows-foo")
  })
})
