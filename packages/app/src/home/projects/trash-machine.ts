/** A trash request that has not settled by then counts as failed, so the dialog's buttons cannot stay disabled. */
export const PROJECT_TRASH_TIMEOUT_MS = 15_000

/** One trashed project as the server lists it: the folder itself stays server-side. */
export type ProjectTrashItem = {
  readonly id: string
  readonly name?: string
  readonly directory: string
  readonly trashedAt: number
}

/** The trash dialog for one server: loading the list, browsing it, restoring one project, or emptying it. */
export type ProjectTrashState =
  | { readonly status: "loading"; readonly attempt: number }
  | {
      readonly status: "ready"
      readonly attempt: number
      readonly items: readonly ProjectTrashItem[]
      readonly confirmingEmpty: boolean
    }
  | {
      readonly status: "restoring"
      readonly attempt: number
      readonly items: readonly ProjectTrashItem[]
      readonly projectID: string
    }
  | { readonly status: "emptying"; readonly attempt: number; readonly items: readonly ProjectTrashItem[] }
  | { readonly status: "closed"; readonly attempt: number }
  | { readonly status: "disposed"; readonly attempt: number }

export type ProjectTrashEvent =
  | { readonly type: "load.requested" }
  | { readonly type: "load.succeeded"; readonly attempt: number; readonly items: readonly ProjectTrashItem[] }
  | { readonly type: "load.failed"; readonly attempt: number; readonly cause: unknown }
  | { readonly type: "load.timed-out"; readonly attempt: number }
  | { readonly type: "restore.requested"; readonly projectID: string }
  | { readonly type: "restore.succeeded"; readonly attempt: number; readonly projectID: string }
  | { readonly type: "restore.failed"; readonly attempt: number; readonly cause: unknown }
  | { readonly type: "restore.timed-out"; readonly attempt: number }
  | { readonly type: "empty.requested" }
  | { readonly type: "empty.cancel.requested" }
  | { readonly type: "empty.confirmed" }
  | { readonly type: "empty.succeeded"; readonly attempt: number }
  | { readonly type: "empty.failed"; readonly attempt: number; readonly cause: unknown }
  | { readonly type: "empty.timed-out"; readonly attempt: number }
  | { readonly type: "close.requested" }
  | { readonly type: "disposed" }

export type ProjectTrashEffect =
  | { readonly type: "trash.load"; readonly attempt: number }
  | { readonly type: "trash.restore"; readonly attempt: number; readonly projectID: string }
  | { readonly type: "trash.empty"; readonly attempt: number }
  | { readonly type: "timer.start"; readonly attempt: number }
  | { readonly type: "timer.cancel" }
  | { readonly type: "dialog.close" }
  | { readonly type: "toast.load-failed"; readonly cause?: unknown }
  | { readonly type: "toast.restore-failed"; readonly cause?: unknown }
  | { readonly type: "toast.empty-failed"; readonly cause?: unknown }

export type ProjectTrashTransition = {
  readonly state: ProjectTrashState
  readonly effects: readonly ProjectTrashEffect[]
}

const NO_EFFECTS: readonly never[] = Object.freeze([])

const TIMER_CANCEL: ProjectTrashEffect = Object.freeze({ type: "timer.cancel" })

const DIALOG_CLOSE: ProjectTrashEffect = Object.freeze({ type: "dialog.close" })

export function createProjectTrashState(): ProjectTrashState {
  return { status: "loading", attempt: 0 }
}

export function transitionProjectTrash(state: ProjectTrashState, event: ProjectTrashEvent): ProjectTrashTransition {
  if (state.status === "closed" || state.status === "disposed") return { state, effects: NO_EFFECTS }

  if (event.type === "disposed")
    return {
      state: { status: "disposed", attempt: state.attempt + 1 },
      effects: state.status === "loading" || state.status === "restoring" || state.status === "emptying" ? [TIMER_CANCEL] : NO_EFFECTS,
    }

  if (state.status === "loading") {
    if (event.type === "load.requested") {
      const attempt = state.attempt + 1

      return {
        state: { status: "loading", attempt },
        effects: [
          { type: "trash.load", attempt },
          { type: "timer.start", attempt },
        ],
      }
    }

    if (event.type === "close.requested")
      return { state: { status: "closed", attempt: state.attempt + 1 }, effects: [TIMER_CANCEL, DIALOG_CLOSE] }

    if (event.type !== "load.succeeded" && event.type !== "load.failed" && event.type !== "load.timed-out")
      return { state, effects: NO_EFFECTS }

    if (event.attempt !== state.attempt) return { state, effects: NO_EFFECTS }

    if (event.type === "load.succeeded")
      return {
        state: { status: "ready", attempt: state.attempt, items: event.items, confirmingEmpty: false },
        effects: [TIMER_CANCEL],
      }

    // A load that fails or hangs closes the dialog; reopening it retries.
    return {
      state: { status: "closed", attempt: state.attempt + 1 },
      effects: [
        TIMER_CANCEL,
        DIALOG_CLOSE,
        { type: "toast.load-failed", cause: event.type === "load.failed" ? event.cause : undefined },
      ],
    }
  }

  if (state.status === "ready") {
    if (event.type === "close.requested")
      return { state: { status: "closed", attempt: state.attempt + 1 }, effects: [DIALOG_CLOSE] }

    if (event.type === "empty.requested") {
      if (state.items.length === 0 || state.confirmingEmpty) return { state, effects: NO_EFFECTS }

      return {
        state: { ...state, confirmingEmpty: true },
        effects: NO_EFFECTS,
      }
    }

    if (event.type === "empty.cancel.requested") {
      if (!state.confirmingEmpty) return { state, effects: NO_EFFECTS }

      return {
        state: { ...state, confirmingEmpty: false },
        effects: NO_EFFECTS,
      }
    }

    if (event.type === "empty.confirmed") {
      if (!state.confirmingEmpty) return { state, effects: NO_EFFECTS }
      const attempt = state.attempt + 1

      return {
        state: { status: "emptying", attempt, items: state.items },
        effects: [
          { type: "trash.empty", attempt },
          { type: "timer.start", attempt },
        ],
      }
    }

    if (event.type !== "restore.requested") return { state, effects: NO_EFFECTS }

    const attempt = state.attempt + 1

    return {
      state: { status: "restoring", attempt, items: state.items, projectID: event.projectID },
      effects: [
        { type: "trash.restore", attempt, projectID: event.projectID },
        { type: "timer.start", attempt },
      ],
    }
  }

  // A second click, Enter or Cancel waits for the restore or empty in flight.
  if (event.type !== "restore.succeeded" && event.type !== "restore.failed" && event.type !== "restore.timed-out" && event.type !== "empty.succeeded" && event.type !== "empty.failed" && event.type !== "empty.timed-out")
    return { state, effects: NO_EFFECTS }

  if (event.attempt !== state.attempt) return { state, effects: NO_EFFECTS }

  if (event.type === "restore.succeeded" || event.type === "empty.succeeded") {
    // Reload the list: the restored project left the trash, or the trash is empty now.
    const attempt = state.attempt + 1

    return {
      state: { status: "loading", attempt },
      effects: [
        TIMER_CANCEL,
        { type: "trash.load", attempt },
        { type: "timer.start", attempt },
      ],
    }
  }

  return {
    state: { status: "ready", attempt: state.attempt + 1, items: state.items, confirmingEmpty: false },
    effects: [
      TIMER_CANCEL,
      event.type === "restore.failed" || event.type === "restore.timed-out"
        ? { type: "toast.restore-failed", cause: event.type === "restore.failed" ? event.cause : undefined }
        : { type: "toast.empty-failed", cause: event.type === "empty.failed" ? event.cause : undefined },
    ],
  }
}

export function selectProjectTrashView(state: ProjectTrashState) {
  return {
    busy: state.status === "loading" || state.status === "restoring" || state.status === "emptying",
    loading: state.status === "loading",
    // The dialog can close while loading (the load timeout is only a fallback); a restore or empty in flight
    // waits, like the delete dialog.
    canClose: state.status !== "restoring" && state.status !== "emptying",
    items: state.status === "ready" || state.status === "restoring" || state.status === "emptying" ? state.items : [],
    confirmingEmpty: state.status === "ready" && state.confirmingEmpty,
    restoringID: state.status === "restoring" ? state.projectID : undefined,
  }
}
