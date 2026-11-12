import { Button } from "@opencode/ui/button"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Loader } from "@opencode/ui/loader"
import { RadioGroup, RadioItem } from "@opencode/ui/radio"
import { TextInput } from "@opencode/ui/text-input"
import { For, Match, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { CONNECTION_PROVIDERS, connectionDisplayName, type ConnectionPermission, type ConnectionProvider } from "./connections"
import { createConnectionsPanel, type ConnectionsPanelController } from "./controller"
import { cardError, cardNotice, isCardBusy, type ConnectionCardState } from "./machine"

/**
 * O painel de conexões: um cartão por provedor (GitHub, Vercel,
 * Supabase) com a descrição em linguagem simples, o estado, o botão
 * Conectar (token manual, com a instrução de onde conseguir), Testar,
 * Desconectar e a permissão (Permitir / Pedir sempre / Bloquear).
 * O token é digitado num campo de senha e some da tela ao enviar — ele
 * nunca aparece em texto visível, nem em erro: o erro é sempre genérico.
 */
export function ConnectionsDialog() {
  const language = useLanguage()
  const platform = usePlatform()
  const controller = createConnectionsPanel(platform)
  const [tokens, setTokens] = createStore<Partial<Record<ConnectionProvider, string>>>({})
  const ready = () => {
    const state = controller.state()

    return state.status === "ready" ? state : undefined
  }

  return (
    <Dialog
      containerClass="!w-[min(calc(100vw_-_16px),560px)]"
      class="[font-family:var(--v2-font-family-sans)]"
    >
      <DialogHeader closeLabel={language.t("common.close")}>
        <DialogTitleGroup
          title={language.t("connections.title")}
          description={language.t("connections.description")}
        />
      </DialogHeader>
      <DialogBody class="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <Switch>
          <Match when={controller.state().status === "loading"}>
            <div class="flex items-center gap-2 px-1 py-6 text-[13px] font-[440] leading-5 text-v2-text-text-muted">
              <Loader class="size-4 shrink-0 text-v2-icon-icon-muted" />
              <span>{language.t("settings.plugins.status.loading")}</span>
            </div>
          </Match>
          <Match when={controller.state().status === "load-failed"}>
            <div class="flex flex-col items-start gap-3 px-1 py-4">
              <p role="alert" class="text-[13px] font-[440] leading-5 text-v2-text-text-base">
                {language.t("connections.load.failed")}
              </p>
              <Button variant="neutral" onClick={() => controller.retryLoad()}>
                {language.t("common.retry")}
              </Button>
            </div>
          </Match>
          <Match when={ready()}>
            {(state) => (
              <div class="flex flex-col gap-3">
                <For each={CONNECTION_PROVIDERS}>
                  {(provider) => (
                    <ConnectionCard
                      provider={provider}
                      card={state().cards[provider]}
                      token={tokens[provider] ?? ""}
                      onTokenInput={(value) => setTokens(provider, value)}
                      onSave={() => {
                        const token = tokens[provider] ?? ""
                        setTokens(provider, "")
                        controller.save(provider, token)
                      }}
                      onTest={() => controller.test(provider)}
                      onDisconnect={() => controller.disconnect(provider)}
                      onPermission={(permission) => controller.setPermission(provider, permission)}
                    />
                  )}
                </For>
              </div>
            )}
          </Match>
        </Switch>
      </DialogBody>
    </Dialog>
  )
}

function ConnectionCard(props: {
  provider: ConnectionProvider
  card: ConnectionCardState
  token: string
  onTokenInput: (value: string) => void
  onSave: () => void
  onTest: () => void
  onDisconnect: () => void
  onPermission: (permission: ConnectionPermission) => void
}) {
  const language = useLanguage()
  const busy = () => isCardBusy(props.card)
  const error = () => cardError(props.card)
  const notice = () => cardNotice(props.card)
  const hintKey = `connections.${props.provider}.tokenHint` as const
  const descriptionKey = `connections.${props.provider}.description` as const

  return (
    <section
      data-component="connection-card"
      data-provider={props.provider}
      class="flex flex-col gap-3 rounded-[8px] border border-v2-border-border-muted px-3 py-3"
    >
      <div class="flex min-w-0 items-center gap-2">
        <span
          aria-label={language.t(props.card.connected ? "connections.connected" : "connections.disconnected")}
          class="size-2 shrink-0 rounded-full"
          classList={{
            "bg-v2-state-fg-success": props.card.connected,
            "bg-v2-icon-icon-muted": !props.card.connected,
          }}
        />
        <span class="min-w-0 truncate text-[13px] font-[530] leading-5 tracking-[-0.04px] text-v2-text-text-base">
          {connectionDisplayName(props.provider)}
        </span>
        <span class="min-w-0 truncate text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-muted">
          {props.card.connected
            ? props.card.login
              ? language.t("connections.connectedAs", { login: props.card.login })
              : language.t("connections.working")
            : language.t("connections.disconnected")}
        </span>
      </div>
      <p class="text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-muted">
        {language.t(descriptionKey)}
      </p>
      <Show when={!props.card.connected}>
        <p class="text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-muted">
          {language.t(hintKey)}
        </p>
        <form
          class="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (props.token.trim().length === 0) return
            props.onSave()
          }}
        >
          <TextInput
            class="min-w-0 flex-1"
            type="password"
            aria-label={language.t("connections.token.label")}
            placeholder={language.t("connections.token.placeholder")}
            value={props.token}
            onInput={(event) => props.onTokenInput(event.currentTarget.value)}
            disabled={busy()}
            autocomplete="off"
            spellcheck={false}
          />
          <Button type="submit" variant="contrast" disabled={busy() || props.token.trim().length === 0}>
            {language.t("connections.connect")}
          </Button>
        </form>
      </Show>
      <Show when={props.card.connected}>
        <div class="flex flex-wrap items-center gap-2">
          <Button variant="neutral" disabled={busy()} onClick={() => props.onTest()}>
            {language.t("connections.test")}
          </Button>
          <Button variant="ghost-muted" disabled={busy()} onClick={() => props.onDisconnect()}>
            {language.t("connections.disconnect")}
          </Button>
          <Show when={busy()}>
            <Loader class="size-4 shrink-0 text-v2-icon-icon-muted" />
          </Show>
        </div>
      </Show>
      <Show when={notice()}>
        <p role="status" class="text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-base">
          {props.card.login
            ? language.t("connections.test.ok", { login: props.card.login })
            : language.t("connections.test.okNoLogin")}
        </p>
      </Show>
      <Show when={error()}>
        {(code) => (
          <p role="alert" class="text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-base">
            {language.t(code() === "test-failed" ? "connections.test.failed" : "connections.save.failed")}
          </p>
        )}
      </Show>
      <RadioGroup
        label={language.t("connections.permission.label")}
        value={props.card.permission}
        onChange={(value) => {
          if (value === "allow" || value === "ask" || value === "block") props.onPermission(value)
        }}
      >
        <RadioItem value="allow" label={language.t("connections.permission.allow")} />
        <RadioItem value="ask" label={language.t("connections.permission.ask")} />
        <RadioItem value="block" label={language.t("connections.permission.block")} />
      </RadioGroup>
    </section>
  )
}

export type { ConnectionsPanelController }
