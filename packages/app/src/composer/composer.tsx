import { formatKeybind, useCommand } from "@/shell/commands/command"
import { useLanguage } from "@/runtime/i18n/language"
import { DictationButton } from "@/voice/dictation"
import { ComposerEditor } from "./editor/editor"
import type { ComposerModel } from "./model"

export function Composer(props: {
  class?: string
  model: ComposerModel
  borderUnderlay?: boolean
  readOnly?: boolean
  suggestionBoundary?: () => HTMLElement | undefined
}) {
  const command = useCommand()
  const language = useLanguage()

  return (
    <div class="flex flex-col gap-3">
      <ComposerEditor
        controller={props.model}
        borderUnderlay={props.borderUnderlay}
        readOnly={props.readOnly}
        class={props.class}
        modelControlsVisible={!props.model.model.loading || !!props.model.model.preview}
        attachKeybind={command.keybindParts("file.attach")}
        attachShortcut={command.keybind("file.attach")}
        dictationControl={<DictationButton controller={props.model} />}
        alternateKeybind={[formatKeybind("mod", language.t), "↵"]}
        exitShellKeybind={[formatKeybind("esc", language.t)]}
        suggestionBoundary={props.suggestionBoundary}
        modelControl={
          <span class="flex h-[28px] items-center text-[13px] font-[440] leading-4 text-v2-text-text-faint">
            {"✦ "}
            {language.t("composer.model.automatic")}
          </span>
        }
      />
    </div>
  )
}
