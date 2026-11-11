export * as SubagentFiles from "./subagent-files.js"

import { Option, Schema } from "effect"
import type { SessionMessage } from "./message.js"

const decodeString = Schema.decodeUnknownOption(Schema.String)

// A file a subagent wrote or edited: only a finished write or edit counts —
// a call still running may not have created the file yet, and a failed one
// did not. The list is sorted and deduplicated so the parent and the
// reviewer see the same files in the same order on every turn.
export function writtenFiles(messages: readonly SessionMessage.Info[]): string[] {
  const files = new Set<string>()
  for (const message of messages) {
    if (message.type !== "assistant") continue
    for (const part of message.content) {
      if (part.type !== "tool" || (part.name !== "write" && part.name !== "edit")) continue
      if (part.state.status !== "completed") continue
      const path = Option.getOrUndefined(decodeString(part.state.input.path))
      if (path !== undefined && path.length > 0) files.add(path)
    }
  }
  return [...files].sort()
}

// The files this subagent wrote that another subagent in the same turn also
// wrote: two fronts editing the same file is the one overlap the pipeline
// forbids, and the parent has to reconcile it before delivering.
export function overlappingFiles(
  files: readonly string[],
  others: readonly (readonly string[])[],
): string[] {
  const seen = new Set(others.flat())
  return [...new Set(files.filter((file) => seen.has(file)))].sort()
}
