import { createEffect } from "solid-js"
import { Schema } from "effect"
import type { MountedSession } from "@opencode/plugin/gui"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { Persistence } from "@/runtime/persistence/schema"
import { usePluginHost } from "@/runtime/plugin/host"
import { useServer } from "@/runtime/server/current"
import { latestBuildPreview } from "./preview-link"

const PreviewAutoOpenState = Persistence.struct({
  /** Session keys to the preview files already opened by themselves, so a preview the user closed stays closed. */
  opened: Persistence.record(Persistence.array(Schema.String)),
})

/**
 * Opens the preview by itself while the agent builds a system: the entry
 * HTML file the latest Build message links opens in the review panel beside
 * the chat, once per session and file, as soon as the file exists. A question
 * never opens anything, the manual flow (clicking the link) is unchanged, and
 * the preview keeps updating live as the files change, like any opened tab.
 */
export function PreviewAutoOpen(props: { session: MountedSession; active?: boolean }) {
  const host = usePluginHost()
  const server = useServer()
  const [store, setStore] = persisted(Persist.global("preview-auto-open"), PreviewAutoOpenState, { opened: {} })

  createEffect(() => {
    if (props.active === false) return

    const session = props.session
    const preview = latestBuildPreview(server.ctx.data.session.message.list(session.id))

    if (!preview || (store.opened[session.key] ?? []).includes(preview.href)) return

    // Open like a click does: the link handler resolves the file at open
    // time and rereads it, so no existence check up front — a cached
    // negative from the link check would block the preview. A missing file
    // ends in a toast, never a broken tab. Claim the open synchronously so
    // a second run cannot open the same file twice.
    if (!host.links.open({ href: preview.href, session })) return

    setStore("opened", session.key, (hrefs) => [...(hrefs ?? []), preview.href])
  })

  return null
}
