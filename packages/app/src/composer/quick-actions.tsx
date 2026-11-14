import { For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { IconButton } from "@opencode/ui/icon-button"
import { Icon } from "@opencode/ui/icon"
import type { IconName } from "@opencode/ui/icons/catalog"
import { Menu } from "@opencode/ui/menu"
import { MenuScroll } from "@opencode/ui/menu-scroll"
import { Tooltip } from "@opencode/ui/tooltip"
import type { ComposerModel } from "./model"

// Quick actions in the chat, like the old editor: a ⚡ button in the
// composer footer opens a dropdown above the composer. Categories start
// closed; each action sends its prompt as a chat message. Nothing changes
// in the project without the approval step that follows (approval before
// building still applies).
type QuickActionPromptKey =
  | "composer.quickActions.blindar.prompt"
  | "composer.quickActions.arena.prompt"
  | "composer.quickActions.testDevices.prompt"
  | "composer.quickActions.speed.prompt"
  | "composer.quickActions.images.prompt"
  | "composer.quickActions.responsive.prompt"
  | "composer.quickActions.texts.prompt"

type QuickAction = {
  id: string
  icon: IconName
  titleKey: string
  descriptionKey: string
  // A prompt resolved through i18n, or a command ("/strix", "/publicar")
  // sent as-is.
  send: { kind: "prompt"; key: QuickActionPromptKey } | { kind: "command"; text: string }
  disabled?: boolean
}

type QuickActionCategory = {
  id: string
  titleKey: string
  actions: QuickAction[]
}

const CATEGORIES: QuickActionCategory[] = [
  {
    id: "audit",
    titleKey: "composer.quickActions.category.audit",
    actions: [
      {
        id: "blindar",
        icon: "shield",
        titleKey: "composer.quickActions.blindar.title",
        descriptionKey: "composer.quickActions.blindar.description",
        send: { kind: "prompt", key: "composer.quickActions.blindar.prompt" },
      },
      {
        id: "strix",
        icon: "review",
        titleKey: "composer.quickActions.strix.title",
        descriptionKey: "composer.quickActions.strix.description",
        send: { kind: "command", text: "/strix" },
      },
    ],
  },
  {
    id: "tests",
    titleKey: "composer.quickActions.category.tests",
    actions: [
      {
        id: "arena",
        icon: "flask",
        titleKey: "composer.quickActions.arena.title",
        descriptionKey: "composer.quickActions.arena.description",
        send: { kind: "prompt", key: "composer.quickActions.arena.prompt" },
      },
      {
        id: "test-devices",
        icon: "outline-monitor",
        titleKey: "composer.quickActions.testDevices.title",
        descriptionKey: "composer.quickActions.testDevices.description",
        send: { kind: "prompt", key: "composer.quickActions.testDevices.prompt" },
      },
    ],
  },
  {
    id: "performance",
    titleKey: "composer.quickActions.category.performance",
    actions: [
      {
        id: "speed",
        icon: "window-analytics",
        titleKey: "composer.quickActions.speed.title",
        descriptionKey: "composer.quickActions.speed.description",
        send: { kind: "prompt", key: "composer.quickActions.speed.prompt" },
      },
      {
        id: "images",
        icon: "outline-photo",
        titleKey: "composer.quickActions.images.title",
        descriptionKey: "composer.quickActions.images.description",
        send: { kind: "prompt", key: "composer.quickActions.images.prompt" },
      },
    ],
  },
  {
    id: "appearance",
    titleKey: "composer.quickActions.category.appearance",
    actions: [
      {
        id: "responsive",
        icon: "outline-smartphone",
        titleKey: "composer.quickActions.responsive.title",
        descriptionKey: "composer.quickActions.responsive.description",
        send: { kind: "prompt", key: "composer.quickActions.responsive.prompt" },
      },
      {
        id: "texts",
        icon: "edit",
        titleKey: "composer.quickActions.texts.title",
        descriptionKey: "composer.quickActions.texts.description",
        send: { kind: "prompt", key: "composer.quickActions.texts.prompt" },
      },
      {
        id: "visual",
        icon: "appearance",
        titleKey: "composer.quickActions.visual.title",
        descriptionKey: "composer.quickActions.visual.description",
        send: { kind: "command", text: "" },
        // Gated on the Impeccable decisions: shown, but not usable yet.
        disabled: true,
      },
    ],
  },
  {
    id: "publish",
    titleKey: "composer.quickActions.category.publish",
    actions: [
      {
        id: "publish",
        icon: "cloud-upload",
        titleKey: "composer.quickActions.publish.title",
        descriptionKey: "composer.quickActions.publish.description",
        send: { kind: "command", text: "/publicar" },
      },
      {
        id: "download",
        icon: "download",
        titleKey: "composer.quickActions.download.title",
        descriptionKey: "composer.quickActions.download.description",
        send: { kind: "command", text: "/baixar-projeto" },
      },
    ],
  },
]

export function QuickActionsButton(props: { controller: ComposerModel }) {
  const language = useLanguage()
  const [expanded, setExpanded] = createStore<Record<string, boolean>>({})

  const sendAction = (action: QuickAction) => {
    const prompt = action.send.kind === "prompt" ? language.t(action.send.key) : action.send.text

    if (!prompt) return
    // An empty composer sends the action prompt right away, like the old
    // editor. With a draft in progress, the prompt goes in at the caret
    // instead, so the user's text is never replaced or sent by surprise.
    if (!props.controller.value().trim()) {
      props.controller.onInput(
        prompt,
        [{ type: "text", content: prompt, start: 0, end: prompt.length }],
        prompt.length,
      )
      props.controller.submit()
      return
    }
    props.controller.insertText(prompt)
  }

  return (
    <Tooltip placement="top" value={language.t("composer.quickActions.title")}>
      <Menu gutter={6} modal={false} placement="top-start">
        <Menu.Trigger
          as={IconButton}
          data-action="composer-quick-actions"
          type="button"
          icon={
            <span aria-hidden="true" class="text-[16px] leading-[var(--line-height-compact)]">
              ⚡
            </span>
          }
          variant="ghost-muted"
          size="large"
          disabled={props.controller.planBlocked() !== undefined}
          aria-label={language.t("composer.quickActions.title")}
        />
        <Menu.Portal>
          <Menu.Content style={{ width: "320px", "max-width": "92vw" }}>
            <MenuScroll class="max-h-[62vh]" viewportClass="py-1">
              <div class="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-v2-text-text-faint">
                {language.t("composer.quickActions.title")}
              </div>
            <For each={CATEGORIES}>
              {(category) => (
                <>
                  <button
                    type="button"
                    class="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[13px] font-[500] leading-5 text-v2-text-text-base hover:bg-v2-background-bg-layer-02"
                    aria-expanded={expanded[category.id] ?? false}
                    onClick={() => setExpanded(category.id, (open) => !open)}
                  >
                    <Icon
                      name={expanded[category.id] ? "chevron-down" : "chevron-right"}
                      size="small"
                      class="shrink-0 text-v2-text-text-faint"
                    />
                    {language.t(category.titleKey)}
                  </button>
                  <Show when={expanded[category.id]}>
                    <For each={category.actions}>
                      {(action) => (
                        <Menu.Item
                          disabled={action.disabled}
                          data-multiline
                          badge={
                            action.disabled ? (
                              <span class="text-[11px] leading-[var(--line-height-compact)] text-v2-text-text-faint">
                                {language.t("composer.quickActions.soon")}
                              </span>
                            ) : undefined
                          }
                          onSelect={() => sendAction(action)}
                        >
                          <span class="flex w-full items-start gap-2.5 text-left">
                            <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-02 text-v2-text-text-faint">
                              <Icon name={action.icon} size="small" />
                            </span>
                            <span class="min-w-0">
                              <span class="block text-[13px] font-[500] leading-5 text-v2-text-text-base">
                                {language.t(action.titleKey)}
                              </span>
                              <span class="block text-[11px] leading-[var(--line-height-compact)] text-v2-text-text-faint">
                                {language.t(action.descriptionKey)}
                              </span>
                            </span>
                          </span>
                        </Menu.Item>
                      )}
                    </For>
                  </Show>
                </>
              )}
            </For>
            </MenuScroll>
          </Menu.Content>
        </Menu.Portal>
      </Menu>
    </Tooltip>
  )
}
