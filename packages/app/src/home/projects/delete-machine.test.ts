import { expect, test } from "bun:test"
import {
  createProjectDeleteState,
  selectProjectDeleteView,
  transitionProjectDelete,
  type ProjectDeleteEvent,
  type ProjectDeleteState,
} from "./delete-machine"

const replay = (events: ProjectDeleteEvent[], from = createProjectDeleteState()) =>
  events.reduce((state: ProjectDeleteState, event) => transitionProjectDelete(state, event).state, from)

const target = { projectID: "prj_a", sessionIDs: ["ses_a", "ses_b"] }

test("Delete claims the request at once, so a double click or Cancel waits for it", () => {
  const deleting = transitionProjectDelete(createProjectDeleteState(), { type: "confirm.requested", target })

  expect(deleting.effects).toEqual([
    { type: "delete.run", attempt: 1, target },
    { type: "timer.start", attempt: 1 },
  ])
  expect(selectProjectDeleteView(deleting.state).busy).toBe(true)

  for (const event of [{ type: "confirm.requested", target }, { type: "cancel.requested" }] as const) {
    const next = transitionProjectDelete(deleting.state, event)

    expect(next.state).toBe(deleting.state)
    expect(next.effects).toEqual([])
  }
})

test("a delete that fails or hangs returns to the confirmation", () => {
  const deleting = replay([{ type: "confirm.requested", target }])

  for (const event of [
    { type: "delete.failed", attempt: deleting.attempt, cause: new Error("no") },
    { type: "delete.timed-out", attempt: deleting.attempt },
  ] as const) {
    const next = transitionProjectDelete(deleting, event)

    expect(next.state.status).toBe("confirming")
    expect(selectProjectDeleteView(next.state).busy).toBe(false)
    expect(next.effects).toContainEqual(expect.objectContaining({ type: "toast.delete-failed" }))
  }
})

test("a delete closes the dialog and leaves the project, even when it lands after the dialog went", () => {
  const deleting = replay([{ type: "confirm.requested", target }])

  const done = transitionProjectDelete(deleting, {
    type: "delete.succeeded",
    attempt: deleting.attempt,
    target,
  })

  expect(done.effects).toEqual([
    { type: "timer.cancel" },
    { type: "dialog.close" },
    { type: "project.removed", target },
  ])

  const disposed = transitionProjectDelete(deleting, { type: "disposed" })
  expect(
    transitionProjectDelete(disposed.state, { type: "delete.succeeded", attempt: deleting.attempt, target }).effects,
  ).toEqual([{ type: "project.removed", target }])
})

test("confirming a project that is already gone closes the dialog", () => {
  const next = transitionProjectDelete(createProjectDeleteState(), {
    type: "confirm.requested",
    target: undefined,
  })

  expect(next.state.status).toBe("closed")
  expect(next.effects).toEqual([{ type: "dialog.close" }])
})
