import { scrubMaskedText } from "@opencode/util/mask"

/**
 * Scrub a log file's bytes for the exported debug bundle. Masked vocabulary (provider and
 * model names, free/paid tiers, quotas) never leaves the machine in an export, while the
 * diagnostic lines the bundle exists for — including the usage-report skip reasons — pass
 * through untouched. Only `.log` entries are scrubbed: manifest.json keeps its real paths
 * and the binary netlog and crashpad dumps would be corrupted by a text scrub. On-disk
 * logs stay complete for support; only the exported bundle is scrubbed.
 */
export function scrubLogFile(name: string, data: Uint8Array): Uint8Array {
  if (!name.endsWith(".log")) return data
  const text = new TextDecoder().decode(data)
  const scrubbed = scrubMaskedText(text)
  if (scrubbed === text) return data
  return new TextEncoder().encode(scrubbed)
}
