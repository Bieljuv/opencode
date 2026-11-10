import { Show, createMemo, type ComponentProps, type JSX } from "solid-js"
import { ProgressCircle } from "@opencode/ui/progress-circle"
import { Button } from "@opencode/ui/button"
import { Menu } from "@opencode/ui/menu"
import { Tooltip } from "@opencode/ui/tooltip"
import { useI18n } from "@opencode/ui/context/i18n"
import { cumulativeSessionUsage, lastAssistantWithUsage } from "@opencode/client/solid"
import { usePlugin, type MountedSession } from "@opencode/plugin/gui"
import { catalogModel, syncCatalog } from "./catalog"

export function SessionContextUsage(props: {
  session: MountedSession
  /** False while the session's view is detached; it loads nothing until selected again. */
  active?: boolean
  variant?: "button" | "indicator"
  placement?: ComponentProps<typeof Tooltip>["placement"]
  /** The button shows only its ring and opens the usage in a menu, so a narrow header keeps room for the title. */
  compact?: boolean
}) {
  const ctx = usePlugin()
  const layout = ctx.layout
  const i18n = useI18n()

  const catalog = syncCatalog(
    () => props.session,
    () => props.active !== false,
  )

  const variant = createMemo(() => props.variant ?? "button")

  const messages = createMemo(() =>
    props.session.id ? props.session.server.data.session.message.list(props.session.id) : [],
  )

  const info = createMemo(() =>
    props.session.id ? props.session.server.data.session.get(props.session.id) : undefined,
  )

  // The context window now: the latest step after the last compaction. Its usage is the
  // window gauge (how full the context is), not the session spend.
  const context = createMemo(() => {
    const message = lastAssistantWithUsage(messages(), info()?.revert?.messageID)

    if (!message) return
    const model = catalogModel(props.session, message.model)?.model

    const total =
      message.tokens.input +
      message.tokens.output +
      message.tokens.reasoning +
      message.tokens.cache.read +
      message.tokens.cache.write

    return {
      usage: model?.limit.context ? Math.round((total / model.limit.context) * 100) : null,
    }
  })

  // Every token the session has spent, across all models and providers that answered.
  // The total only grows: a model switch or a compaction never moves it back.
  const cumulative = createMemo(() => cumulativeSessionUsage(messages(), info()?.revert?.messageID))

  const tokens = createMemo(() =>
    new Intl.NumberFormat(i18n.locale(), { notation: "compact", maximumFractionDigits: 0 })
      .format(cumulative().total)
      .toLocaleLowerCase(i18n.locale()),
  )

  const openContext = () => {
    if (!props.session.id) return
    catalog.retry()
    layout.toggle(`${ctx.id}:main`, props.session)
  }

  const viewContext = () => {
    if (!props.session.id) return
    catalog.retry()
    layout.open(`${ctx.id}:main`, props.session)
  }

  const circle = () => (
    <div class="flex items-center justify-center">
      <ProgressCircle
        appearance="indicator"
        size={16}
        strokeWidth={2}
        percentage={context()?.usage ?? 0}
        style={{
          "--progress-circle-background": "var(--v2-background-bg-layer-04)",
          "--progress-circle-background-overlay": "var(--v2-overlay-simple-overlay-pressed, transparent)",
          "--progress-circle-progress": "var(--v2-icon-icon-base, var(--icon-base))",
        }}
      />
    </div>
  )

  const compactCircle = () => (
    <div class="flex items-center justify-center">
      <ProgressCircle appearance="compact" size={16} percentage={context()?.usage ?? 0} />
    </div>
  )

  const menuRow = (name: JSX.Element, value: JSX.Element) => (
    <div class="flex h-7 min-w-0 items-center gap-4 px-3 text-[13px] font-[440] leading-[var(--line-height-compact)] tracking-[-0.04px]">
      <span class="shrink-0 text-v2-text-text-muted">{name}</span>
      <span class="ml-auto min-w-0 truncate text-right tabular-nums text-v2-text-text-base">{value}</span>
    </div>
  )

  const usageMenu = () => (
    <Menu
      placement="bottom-end"
      gutter={4}
      modal={false}
      onOpenChange={(open) => {
        if (open) catalog.retry()
      }}
    >
      <Tooltip value={ctx.t("usage.view")} placement={props.placement ?? "top"}>
        <Menu.Trigger
          as={Button}
          type="button"
          variant="ghost-muted"
          class="group shrink-0"
          style={{ padding: "0 6px", color: "var(--v2-text-text-faint)" }}
          aria-label={ctx.t("usage.view")}
        >
          {compactCircle()}
        </Menu.Trigger>
      </Tooltip>
      <Menu.Portal>
        <Menu.Content class="w-[200px] max-w-[calc(100vw-16px)]" aria-label={ctx.t("usage.view")}>
          {menuRow(ctx.t("usage.tokens"), cumulative().total.toLocaleString(i18n.locale()))}
          {menuRow(ctx.t("usage.usage"), `${context()?.usage ?? 0}%`)}
          <Menu.Separator />
          <Menu.Item onSelect={viewContext}>{ctx.t("usage.view")}</Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu>
  )

  return (
    <Show when={props.session.id}>
      <Show when={!props.compact} fallback={usageMenu()}>
        <Show
          when={variant() === "indicator"}
          fallback={
            <Tooltip value={ctx.t("usage.toggle")} placement={props.placement ?? "top"}>
              <Button
                type="button"
                variant="ghost-muted"
                class="group shrink-0"
                style={{ padding: "0 6px", color: "var(--v2-text-text-faint)" }}
                onClick={openContext}
                aria-expanded={layout.state(`${ctx.id}:main`, props.session) === "visible"}
                aria-label={ctx.t("usage.toggle")}
              >
                <span class="flex items-center gap-2 whitespace-nowrap group-active:text-v2-text-text-muted">
                  {compactCircle()}
                  <span>{tokens()}</span>
                </span>
              </Button>
            </Tooltip>
          }
        >
          {circle()}
        </Show>
      </Show>
    </Show>
  )
}
