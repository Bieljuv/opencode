import { createMemo, createSignal, on, onCleanup, onMount, For, Show } from "solid-js"
import type { JSX } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { checksum } from "@opencode/util/encode"
import { Icon } from "@opencode/ui/icon"
import { Button } from "@opencode/ui/button"
import { Loader } from "@opencode/ui/loader"
import { Accordion } from "@opencode/ui/accordion"
import { StickyAccordionHeader } from "@opencode/ui/sticky-accordion-header"
import { showToast } from "@opencode/ui/toast"
import { useI18n } from "@opencode/ui/context/i18n"
import { File } from "@opencode/session-ui/file"
import type { SessionMessageInfo } from "@opencode/client/promise"
import { cumulativeSessionUsage, lastAssistantWithUsage } from "@opencode/client/solid"
import { createKeyed, usePlugin, type DailyTokens, type MountedSession, type WeeklyTokens } from "@opencode/plugin/gui"
import { catalogModel, syncCatalog } from "./catalog"
import { fetchSessionExport, sanitizeMessageForDisplay, sessionExportFilename } from "./export"
import { createSessionContextFormatter } from "./format"
import { WeeklyUsageSection } from "./weekly-usage-bar"
import {
  createContextScrollState,
  createSessionExportState,
  selectSessionExporting,
  transitionContextScroll,
  transitionSessionExport,
  type ContextScrollEffect,
  type ContextScrollEvent,
  type SessionExportEffect,
  type SessionExportEvent,
} from "./machine"

function Stat(props: { label: string; value: JSX.Element }) {
  return (
    <div class="flex flex-col gap-1">
      <div class="text-12-regular text-text-weak">{props.label}</div>
      <div class="text-12-medium text-text-strong">{props.value}</div>
    </div>
  )
}

function RawMessageContent(props: { message: SessionMessageInfo; onRendered: () => void }) {
  const file = createMemo(() => {
    // The raw view shows what an export shows: the message without its model, cost or
    // provider mentions. Model switches never reach this component (see rawMessages).
    const sanitized = sanitizeMessageForDisplay(props.message)
    const contents = sanitized ? JSON.stringify(sanitized, null, 2) : ""

    return {
      name: `${props.message.type}-${props.message.id}.json`,
      contents,
      cacheKey: checksum(contents),
    }
  })

  return (
    <File mode="text" file={file()} overflow="wrap" class="select-text" onRendered={props.onRendered} />
  )
}

function RawMessage(props: {
  message: SessionMessageInfo
  onRendered: () => void
  time: (value: number | undefined) => string
}) {
  return (
    <Accordion.Item value={props.message.id}>
      <StickyAccordionHeader>
        <Accordion.Trigger>
          <div class="flex items-center justify-between gap-2 w-full">
            <div class="min-w-0 truncate">
              {props.message.type} <span class="text-text-base">• {props.message.id}</span>
            </div>
            <div class="flex items-center gap-3">
              <div class="shrink-0 text-12-regular text-text-weak">{props.time(props.message.time.created)}</div>
              <Icon name="chevron-grabber-vertical" size="small" class="shrink-0 text-text-weak" />
            </div>
          </div>
        </Accordion.Trigger>
      </StickyAccordionHeader>
      <Accordion.Content class="bg-background-base">
        <div class="p-3">
          <RawMessageContent message={props.message} onRendered={props.onRendered} />
        </div>
      </Accordion.Content>
    </Accordion.Item>
  )
}

const emptyMessages: SessionMessageInfo[] = []

export default function SessionContextTab(props: { session: MountedSession }) {
  const ctx = usePlugin()
  const layout = ctx.layout
  const system = ctx.system
  const i18n = useI18n()
  const data = () => props.session.server.data
  syncCatalog(() => props.session)

  const info = createMemo(() => (props.session.id ? data().session.get(props.session.id) : undefined))

  const messages = createMemo(
    () => {
      const id = props.session.id

      if (!id) return emptyMessages

      return data().session.message.list(id)
    },
    emptyMessages,
    { equals: same },
  )

  // Model switches are hop metadata, not conversation — the raw list omits them, like the export.
  const rawMessages = createMemo(() => messages().filter((message) => message.type !== "model-switched"))

  // The context window now: the latest step after the last compaction.
  // The "Modelo" row reads "Automático" once such a step exists, "—"
  // before the first answer. The window gauge itself (limit, usage)
  // is gone from the grid — the app compacts on its own, and the user
  // never acts on the window.
  const context = createMemo(() => {
    const message = lastAssistantWithUsage(messages(), info()?.revert?.messageID)

    if (!message) return
    const entry = catalogModel(props.session, message.model)

    const total =
      message.tokens.input +
      message.tokens.output +
      message.tokens.reasoning +
      message.tokens.cache.read +
      message.tokens.cache.write

    return {
      message,
      limit: entry?.model?.limit.context,
      usage: entry?.model?.limit.context ? Math.round((total / entry.model.limit.context) * 100) : null,
    }
  })

  // Every token the session has spent, across all models and providers that answered.
  // The total only grows: a model switch or a compaction never moves it back.
  const cumulative = createMemo(() => cumulativeSessionUsage(messages(), info()?.revert?.messageID))

  // ManosTech: the day total — every token spent today across every
  // session on this server, from the server's own session data. While
  // it loads (or when the host cannot answer) the stat falls back to
  // the session total, so the number never blanks and never goes back.
  // The breakdown below is the day total's own parts, in the same
  // scope: the total and its parts always add up. Without the day
  // data, total and parts both fall back to the session cumulative,
  // so the scopes stay consistent either way.
  const [daily, setDaily] = createSignal<DailyTokens | undefined>(undefined)
  const [weekly, setWeekly] = createSignal<WeeklyTokens | undefined>(undefined)

  const loadDaily = async () => {
    const serverID = props.session.server.id
    const getDailyTokens = ctx.dailyTokens

    if (!getDailyTokens) return

    const value = await getDailyTokens(serverID).catch(() => undefined)

    if (ctx.signal.aborted) return

    if (!value) return

    if (props.session.server.id !== serverID) return

    setDaily(value)
  }

  // The week total, same source as the day total over the week: every
  // token spent this week across every session on this server. While
  // it loads (or when the host cannot answer) the stat falls back to
  // the day total, so the number never blanks and never goes back.
  const loadWeekly = async () => {
    const serverID = props.session.server.id
    const getWeeklyTokens = ctx.weeklyTokens

    if (!getWeeklyTokens) return

    const value = await getWeeklyTokens(serverID).catch(() => undefined)

    if (ctx.signal.aborted) return

    if (!value) return

    if (props.session.server.id !== serverID) return

    setWeekly(value)
  }

  onMount(() => {
    const timer = setInterval(() => {
      void loadDaily()
      void loadWeekly()
    }, 60_000)

    onCleanup(() => clearInterval(timer))
  })

  // A server change reloads at once instead of waiting for the next poll.
  createKeyed(
    () => props.session.server.id,
    () => {
      void loadDaily()
      void loadWeekly()
    },
  )

  const formatter = createMemo(() => createSessionContextFormatter(i18n.locale()))

  // One line for the router's choice: provider and model both read
  // "Automático", so the two rows said the same thing. The router
  // picks the model silently; the user never sees which one answered.
  const aiLabel = createMemo(() => {
    if (!context()) return "—"

    return ctx.t("stats.automatic")
  })

  // The grid shows what the user can act on: the session, how many
  // messages it holds, the two totals — today and this week, side by
  // side — the router's choice, and the day total's own parts. The
  // message split (user/assistant) is gone: it never added up to the
  // total, and the total alone says how long the session is.
  // "Sessão criada" and "Última atividade" are gone: dates the user
  // never acts on.
  const stats = [
    { label: "stats.session", value: () => info()?.title ?? (props.session.id || "—") },
    { label: "stats.messages", value: () => messages().length.toLocaleString(i18n.locale()) },
    { label: "stats.totalTokens", value: () => formatter().number(daily()?.total ?? cumulative().total) },
    {
      label: "stats.weekTotal",
      value: () => formatter().number(weekly()?.total ?? daily()?.total ?? cumulative().total),
    },
    { label: "stats.model", value: aiLabel },
    { label: "stats.inputTokens", value: () => formatter().number(daily()?.breakdown.input ?? cumulative().input) },
    { label: "stats.outputTokens", value: () => formatter().number(daily()?.breakdown.output ?? cumulative().output) },
    {
      label: "stats.reasoningTokens",
      value: () => formatter().number(daily()?.breakdown.reasoning ?? cumulative().reasoning),
    },
    {
      label: "stats.cacheTokens",
      value: () =>
        formatter().number(
          (daily()?.breakdown.cache.read ?? cumulative().cache.read) +
            (daily()?.breakdown.cache.write ?? cumulative().cache.write),
        ),
    },
  ] satisfies { label: string; value: () => JSX.Element }[]

  const [exportState, setExportState] = createSignal(createSessionExportState())
  const exportControllers = new Map<number, AbortController>()
  const exporting = () => selectSessionExporting(exportState(), props.session.key)

  const dispatchExport = (event: SessionExportEvent) => {
    const next = transitionSessionExport(exportState(), event)

    setExportState(next.state)
    next.effects.forEach(
      (effect) =>
        void Promise.try(() => runExport(effect)).catch((cause: unknown) => console.error("[context] export", cause)),
    )
  }

  const runExport = (effect: SessionExportEffect) => {
    if (effect.type === "export.fetch") {
      const controller = new AbortController()

      const failed = (cause: unknown) =>
        dispatchExport({
          type: "export.failed",
          attempt: effect.attempt,
          sessionKey: effect.sessionKey,
          message: cause instanceof Error ? cause.message : undefined,
        })

      exportControllers.set(effect.attempt, controller)
      // Runs inside the click that asked for it, so the routed session is the one being exported.
      const api = props.session.server.client
      void Promise.try(() => fetchSessionExport({ sessionID: effect.sessionID, api, signal: controller.signal }))
        .then(
          (data) =>
            dispatchExport({ type: "export.fetched", attempt: effect.attempt, sessionKey: effect.sessionKey, data }),
          failed,
        )
        .finally(() => exportControllers.delete(effect.attempt))

      return
    }

    if (effect.type === "export.save") {
      const filename = sessionExportFilename(effect.data.info)

      void Promise.try(() => system.save({ name: filename, content: JSON.stringify(effect.data, null, 2) })).then(
        (saved) =>
          dispatchExport({
            type: "export.saved",
            attempt: effect.attempt,
            sessionKey: effect.sessionKey,
            filename,
            saved,
          }),
        (cause: unknown) =>
          dispatchExport({
            type: "export.failed",
            attempt: effect.attempt,
            sessionKey: effect.sessionKey,
            message: cause instanceof Error ? cause.message : undefined,
          }),
      )

      return
    }

    if (effect.type === "export.abort") return exportControllers.get(effect.attempt)?.abort()

    if (effect.type === "toast.exported") {
      return void showToast({
        variant: "success",
        // Solid resolves JSX accessors under the toast's render owner, not this imperative call site.
        icon: () => <Icon name="circle-check" />,
        title: ctx.t("export.success.title"),
        description: ctx.t("export.success.description", { filename: effect.filename }),
      })
    }

    showToast({
      variant: "error",
      title: ctx.t("export.failed.title"),
      description: effect.message ?? ctx.t("export.failed.description"),
    })
  }

  const exportSession = () => {
    if (!props.session.id) return
    dispatchExport({ type: "export.requested", sessionKey: props.session.key, sessionID: props.session.id })
  }

  onCleanup(() => dispatchExport({ type: "disposed" }))

  let scrollState = createContextScrollState()
  let scroller: HTMLDivElement | undefined
  let frame: number | undefined
  // The session the scroll machine last targeted; a switch writes its final offset after props.session moved on.
  let scrollSession: MountedSession | undefined
  const contentChanged: ContextScrollEvent = { type: "content.changed" }
  const interacted: ContextScrollEvent = { type: "interacted" }

  const dispatchScroll = (event: ContextScrollEvent) => {
    const next = transitionContextScroll(scrollState, event)

    scrollState = next.state
    next.effects.forEach(
      (effect) =>
        void Promise.try(() => runScroll(effect)).catch((cause: unknown) => console.error("[context] scroll", cause)),
    )
  }

  const runScroll = (effect: ContextScrollEffect) => {
    if (effect.type === "save.write") {
      const session = props.session.key === effect.sessionKey ? props.session : scrollSession

      if (session?.key === effect.sessionKey) layout.scroll.set(session, "context", effect.position)

      return
    }

    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined

    if (effect.type === "frame.cancel") return

    frame = requestAnimationFrame(() => {
      frame = undefined

      if (effect.kind === "save") return dispatchScroll({ type: "save.flushed", attempt: effect.attempt })

      dispatchScroll({ type: "restore.applied", attempt: effect.attempt, applied: restoreScroll() })
    })
  }

  /** Applies the stored offset, or the top for a session without one, and returns where the scroller moved to. */
  const restoreScroll = () => {
    const el = scroller

    if (!el) return
    const stored = layout.scroll.get(props.session, "context") ?? { x: 0, y: 0 }
    const before = { x: el.scrollLeft, y: el.scrollTop }

    if (el.scrollTop !== stored.y) el.scrollTop = stored.y

    if (el.scrollLeft !== stored.x) el.scrollLeft = stored.x

    if (el.scrollTop === before.y && el.scrollLeft === before.x) return

    return { x: el.scrollLeft, y: el.scrollTop }
  }

  // Follows the routed session and whether its stored layout can be read.
  createKeyed(
    () => ({ session: props.session, active: layout.ready() && props.session.location !== undefined }),
    (target) => {
      dispatchScroll({ type: "target.synced", sessionKey: target.session.key, active: target.active })
      scrollSession = target.session
    },
    { equals: (previous, next) => previous.session.key === next.session.key && previous.active === next.active },
  )

  // New messages grow the content, so a restore clamped by shorter content can now reach its offset.
  createKeyed(
    createMemo(on(messages, (list) => list, { defer: true })),
    () => dispatchScroll(contentChanged),
  )

  // Writes the offset the save frame has not stored yet.
  onCleanup(() => dispatchScroll({ type: "disposed" }))

  return (
    <div
      class="@container h-full overflow-y-auto"
      data-scrollable
      ref={(el) => {
        scroller = el
        // Input of the user's own takes over from restoring, even before it scrolls.
        makeEventListener(el, "wheel", () => dispatchScroll(interacted), { passive: true })
        makeEventListener(el, "pointerdown", () => dispatchScroll(interacted), { passive: true })
        makeEventListener(el, "touchstart", () => dispatchScroll(interacted), { passive: true })
        makeEventListener(el, "keydown", () => dispatchScroll(interacted))
      }}
      onScroll={(event) =>
        dispatchScroll({
          type: "scrolled",
          position: { x: event.currentTarget.scrollLeft, y: event.currentTarget.scrollTop },
        })
      }
    >
      <div data-slot="session-usage-content" class="px-4 pt-4 pb-6 flex flex-col gap-6 md:px-6 md:pb-10 md:gap-10">
        <div class="grid grid-cols-1 @[32rem]:grid-cols-2 gap-4">
          <For each={stats}>{(stat) => <Stat label={ctx.t(stat.label)} value={stat.value()} />}</For>
        </div>

        <WeeklyUsageSection time={formatter().time} />

        <div class="flex flex-col gap-2">
          <div class="flex items-center justify-between">
            <div class="text-12-regular text-text-weak">{ctx.t("rawMessages.title")}</div>
            <Button
              size="small"
              variant="ghost"
              class="gap-1.5 px-2 text-text-weak hover:text-text-base"
              disabled={!props.session.id || exporting()}
              onClick={exportSession}
            >
              <Show when={exporting()} fallback={<Icon name="download" size="small" />}>
                <Loader class="size-4 shrink-0" />
              </Show>
              <span>{ctx.t("export.session")}</span>
            </Button>
          </div>
          <Accordion multiple>
            <For each={rawMessages()}>
              {(message) => (
                <RawMessage message={message} onRendered={() => dispatchScroll(contentChanged)} time={formatter().time} />
              )}
            </For>
          </Accordion>
        </div>
      </div>
    </div>
  )
}

function same<T>(a: readonly T[] | undefined, b: readonly T[] | undefined) {
  if (a === b) return true

  if (!a || !b) return false

  if (a.length !== b.length) return false

  return a.every((x, i) => x === b[i])
}
