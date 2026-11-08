import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import { writeClipboard } from "@opencode/session-ui/copy"
import { Tooltip } from "@opencode/ui/tooltip"
import { useLanguage } from "@/runtime/i18n/language"
import { useCommand } from "@/shell/commands/command"
import { usePlatform } from "@/runtime/platform/platform"
import { showToast } from "@/shell/notifications/toast"
import manostechLogo from "@/assets/manostech-logo.png"
import {
  INITIAL_ABOUT_COPY_STATE,
  selectAboutCopyView,
  transitionAboutCopy,
  type AboutCopyEffect,
  type AboutCopyEvent,
} from "./machine"

export function SettingsAbout(props: { active: boolean }) {
  const language = useLanguage()
  const command = useCommand()
  const platform = usePlatform()
  const [copyState, setCopyState] = createSignal(INITIAL_ABOUT_COPY_STATE)
  const copy = createMemo(() => selectAboutCopyView(copyState()))
  const version = () => platform.version ?? language.t("settings.about.devVersion")
  const versionLabel = () => language.t("settings.about.version", { version: version() })
  let copyTimer: ReturnType<typeof setTimeout> | undefined

  const dispatchCopy = (event: AboutCopyEvent) =>
    untrack(() => {
      const previous = copyState()
      const next = transitionAboutCopy(previous, event)

      if (next.state !== previous) setCopyState(next.state)
      next.effects.forEach(runCopyEffect)
    })

  function runCopyEffect(effect: AboutCopyEffect) {
    if (effect.type === "timer.clear") return clearTimeout(copyTimer)

    if (effect.type === "timer.schedule") {
      clearTimeout(copyTimer)
      copyTimer = setTimeout(() => dispatchCopy({ type: effect.event, attempt: effect.attempt }), effect.delayMs)

      return
    }

    if (effect.type === "toast.failed")
      return showToast({ variant: "error", title: language.t("settings.about.copyVersionFailed") })

    const attempt = effect.attempt
    // Plain-HTTP LAN origins have no `navigator.clipboard`; `writeClipboard` falls back to a selected textarea there.
    void Promise.try(() =>
      platform.writeClipboardText ? platform.writeClipboardText(effect.text).then(() => true) : writeClipboard(effect.text),
    ).then(
      (written) => dispatchCopy({ type: written ? "copy.succeeded" : "copy.failed", attempt }),
      () => dispatchCopy({ type: "copy.failed", attempt }),
    )
  }

  createEffect(() => {
    if (!props.active) dispatchCopy({ type: "hidden" })
  })
  onCleanup(() => dispatchCopy({ type: "disposed" }))

  return (
    <div class="settings-about-content">
      <div class="settings-about-intro">
        <div class="settings-about-version-line">
          <Tooltip
            value={language.t(copy().copied ? "common.copied" : "ui.message.copy")}
            placement="top"
            forceOpen={copy().forceOpen}
          >
            <button
              type="button"
              class="settings-about-version"
              disabled={copy().disabled}
              aria-label={language.t(copy().copied ? "common.copied" : "ui.message.copy")}
              onClick={() => dispatchCopy({ type: "copy.requested", text: versionLabel() })}
            >
              <span>
                {language.rich("settings.about.version", {
                  version: <bdi dir="ltr">{version()}</bdi>,
                })}
              </span>
            </button>
          </Tooltip>
        </div>
        <p>
          <button type="button" class="settings-about-link" onClick={() => void command.trigger("updater.check")}>
            {language.t("settings.about.checkUpdates")}
          </button>
        </p>
        <p>{language.t("settings.about.license")}</p>
      </div>

      <div class="mx-auto w-fit" aria-hidden="true">
        <img src={manostechLogo} alt="" class="size-28" />
      </div>

      <div class="settings-about-details">
        <p>{language.t("settings.about.description")}</p>
      </div>
    </div>
  )
}
