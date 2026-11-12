import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { onMount } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { PlatformProvider } from "@/runtime/platform/platform"
import type { ConnectionStatus } from "./connections"
import { createFakeConnectionsPlatform } from "./fake-platform"
import { ConnectionsDialog } from "./panel"

function ConnectionsStory(props: { initial: ConnectionStatus[] }) {
  const dialog = useDialog()
  const language = useLanguage()
  const platform = createFakeConnectionsPlatform(props.initial)

  const open = () =>
    void dialog.show(() => (
      <PlatformProvider value={platform}>
        <ConnectionsDialog />
      </PlatformProvider>
    ))

  onMount(open)

  return (
    <div class="flex flex-col items-start gap-3">
      <Button variant="neutral" onClick={open}>
        Open connections dialog
      </Button>
      <p role="status">{language.t("connections.title")}</p>
    </div>
  )
}

export default {
  title: "App/Dialogs/Connections",
  id: "app-connections",
}

export const Default = {
  render: () => (
    <ConnectionsStory
      initial={[
        { provider: "github", connected: false, permission: "ask" },
        { provider: "vercel", connected: false, permission: "ask" },
        { provider: "supabase", connected: false, permission: "ask" },
      ]}
    />
  ),
}

export const Mixed = {
  render: () => (
    <ConnectionsStory
      initial={[
        { provider: "github", connected: true, login: "usuario-teste", permission: "ask" },
        { provider: "vercel", connected: false, permission: "ask" },
        { provider: "supabase", connected: false, permission: "block" },
      ]}
    />
  ),
}
