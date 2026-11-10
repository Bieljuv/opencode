import { expect } from "bun:test"
import { ai, AIError, LanguageModel, LLMEvent } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols/openai-chat"
import { TestLLM } from "@opencode/ai/testing"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { EventTable } from "@opencode/core/event/sql"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath, RelativePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { FIRST_OUTPUT_TIMEOUT_MS } from "@opencode/core/session/router"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionStep } from "@opencode/core/session/runner/step"
import { SessionMessageTable, SessionTable } from "@opencode/core/session/sql"
import { Snapshot } from "@opencode/core/snapshot"
import { ToolOutput } from "@opencode/core/tool-output"
import { Money } from "@opencode/schema/money"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { asc, eq } from "drizzle-orm"
import { Cause, Clock, Effect, Exit, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { testEffect } from "./lib/effect"
import { advance, drain } from "./lib/clock"

const it = testEffect(
  Layer.merge(
    AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SessionProjector.node, ToolOutput.node]), [
      Bus.node.replace(Bus.configured({ persist: true })),
    ]),
    TestLLM.testLayer(),
  ),
)

for (const fixture of [
  { finish: "stop", toolChoice: undefined },
  { finish: "content-filter", toolChoice: undefined },
  { finish: "stop", toolChoice: "none" },
] as const) {
  it.effect(`settles ${fixture.finish} with tool choice ${fixture.toolChoice ?? "default"}`, () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const llm = yield* TestLLM.Test
      const sessionID = Session.ID.create()
      const assistantMessageID = SessionMessage.ID.create()
      const start = Snapshot.ID.make("before")
      const end = Snapshot.ID.make("after")
      const files = [RelativePath.make("changed.ts")]
      let captures = 0
      let executions = 0
      const steps = yield* SessionStep.make.pipe(
        Effect.provide(
          Layer.mock(Snapshot.Service)({
            capture: () => Effect.sync(() => (captures++ === 0 ? start : end)),
            files: (input) => {
              expect(input).toEqual({ from: start, to: end })
              return Effect.succeed(files)
            },
          }),
        ),
      )
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
      yield* db
        .insert(SessionTable)
        .values({ id: sessionID, project_id: Project.ID.global, slug: "step", directory: "/project", version: "test" })
        .run()
      const model = SessionRunnerModel.resolved(
        LanguageModel.make({ id: "test-model", provider: "test", route: OpenAIChat.route }),
        {
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          limit: { context: 100_000, output: 1_000 },
          cost: [
            {
              input: Money.USDPerMillionTokens.make(1),
              output: Money.USDPerMillionTokens.make(2),
              cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(0.5) },
            },
          ],
        },
      )
      yield* llm.push(
        TestLLM.complete(
          {
            reason: { normalized: fixture.finish },
            usage: {
              inputTokens: 15,
              outputTokens: 6,
              nonCachedInputTokens: 10,
              cacheReadInputTokens: 3,
              cacheWriteInputTokens: 2,
              reasoningTokens: 2,
            },
          },
          LLMEvent.toolCall({ id: "call-test", name: "test", input: {} }),
        ),
      )
      const result = yield* steps
        .attempt({
          isLocationClosed: () => false,
          sessionID,
          assistantMessageID,
          agent: Agent.defaultID,
          model,
          prepared: {
            retry: () => Effect.void,
            request: ai.request({ model: model.model, prompt: "Run one tool", toolChoice: fixture.toolChoice }),
            options: {},
            executeTool: () =>
              Effect.sync(() => {
                executions++
                return { content: [{ type: "text", text: "Completed tool" }] }
              }),
          },
          retry: (_cause, _error, retry) =>
            Effect.succeed(retry ? { retry: true, attempt: 2, delay: 0 } : { retry: false }),
          recoverContinuation: true,
          recoverOverflow: Effect.succeed(false),
        })
        .pipe(Effect.exit)
      expect(Exit.isSuccess(result)).toBe(fixture.finish === "stop")
      expect(executions).toBe(fixture.toolChoice === "none" ? 0 : 1)
      if (Exit.isSuccess(result))
        expect(result.value).toEqual(
          SessionStep.Outcome.Completed({ needsContinuation: fixture.toolChoice !== "none" }),
        )
      expect(yield* llm.requests()).toHaveLength(1)
      expect(captures).toBe(2)
      const message = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, assistantMessageID))
        .get()
      expect(message?.data).toMatchObject({
        finish: fixture.finish,
        tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 2 } },
        snapshot: { start, end, files },
        content: [{ type: "tool", state: { status: fixture.toolChoice === "none" ? "error" : "completed" } }],
      })
      expect(message?.data).toHaveProperty("cost", expect.closeTo(0.0000233, 10))
      const events = yield* db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
      const types = events.map((event) => event.type)
      const terminal = fixture.finish === "stop" ? "session.step.ended.1" : "session.step.failed.1"
      expect(types.filter((type) => type === "session.step.streamed.1")).toHaveLength(1)
      expect(types.filter((type) => type === terminal)).toHaveLength(1)
      expect(types.indexOf("session.step.streamed.1")).toBeLessThan(types.indexOf(terminal))
      expect(
        types.indexOf(fixture.toolChoice === "none" ? "session.tool.failed.2" : "session.tool.success.2"),
      ).toBeLessThan(types.indexOf(terminal))
    }),
  )
}

it.effect("records the cost the endpoint reports instead of the catalog price", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const llm = yield* TestLLM.Test
    const sessionID = Session.ID.create()
    const assistantMessageID = SessionMessage.ID.create()
    const steps = yield* SessionStep.make.pipe(
      Effect.provide(
        Layer.mock(Snapshot.Service)({
          capture: () => Effect.succeed(undefined),
          files: () => Effect.succeed([]),
        }),
      ),
    )
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
    yield* db
      .insert(SessionTable)
      .values({ id: sessionID, project_id: Project.ID.global, slug: "step", directory: "/project", version: "test" })
      .run()
    const model = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "test-model", provider: "test", route: OpenAIChat.route }),
      {
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        limit: { context: 100_000, output: 1_000 },
        cost: [
          {
            input: Money.USDPerMillionTokens.make(1),
            output: Money.USDPerMillionTokens.make(2),
            cache: { read: Money.USDPerMillionTokens.zero, write: Money.USDPerMillionTokens.zero },
          },
        ],
      },
    )
    yield* llm.push(
      TestLLM.complete({
        reason: { normalized: "stop" },
        usage: { inputTokens: 10, outputTokens: 4, nonCachedInputTokens: 10, cost: 0 },
      }),
    )
    yield* steps.attempt({
      isLocationClosed: () => false,
      sessionID,
      assistantMessageID,
      agent: Agent.defaultID,
      model,
      prepared: {
        retry: () => Effect.void,
        request: ai.request({ model: model.model, prompt: "Hello" }),
        options: {},
        executeTool: () => Effect.die("no tools"),
      },
      retry: () => Effect.succeed({ retry: false }),
      recoverContinuation: true,
      recoverOverflow: Effect.succeed(false),
    })

    const message = yield* db
      .select()
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.id, assistantMessageID))
      .get()
    expect(message?.data).toMatchObject({ finish: "stop", cost: 0 })
    expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()).toMatchObject({ cost: 0 })
  }),
)

const setupAttempt = () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const llm = yield* TestLLM.Test
    const sessionID = Session.ID.create()
    const assistantMessageID = SessionMessage.ID.create()
    const steps = yield* SessionStep.make.pipe(
      Effect.provide(
        Layer.mock(Snapshot.Service)({
          capture: () => Effect.succeed(undefined),
          files: () => Effect.succeed([]),
        }),
      ),
    )
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
    yield* db
      .insert(SessionTable)
      .values({ id: sessionID, project_id: Project.ID.global, slug: "step", directory: "/project", version: "test" })
      .run()
    const model = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "test-model", provider: "test", route: OpenAIChat.route }),
      {
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        limit: { context: 100_000, output: 1_000 },
        cost: [
          {
            input: Money.USDPerMillionTokens.make(1),
            output: Money.USDPerMillionTokens.make(2),
            cache: { read: Money.USDPerMillionTokens.zero, write: Money.USDPerMillionTokens.zero },
          },
        ],
      },
    )
    return { llm, sessionID, assistantMessageID, steps, model }
  })

const attemptWithDeadline = (setup: Effect.Success<ReturnType<typeof setupAttempt>>) =>
  setup.steps.attempt({
    isLocationClosed: () => false,
    sessionID: setup.sessionID,
    assistantMessageID: setup.assistantMessageID,
    agent: Agent.defaultID,
    model: setup.model,
    prepared: {
      retry: () => Effect.void,
      request: ai.request({ model: setup.model.model, prompt: "Hello" }),
      options: {},
      executeTool: () => Effect.die("no tools"),
    },
    retry: () => Effect.succeed({ retry: false }),
    recoverContinuation: true,
    recoverOverflow: Effect.succeed(false),
    firstOutputTimeoutMs: FIRST_OUTPUT_TIMEOUT_MS,
  })

it.effect("abandons a frozen model at the first-output deadline", () =>
  Effect.gen(function* () {
    const setup = yield* setupAttempt()
    // No event at all: without the watchdog this attempt would wait out
    // the transport timeouts (5 minutes for headers) instead of failing.
    yield* setup.llm.push(TestLLM.hangAfter())
    const startedAt = yield* Clock.currentTimeMillis
    let outcome: Exit.Exit<SessionStep.Outcome, unknown> | undefined
    yield* attemptWithDeadline(setup).pipe(
      Effect.exit,
      Effect.tap((exit) => Effect.sync(() => { outcome = exit })),
      Effect.forkChild({ startImmediately: true }),
    )
    yield* advance(() => outcome !== undefined)
    const endedAt = yield* Clock.currentTimeMillis
    // Abandoned at the deadline, in seconds — not minutes, and far below
    // the 142.8s a single model held the user in Gabriel's gate test.
    expect(endedAt - startedAt).toBeGreaterThanOrEqual(FIRST_OUTPUT_TIMEOUT_MS)
    expect(endedAt - startedAt).toBeLessThan(FIRST_OUTPUT_TIMEOUT_MS + 5_000)
    expect(outcome).toBeDefined()
    if (outcome === undefined) return
    expect(Exit.isFailure(outcome)).toBe(true)
    if (Exit.isFailure(outcome)) {
      // The attempt fails with the raw timeout error; the runner maps it
      // to provider.timeout and hops to the next model (see the drain
      // test in session-runner.test.ts for the hop and the budget).
      const failure = Cause.squash(outcome.cause)
      expect(failure).toBeInstanceOf(AIError)
      if (failure instanceof AIError) {
        expect(failure.reason._tag).toBe("Timeout")
        if (failure.reason._tag === "Timeout")
          expect(failure.reason.timeoutMs).toBe(FIRST_OUTPUT_TIMEOUT_MS)
      }
    }
  }),
)

it.effect("does not abandon a model that started answering", () =>
  Effect.gen(function* () {
    const setup = yield* setupAttempt()
    // Text started, then the stream hangs: the model is answering, so
    // the watchdog stands down and the attempt keeps waiting for it.
    yield* setup.llm.push(
      TestLLM.hangAfter(LLMEvent.stepStart({ index: 0 }), LLMEvent.textStart({ id: "text-1" })),
    )
    let outcome: Exit.Exit<SessionStep.Outcome, unknown> | undefined
    const fiber = yield* attemptWithDeadline(setup).pipe(
      Effect.exit,
      Effect.tap((exit) => Effect.sync(() => { outcome = exit })),
      Effect.forkChild({ startImmediately: true }),
    )
    yield* setup.llm.wait(1)
    yield* drain
    yield* TestClock.adjust("31 seconds")
    yield* drain
    expect(outcome).toBeUndefined()
    yield* Fiber.interrupt(fiber)
  }),
)

it.effect("a task that answers at once is not slowed by the deadline", () =>
  Effect.gen(function* () {
    const setup = yield* setupAttempt()
    yield* setup.llm.push(TestLLM.text("Hello", "text-1"))
    const result = yield* attemptWithDeadline(setup).pipe(Effect.exit)
    expect(Exit.isSuccess(result)).toBe(true)
    if (Exit.isSuccess(result))
      expect(result.value).toEqual(SessionStep.Outcome.Completed({ needsContinuation: false }))
  }),
)
