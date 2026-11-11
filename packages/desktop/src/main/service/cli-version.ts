export function parseCliVersion(output: string) {
  const marker = output.lastIndexOf(" v")
  const version = marker === -1 ? output : output.slice(marker + 2)

  if (!version) throw new Error("V2 CLI did not provide a version")

  return version
}

export function serviceVersion(input: {
  readonly channel: "local" | "dev" | "beta" | "prod"
  readonly isolated?: boolean
  readonly mode: "initial" | "reconnect"
  readonly version: string
}) {
  // `undefined` means "any version is accepted": the version lock is off
  // on reconnect (the running server is the one to keep) and on the beta
  // channel in a non-isolated install. Releases ship on the `dev`
  // channel, so the beta bypass has no effect today — but if the release
  // channel ever changes to `beta`, the lock silently stops applying and
  // a stale CLI can be adopted. Keep this in mind before flipping channels.
  if (input.mode === "reconnect") return undefined

  if (input.channel === "beta" && !input.isolated) return undefined

  return input.version
}

// Retrying on timeout can also replace a server stuck in a migration longer than 120 s, which is accepted.
export function shouldRetryEnsure(version: string | undefined, message: string) {
  if (version !== undefined) return false

  return (
    message === "Background service failed to start" ||
    message === "Timed out waiting for the background service to start"
  )
}

/**
 * The probe only adopts a service whose version is verified to match the
 * bundled one. A running version that cannot be verified is not adopted:
 * the server behind it may predate the bundled CLI (an orphan from an
 * older release keeps answering with its old code), so `ensure` starts a
 * new one instead. When the bundled version is unknown there is nothing
 * to start against (reconnect and beta), so adoption is the only option.
 */
export function shouldAdoptProbedService(runningVersion: string | undefined, bundledVersion: string | undefined) {
  if (bundledVersion === undefined) return true
  if (runningVersion === undefined) return false
  return runningVersion === bundledVersion
}

export function stageName(version: string, arch = process.arch) {
  return `${version}-${arch}`.replace(/[^a-zA-Z0-9._-]/g, "-")
}

export function keptStages(bundledVersion: string, runningVersion?: string, arch = process.arch) {
  const stages = [stageName(bundledVersion, arch)]

  if (runningVersion && runningVersion !== bundledVersion) stages.push(stageName(runningVersion, arch))

  return stages
}
