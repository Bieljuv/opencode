import { PlatformProvider } from "@/runtime/platform/platform"
import type { ConnectionStatus } from "./connections"
import { createFakeConnectionsPlatform } from "./fake-platform"
import { ConnectionsSidebarSection } from "./sidebar-section"

function ConnectionsSidebarStory(props: { initial: ConnectionStatus[] }) {
  const platform = createFakeConnectionsPlatform(props.initial)

  return (
    <PlatformProvider value={platform}>
      <div class="w-64 border-e border-v2-border-border-muted">
        <ConnectionsSidebarSection />
      </div>
    </PlatformProvider>
  )
}

export default {
  title: "App/Sidebar/Connections",
  id: "app-connections-sidebar",
}

export const Default = {
  render: () => (
    <ConnectionsSidebarStory
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
    <ConnectionsSidebarStory
      initial={[
        { provider: "github", connected: true, login: "usuario-teste", permission: "ask" },
        { provider: "vercel", connected: false, permission: "ask" },
        { provider: "supabase", connected: false, permission: "ask" },
      ]}
    />
  ),
}
