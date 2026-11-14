import type { Accessor } from "solid-js"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { Tooltip } from "@opencode/ui/tooltip"
import { useLanguage } from "@/runtime/i18n/language"

/**
 * The camera button in the chat composer: it captures the preview the side region shows (the project's browser tab)
 * and attaches the shot to the draft, so the agent sees what the user sees. Disabled while the preview is closed,
 * while the browser pane is off, or while a capture runs; it never captures anything else, and never the whole
 * screen. A capture that cannot run shows only the generic failure message.
 */
export function CameraButton(props: {
  enabled: Accessor<boolean>
  capturing: Accessor<boolean>
  onCapture: () => void
}) {
  const language = useLanguage()
  const disabled = () => !props.enabled() || props.capturing()

  return (
    <Tooltip
      placement="top"
      value={language.t(disabled() ? "composer.camera.tooltipUnavailable" : "composer.camera.tooltip")}
    >
      <Button
        variant="ghost-muted"
        size="normal"
        class="max-w-[220px] justify-start ![font-weight:440]"
        aria-label={language.t("composer.camera.label")}
        disabled={disabled()}
        onClick={props.onCapture}
      >
        <Icon name="camera" />
        <span class="truncate leading-5">{language.t("composer.camera.label")}</span>
      </Button>
    </Tooltip>
  )
}
