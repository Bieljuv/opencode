import { For, Show } from "solid-js"
import { formatKeybind, useCommand } from "@/shell/commands/command"
import { useLanguage } from "@/runtime/i18n/language"
import { DictationButton } from "@/voice/dictation"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { Menu } from "@opencode/ui/menu"
import { Tooltip } from "@opencode/ui/tooltip"
import { ComposerEditor } from "./editor/editor"
import { ROUTER_EFFORTS, ROUTER_EFFORT_LABEL_KEYS, parseRouterEffort } from "./effort"
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

  // ManosTech: the plan block locks the composer. The notice shows only
  // the generic message plus the release time (America/Sao_Paulo) — never
  // a model, provider, tier, quota, limit or routing detail.
  const releaseLabel = (releasesAt: string) =>
    new Intl.DateTimeFormat(language.intl(), {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "America/Sao_Paulo",
    }).format(new Date(releasesAt))

  return (
    <div class="flex flex-col gap-3">
      <Show when={props.model.planBlocked()}>
        {(block) => (
          <p class="text-center text-[13px] leading-[var(--line-height-compact)] text-muted" role="status">
            {language.t("client.usage.blocked.message", { time: releaseLabel(block().releasesAt) })}
          </p>
        )}
      </Show>
      <ComposerEditor
        controller={props.model}
        disabled={props.model.planBlocked() !== undefined}
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
          <>
            <span class="flex h-[28px] items-center text-[13px] font-[440] leading-4 text-v2-text-text-faint">
              {"✦ "}
              {language.t("composer.model.automatic")}
            </span>
            <Tooltip placement="top" value={language.t("composer.effort.label")}>
              <Menu gutter={6} modal={false} placement="top-start">
                <Menu.Trigger
                  as={Button}
                  variant="ghost-muted"
                  size="normal"
                  class="max-w-[220px] justify-start ![font-weight:440]"
                  aria-label={language.t("composer.effort.label")}
                >
                  <span class="truncate capitalize leading-5">
                    {language.t(ROUTER_EFFORT_LABEL_KEYS[props.model.effort.current()])}
                  </span>
                  <span class="-ms-0.5 -me-1 flex shrink-0">
                    <Icon name="chevron-down" />
                  </span>
                </Menu.Trigger>
                <Menu.Portal>
                  <Menu.Content>
                    <Menu.RadioGroup
                      value={props.model.effort.current()}
                      onChange={(value) => {
                        const effort = parseRouterEffort(value)

                        if (effort) props.model.effort.set(effort)
                      }}
                    >
                      <For each={ROUTER_EFFORTS}>
                        {(effort) => (
                          <Menu.RadioItem value={effort} class="capitalize" closeOnSelect>
                            {language.t(ROUTER_EFFORT_LABEL_KEYS[effort])}
                          </Menu.RadioItem>
                        )}
                      </For>
                    </Menu.RadioGroup>
                  </Menu.Content>
                </Menu.Portal>
              </Menu>
            </Tooltip>
            <Tooltip placement="top" value={language.t("composer.multiAgent.hint")}>
              <Button
                variant="ghost-muted"
                size="normal"
                class="max-w-[220px] justify-start ![font-weight:440] aria-pressed:bg-[var(--v2-overlay-simple-overlay-pressed)] aria-pressed:text-v2-text-text-base"
                aria-label={language.t("composer.multiAgent.label")}
                aria-pressed={props.model.multiAgent.current()}
                onClick={() => props.model.multiAgent.set(!props.model.multiAgent.current())}
              >
                <Show when={props.model.multiAgent.current()}>
                  <Icon name="check" />
                </Show>
                <span class="truncate leading-5">{language.t("composer.multiAgent.label")}</span>
              </Button>
            </Tooltip>
          </>
        }
      />
    </div>
  )
}
