import { useDialog } from "@opencode/ui/context/dialog"
import { For } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform, type Platform } from "@/runtime/platform/platform"
import { CONNECTION_PROVIDERS, connectionDisplayName, type ConnectionProvider } from "./connections"
import { ConnectionsDialog } from "./panel"
import { createConnectionsStatus } from "./status"

/**
 * A seção "Conexões" da barra lateral, abaixo de Projetos: uma linha por
 * provedor (GitHub, Vercel, Supabase) com a bolinha de estado — verde
 * conectado, cinza desconectado. Clicar abre o painel de conexões.
 * Só existe no aplicativo de computador: na web não há onde guardar os
 * tokens, então a seção nem aparece.
 */
export function ConnectionsSidebarSection() {
  const platform = usePlatform()

  if (platform.platform !== "desktop" || !platform.getConnectionsStatus) return null

  return <ConnectionsSidebarSectionDesktop platform={platform} />
}

function ConnectionsSidebarSectionDesktop(props: {
  platform: Pick<Platform, "getConnectionsStatus" | "onConnectionsChanged">
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const source = createConnectionsStatus(props.platform)
  const open = () => void dialog.show(() => <ConnectionsDialog />)

  return (
    <section class="flex shrink-0 flex-col gap-2">
      <button
        type="button"
        class="flex h-6 w-full shrink-0 items-center gap-1.5 rounded-[6px] px-2 text-start text-[13px] leading-4 font-medium text-v2-text-text-muted hover:text-v2-text-text-base focus-visible:outline-none focus-visible:bg-v2-overlay-simple-overlay-hover"
        onClick={open}
      >
        <span class="min-w-0 truncate">{language.t("connections.title")}</span>
      </button>
      <div class="flex min-w-0 flex-col gap-1">
        <For each={CONNECTION_PROVIDERS}>
          {(provider) => (
            <ConnectionRow
              provider={provider}
              connected={source.statusOf(provider)?.connected ?? false}
              onOpen={open}
            />
          )}
        </For>
      </div>
    </section>
  )
}

function ConnectionRow(props: { provider: ConnectionProvider; connected: boolean; onOpen: () => void }) {
  const language = useLanguage()

  return (
    <button
      type="button"
      data-component="connection-row"
      data-provider={props.provider}
      class="flex h-7 min-w-0 shrink-0 cursor-default items-center gap-2 rounded-[6px] px-2 text-start text-[13px] leading-[var(--line-height-compact)] text-v2-text-text-muted [font-weight:440] transition-colors duration-[120ms] ease-in-out hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base focus-visible:text-v2-text-text-base focus-visible:outline-none"
      onClick={props.onOpen}
    >
      <span
        aria-label={language.t(props.connected ? "connections.connected" : "connections.disconnected")}
        class="size-2 shrink-0 rounded-full"
        classList={{
          "bg-v2-state-fg-success": props.connected,
          "bg-v2-icon-icon-muted": !props.connected,
        }}
      />
      <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap" dir="auto">
        {connectionDisplayName(props.provider)}
      </span>
    </button>
  )
}
