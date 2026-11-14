/** A delete that has not settled by then counts as failed, so the dialog's buttons cannot stay disabled. */
export const PROJECT_DELETE_TIMEOUT_MS = 15_000

/** The delete confirmation for one project, in the project menu: asking, or waiting for the server. */
export type ProjectDeleteState =
  | { readonly status: "confirming"; readonly attempt: number }
  | { readonly status: "deleting"; readonly attempt: number; readonly target: ProjectDeleteTarget }
  | { readonly status: "closed"; readonly attempt: number }
  | { readonly status: "disposed"; readonly attempt: number }

/** Read when the user confirms, before the delete removes the project: the sessions whose tabs close with it. */
export type ProjectDeleteTarget = {
  readonly projectID: string
  readonly sessionIDs: readonly string[]
}

export type ProjectDeleteEvent =
  | { readonly type: "cancel.requested" }
  /** `target`: undefined once the project is gone. */
  | { readonly type: "confirm.requested"; readonly target: ProjectDeleteTarget | undefined }
  | {
      readonly type: "delete.succeeded"
      readonly attempt: number
      readonly target: ProjectDeleteTarget
      /** The original directory, when the trash copy is complete but it could not be removed (locked). */
      readonly leftoverDirectory?: string
    }
  | { readonly type: "delete.failed"; readonly attempt: number; readonly cause: unknown }
  | { readonly type: "delete.timed-out"; readonly attempt: number }
  | { readonly type: "disposed" }

export type ProjectDeleteEffect =
  | {
      readonly type: "delete.run"
      readonly attempt: number
      readonly target: ProjectDeleteTarget
    }
  | { readonly type: "timer.start"; readonly attempt: number }
  | { readonly type: "timer.cancel" }
  | { readonly type: "dialog.close" }
  | { readonly type: "project.removed"; readonly target: ProjectDeleteTarget }
  | { readonly type: "toast.delete-failed"; readonly cause?: unknown }
  /** The project is in the trash but its original directory could not be removed (locked). */
  | { readonly type: "toast.delete-leftover"; readonly directory: string }

export type ProjectDeleteTransition = {
  readonly state: ProjectDeleteState
  readonly effects: readonly ProjectDeleteEffect[]
}

const NO_EFFECTS: readonly never[] = Object.freeze([])

const TIMER_CANCEL: ProjectDeleteEffect = Object.freeze({ type: "timer.cancel" })

const DIALOG_CLOSE: ProjectDeleteEffect = Object.freeze({ type: "dialog.close" })

export function createProjectDeleteState(): ProjectDeleteState {
  return { status: "confirming", attempt: 0 }
}

export function transitionProjectDelete(state: ProjectDeleteState, event: ProjectDeleteEvent): ProjectDeleteTransition {
  if (state.status === "closed" || state.status === "disposed") {
    // The server deleted the project after the dialog went: it still leaves the list and its tabs.
    if (event.type === "delete.succeeded")
      return {
        state,
        effects: [
          { type: "project.removed", target: event.target },
          ...leftoverToast(event.leftoverDirectory),
        ],
      }

    return { state, effects: NO_EFFECTS }
  }

  if (event.type === "disposed")
    return {
      state: { status: "disposed", attempt: state.attempt + 1 },
      effects: state.status === "deleting" ? [TIMER_CANCEL] : NO_EFFECTS,
    }

  if (state.status === "confirming") {
    // A delete that timed out can still land; the project is gone, so the dialog goes too.
    if (event.type === "delete.succeeded") return deleted(state, event.target, event.leftoverDirectory)

    if (event.type === "cancel.requested" || (event.type === "confirm.requested" && !event.target))
      return { state: { ...state, status: "closed", attempt: state.attempt + 1 }, effects: [DIALOG_CLOSE] }

    if (event.type !== "confirm.requested" || !event.target) return { state, effects: NO_EFFECTS }
    const attempt = state.attempt + 1

    return {
      state: { status: "deleting", attempt, target: event.target },
      effects: [
        { type: "delete.run", attempt, target: event.target },
        { type: "timer.start", attempt },
      ],
    }
  }

  // A second click, Enter or Cancel waits for the delete in flight.
  if (event.type !== "delete.succeeded" && event.type !== "delete.failed" && event.type !== "delete.timed-out")
    return { state, effects: NO_EFFECTS }

  if (event.attempt !== state.attempt) return { state, effects: NO_EFFECTS }

  if (event.type === "delete.succeeded") return deleted(state, event.target, event.leftoverDirectory)

  // A failed delete keeps the dialog, so the user can retry or cancel.
  return {
    state: { status: "confirming", attempt: state.attempt + 1 },
    effects: [
      TIMER_CANCEL,
      { type: "toast.delete-failed", cause: event.type === "delete.failed" ? event.cause : undefined },
    ],
  }
}

export function selectProjectDeleteView(state: ProjectDeleteState) {
  return { busy: state.status !== "confirming" }
}

function leftoverToast(leftoverDirectory: string | undefined): readonly ProjectDeleteEffect[] {
  return leftoverDirectory ? [{ type: "toast.delete-leftover", directory: leftoverDirectory }] : NO_EFFECTS
}

function deleted(
  state: Extract<ProjectDeleteState, { status: "confirming" | "deleting" }>,
  target: ProjectDeleteTarget,
  leftoverDirectory?: string,
): ProjectDeleteTransition {
  return {
    state: { status: "closed", attempt: state.attempt + 1 },
    effects: [
      ...(state.status === "deleting" ? [TIMER_CANCEL] : []),
      DIALOG_CLOSE,
      { type: "project.removed", target },
      ...leftoverToast(leftoverDirectory),
    ],
  }
}
