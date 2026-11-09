import { useCommand, type CommandOption } from "@/shell/commands/command"
import { useLanguage } from "@/runtime/i18n/language"
import { useLocal, type ModelSelection } from "@/providers/models/selection"
import { useServerSDK } from "@/runtime/server/client"
import { formatServerError } from "@/runtime/server/errors"
import { showToast } from "@/shell/notifications/toast"
import { toaster } from "@opencode/ui/toast"
import { createConfigReloadState, transitionConfigReload, type ConfigReloadEvent } from "@/composer/reload-machine"

const withCategory = (category: string) => {
  return (option: Omit<CommandOption, "category">): CommandOption => ({
    ...option,
    category,
  })
}

export const useComposerCommands = (_input: { model?: ModelSelection } = {}) => {
  const command = useCommand()
  const language = useLanguage()
  const local = useLocal()
  const sdk = useServerSDK()
  const agentCommand = withCategory(language.t("command.category.agent"))
  const serverCommand = withCategory(language.t("command.category.server"))

  // Mirrors the TUI's `/reload`. The server rebuilds every loaded location and announces the changed agents,
  // commands, models and skills, so the data layer refreshes them without restarting the app.
  // The result still reports after this composer unmounts: toasts are app-wide.
  let reloadState = createConfigReloadState()
  let reloadToast: number | undefined

  const reloadConfig = (event: ConfigReloadEvent) => {
    const next = transitionConfigReload(reloadState, event)
    reloadState = next.state
    next.effects.forEach((effect) => {
      if (effect.type === "reload.run")
        return void sdk.api.location.reload().then(
          () => reloadConfig({ type: "reload.succeeded", attempt: effect.attempt }),
          (cause: unknown) => reloadConfig({ type: "reload.failed", attempt: effect.attempt, cause }),
        )

      if (effect.type === "toast.pending.show")
        return void (reloadToast = showToast({
          variant: "loading",
          title: language.t("command.config.reload.pending"),
          persistent: true,
        }))

      if (effect.type === "toast.pending.dismiss") {
        if (reloadToast !== undefined) toaster.dismiss(reloadToast)
        reloadToast = undefined

        return
      }

      if (effect.type === "toast.succeeded")
        return void showToast({ variant: "success", title: language.t("command.config.reload.done") })

      showToast({
        variant: "error",
        title: language.t("command.config.reload.failed"),
        description: formatServerError(effect.cause, language.t),
      })
    })
  }

  command.register("composer", () => [
    serverCommand({
      id: "config.reload",
      title: language.t("command.config.reload"),
      description: language.t("command.config.reload.description"),
      slash: "reload",
      onSelect: () => reloadConfig({ type: "reload.requested" }),
    }),
    agentCommand({
      id: "agent.cycle",
      title: language.t("command.agent.cycle"),
      description: language.t("command.agent.cycle.description"),
      keybind: "mod+.",
      slash: "agent",
      disabled: !local.agent.visible(),
      onSelect: () => local.agent.move(1),
    }),
    agentCommand({
      id: "agent.cycle.reverse",
      title: language.t("command.agent.cycle.reverse"),
      description: language.t("command.agent.cycle.reverse.description"),
      keybind: "shift+mod+.",
      disabled: !local.agent.visible(),
      onSelect: () => local.agent.move(-1),
    }),
  ])
}
