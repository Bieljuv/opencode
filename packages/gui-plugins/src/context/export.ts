import type { JsonValue, OpenCodeClient, SessionInfo, SessionMessageInfo } from "@opencode/client/promise"

/** Omit that distributes over a union, so every message variant loses the keys. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** A message as it leaves the app in an export: no model, no cost, no model switch. */
export type SessionExportMessageInfo = Exclude<
  DistributiveOmit<SessionMessageInfo, "model" | "cost">,
  { type: "model-switched" }
>

export type SessionExportData = {
  info: Omit<SessionInfo, "model" | "cost">
  messages: SessionExportMessageInfo[]
}

/**
 * ManosTech masking: a session export never names a model or provider and never shows a cost in dollars — the
 * same rule the history package follows for its summary, where model-switched events are left out. Only tokens
 * and time survive alongside the conversation itself. Keep in sync with packages/app/src/session/commands/export.ts.
 */
export function sanitizeSessionExport(data: {
  info: SessionInfo
  messages: SessionMessageInfo[]
}): SessionExportData {
  const { model: _model, cost: _cost, ...info } = data.info

  return {
    info,
    messages: data.messages.flatMap((message) => sanitizeSessionExportMessage(message)),
  }
}

function sanitizeSessionExportMessage(message: SessionMessageInfo): SessionExportMessageInfo[] {
  // A model switch is metadata of a hop, not conversation — same as the history package.
  if (message.type === "model-switched") return []

  const metadata = withoutModelKey(message.metadata)
  const stripped = metadata === message.metadata ? message : { ...message, metadata }

  switch (stripped.type) {
    case "assistant": {
      const { model: _model, cost: _cost, ...rest } = stripped

      return [rest]
    }

    case "compaction": {
      if (stripped.status === "completed") {
        const { model: _model, cost: _cost, ...rest } = stripped

        return [rest]
      }

      if (stripped.status === "failed") {
        const { cost: _cost, ...rest } = stripped

        return [rest]
      }

      return [stripped]
    }

    default:
      return [stripped]
  }
}

/**
 * User messages remember which model answered in their metadata; drop that key, keep the rest. Returns the
 * same dict when there is nothing to drop, so untouched messages keep their identity.
 */
function withoutModelKey(
  metadata: { [x: string]: JsonValue } | undefined,
): { [x: string]: JsonValue } | undefined {
  if (!metadata || !("model" in metadata)) return metadata

  const { model: _model, ...rest } = metadata

  return rest
}

/** Bounds each request rather than the whole export, so a long history still exports. */
export const EXPORT_REQUEST_TIMEOUT_MS = 60_000

export async function fetchSessionExport(input: {
  sessionID: string
  api: Pick<OpenCodeClient, "session" | "message">
  signal?: AbortSignal
}): Promise<SessionExportData> {
  const signal = () =>
    input.signal
      ? AbortSignal.any([input.signal, AbortSignal.timeout(EXPORT_REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(EXPORT_REQUEST_TIMEOUT_MS)

  const [info, first] = await Promise.all([
    input.api.session.get({ sessionID: input.sessionID }, { signal: signal() }),
    input.api.message.list({ sessionID: input.sessionID, limit: 200, order: "asc" }, { signal: signal() }),
  ])

  const pages = [first]

  while (pages.at(-1)?.cursor.next) {
    pages.push(
      await input.api.message.list(
        {
          sessionID: input.sessionID,
          limit: 200,
          cursor: pages.at(-1)!.cursor.next ?? undefined,
        },
        { signal: signal() },
      ),
    )
  }

  // The export leaves the app already masked: no model, no cost, no model switch.
  return sanitizeSessionExport({
    info,
    messages: pages.flatMap((page) => page.data),
  })
}

export function sessionExportFilename(session: { id: string; title?: string; slug?: string }) {
  const name = session.title || session.slug || session.id

  const clean = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .slice(0, 250)
    .replace(/^-+|-+$/g, "")

  return `${clean || session.id}.json`
}
