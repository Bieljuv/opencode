import { expect, test } from "bun:test"
import {
  createProjectTrashState,
  selectProjectTrashView,
  transitionProjectTrash,
  type ProjectTrashEvent,
  type ProjectTrashItem,
  type ProjectTrashState,
} from "./trash-machine"

const replay = (events: ProjectTrashEvent[], from = createProjectTrashState()) =>
  events.reduce((state: ProjectTrashState, event) => transitionProjectTrash(state, event).state, from)

const items: ProjectTrashItem[] = [
  { id: "prj_a", name: "Alpha", directory: "/work/alpha", trashedAt: 100 },
  { id: "prj_b", directory: "/work/beta", trashedAt: 90 },
]

const ready = () =>
  replay([
    { type: "load.requested" },
    { type: "load.succeeded", attempt: 1, items },
  ])

test("Trash loads the list on open and shows it", () => {
  const loading = transitionProjectTrash(createProjectTrashState(), { type: "load.requested" })

  expect(loading.effects).toEqual([
    { type: "trash.load", attempt: 1 },
    { type: "timer.start", attempt: 1 },
  ])

  const next = transitionProjectTrash(loading.state, { type: "load.succeeded", attempt: 1, items })

  expect(next.state.status).toBe("ready")
  expect(selectProjectTrashView(next.state).items).toEqual(items)
  expect(selectProjectTrashView(next.state).busy).toBe(false)
  expect(next.effects).toEqual([{ type: "timer.cancel" }])
})

test("a load that fails or hangs closes the dialog with a toast", () => {
  const loading = replay([{ type: "load.requested" }])

  for (const event of [
    { type: "load.failed", attempt: loading.attempt, cause: new Error("no") },
    { type: "load.timed-out", attempt: loading.attempt },
  ] as const) {
    const next = transitionProjectTrash(loading, event)

    expect(next.state.status).toBe("closed")
    expect(next.effects).toContainEqual(expect.objectContaining({ type: "toast.load-failed" }))
    expect(next.effects).toContainEqual({ type: "dialog.close" })
  }
})

test("a stale load result is ignored", () => {
  const loading = replay([{ type: "load.requested" }])

  const next = transitionProjectTrash(loading, { type: "load.succeeded", attempt: loading.attempt + 1, items })

  expect(next.state).toBe(loading)
  expect(next.effects).toEqual([])
})

test("Restore claims the request at once, so a second click waits for it", () => {
  const restoring = transitionProjectTrash(ready(), { type: "restore.requested", projectID: "prj_a" })

  expect(restoring.effects).toEqual([
    { type: "trash.restore", attempt: 2, projectID: "prj_a" },
    { type: "timer.start", attempt: 2 },
  ])
  expect(selectProjectTrashView(restoring.state).restoringID).toBe("prj_a")

  for (const event of [
    { type: "restore.requested", projectID: "prj_b" },
    { type: "empty.requested" },
    { type: "close.requested" },
  ] as const) {
    const next = transitionProjectTrash(restoring.state, event)

    expect(next.state).toBe(restoring.state)
    expect(next.effects).toEqual([])
  }
})

test("a restore that lands reloads the list", () => {
  const restoring = replay([{ type: "load.requested" }, { type: "load.succeeded", attempt: 1, items }, { type: "restore.requested", projectID: "prj_a" }])

  const next = transitionProjectTrash(restoring, {
    type: "restore.succeeded",
    attempt: restoring.attempt,
    projectID: "prj_a",
  })

  expect(next.state.status).toBe("loading")
  expect(next.effects).toContainEqual({ type: "trash.load", attempt: restoring.attempt + 1 })

  const reloaded = transitionProjectTrash(next.state, {
    type: "load.succeeded",
    attempt: restoring.attempt + 1,
    items: items.slice(1),
  })

  expect(reloaded.state.status).toBe("ready")
  expect(selectProjectTrashView(reloaded.state).items).toEqual(items.slice(1))
})

test("a restore that fails or hangs returns to the list with a toast", () => {
  const restoring = replay([{ type: "load.requested" }, { type: "load.succeeded", attempt: 1, items }, { type: "restore.requested", projectID: "prj_a" }])

  for (const event of [
    { type: "restore.failed", attempt: restoring.attempt, cause: new Error("no") },
    { type: "restore.timed-out", attempt: restoring.attempt },
  ] as const) {
    const next = transitionProjectTrash(restoring, event)

    expect(next.state.status).toBe("ready")
    expect(selectProjectTrashView(next.state).items).toEqual(items)
    expect(next.effects).toContainEqual(expect.objectContaining({ type: "toast.restore-failed" }))
  }
})

test("Empty asks first, then empties and reloads", () => {
  const asking = transitionProjectTrash(ready(), { type: "empty.requested" })

  expect(asking.state.status).toBe("ready")
  expect(selectProjectTrashView(asking.state).confirmingEmpty).toBe(true)

  const cancelled = transitionProjectTrash(asking.state, { type: "empty.cancel.requested" })

  expect(selectProjectTrashView(cancelled.state).confirmingEmpty).toBe(false)

  const emptying = transitionProjectTrash(
    transitionProjectTrash(cancelled.state, { type: "empty.requested" }).state,
    { type: "empty.confirmed" },
  )

  expect(emptying.state.status).toBe("emptying")
  expect(emptying.effects).toContainEqual({ type: "trash.empty", attempt: emptying.state.attempt })

  const done = transitionProjectTrash(emptying.state, { type: "empty.succeeded", attempt: emptying.state.attempt })

  expect(done.state.status).toBe("loading")
  expect(done.effects).toContainEqual({ type: "trash.load", attempt: emptying.state.attempt + 1 })
})

test("Empty with no projects does nothing, and a failed empty returns to the list", () => {
  const empty = replay([
    { type: "load.requested" },
    { type: "load.succeeded", attempt: 1, items: [] },
  ])

  const asked = transitionProjectTrash(empty, { type: "empty.requested" })

  expect(asked.state).toBe(empty)
  expect(asked.effects).toEqual([])

  const emptying = transitionProjectTrash(
    transitionProjectTrash(ready(), { type: "empty.requested" }).state,
    { type: "empty.confirmed" },
  )

  for (const event of [
    { type: "empty.failed", attempt: emptying.state.attempt, cause: new Error("no") },
    { type: "empty.timed-out", attempt: emptying.state.attempt },
  ] as const) {
    const next = transitionProjectTrash(emptying.state, event)

    expect(next.state.status).toBe("ready")
    expect(next.effects).toContainEqual(expect.objectContaining({ type: "toast.empty-failed" }))
  }
})

test("a stale restore result is ignored", () => {
  const restoring = replay([{ type: "load.requested" }, { type: "load.succeeded", attempt: 1, items }, { type: "restore.requested", projectID: "prj_a" }])

  const next = transitionProjectTrash(restoring, {
    type: "restore.succeeded",
    attempt: restoring.attempt + 1,
    projectID: "prj_a",
  })

  expect(next.state).toBe(restoring)
  expect(next.effects).toEqual([])
})
