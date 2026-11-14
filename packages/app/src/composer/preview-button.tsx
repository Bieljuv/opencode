import type { Accessor } from "solid-js"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { Tooltip } from "@opencode/ui/tooltip"
import { useLanguage } from "@/runtime/i18n/language"

/**
 * The preview button in the chat composer: it toggles the side region
 * (the review panel beside the chat) through the same action the session
 * header toggle and the `review.toggle` command use, so opening it here
 * and opening it there are the same panel. With nothing built yet it
 * opens the region empty; with a build in progress the preview the
 * agent opened stays where it was.
 */
export function PreviewButton(props: { opened: Accessor<boolean>; onToggle: () => void }) {
  const language = useLanguage()

  return (
    <Tooltip placement="top" value={language.t("composer.preview.tooltip")}>
      <Button
        variant="ghost-muted"
        size="normal"
        class="max-w-[220px] justify-start ![font-weight:440] aria-pressed:bg-[var(--v2-overlay-simple-overlay-pressed)] aria-pressed:text-v2-text-text-base"
        aria-label={language.t("composer.preview.label")}
        aria-pressed={props.opened()}
        onClick={props.onToggle}
      >
        <Icon name="outline-eye" />
        <span class="truncate leading-5">{language.t("composer.preview.label")}</span>
      </Button>
    </Tooltip>
  )
}
