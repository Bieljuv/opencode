export * as SessionRunnerLLM from "./llm.js"

import { Message } from "@opencode/ai/effect"
import { and, desc, eq, inArray, sql } from "drizzle-orm"
import { Cause, Clock, Effect, Exit, FiberMap, Layer } from "effect"
import { Database } from "../../database/database.js"
import { Model } from "../../model.js"
import { Bus } from "../../bus.js"
import { LocationLifecycle } from "../../location-lifecycle.js"
import { InstructionState } from "../instruction-state.js"
import { SessionCompaction } from "../compaction.js"
import { SessionContext } from "../context.js"
import { SessionEvent } from "../event.js"
import { SessionInbox } from "../inbox.js"
import { SessionBackground } from "../background.js"
import { Job } from "../../job.js"
import { SessionHistory } from "../history.js"
import { SessionHistoryPackage } from "../history-package.js"
import { SessionModelRequest } from "../model-request.js"
import { SessionRouter } from "../router.js"
import { SessionModelTransport } from "../model-transport.js"
import { SessionMessage } from "../message.js"
import { SessionSchema } from "../schema.js"
import { SessionStore } from "../store.js"
import { SessionMessageTable } from "../sql.js"
import { SessionTitle } from "../title.js"
import { toSessionError } from "../to-session-error.js"
import { DrainResult, Service, type Interface } from "./index.js"
import { Snapshot } from "../../snapshot.js"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { llmClient } from "../../effect/app-node-platform.js"
import { StepFailedError } from "../error.js"
import { SessionRunnerRetry } from "./retry.js"
import { SessionStep } from "./step.js"
import { ToolOutput } from "../../tool-output.js"
import { Plugin } from "../../plugin.js"
import { PluginHooks } from "../../plugin/hooks.js"
import { MAX_STEPS_PROMPT, resolveStepLimit } from "./max-steps.js"

const CONTINUE_AFTER_INCOMPLETE_STREAM =
  "The previous response was interrupted. Continue from where you left off without repeating completed content."

const CONTINUE_AFTER_OUTPUT_LIMIT =
  "Your last response hit the output token limit (stop reason: length). Do not apologize, recap, or repeat yourself. Break the remaining work into smaller pieces."

type DrainInput = Parameters<Interface["drain"]>[0]

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const lifecycle = yield* LocationLifecycle.Service
    const store = yield* SessionStore.Service
    const context = yield* SessionContext.Service
    const models = yield* Model.Service
    const modelTransport = yield* SessionModelTransport.Service
    const db = (yield* Database.Service).db
    const compaction = yield* SessionCompaction.Service
    const plugins = yield* Plugin.Service
    const hooks = yield* PluginHooks.Service
    const jobs = yield* Job.Service
    const title = yield* SessionTitle.Service
    const steps = yield* SessionStep.make
    // Title generation starts once input is visible and must not delay model execution.
    const titles = yield* FiberMap.make<SessionSchema.ID, void, never>()

    // Each drain is one turn and starts its own trace, whatever fiber woke it.
    const drain = Effect.fn("SessionRunner.drain", { root: true })(function* (input: DrainInput) {
      const sessionID = input.sessionID
      let force = input.force
      let continuing = input.continuation !== undefined
      let step = input.continuation?.step ?? 1
      let entering = true
      let stepped = input.stepped ?? false
      const promotable = input.promotable ?? "input"
      if (!force && !continuing && !stepped) {
        const pending = yield* SessionInbox.nextPromotable(db, sessionID, "input")
        if (!pending) return DrainResult.Complete()
        const control = pending.type === "compaction" || pending.type === "move"
        if (promotable === "steer" && pending.delivery === "queue" && !control) return DrainResult.Complete()
      }
      yield* plugins.awaitActivation
      yield* settleStaleCompactions(sessionID)
      yield* settleStaleToolCalls(sessionID)

      const advanceToStep = Effect.fn("SessionRunner.advanceToStep")(() =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            while (true) {
              if (lifecycle.isClosed()) {
                yield* restore(modelTransport.close(sessionID))
                return DrainResult.Reloaded({
                  force,
                  continuation: continuing ? { step } : undefined,
                  stepped: !continuing && stepped ? true : undefined,
                })
              }
              // Location entry and idle boundaries allow queued controls, not necessarily queued prompts.
              const pending = yield* SessionInbox.serialized(
                sessionID,
                Effect.gen(function* () {
                  const next = yield* SessionInbox.nextPromotable(
                    db,
                    sessionID,
                    entering || !continuing ? "input" : "steer",
                  )
                  if (next?.type === "compaction")
                    yield* bus.publishAll([
                      [SessionEvent.InboxDelivered, { sessionID, inboxID: next.id }],
                      [SessionEvent.Compaction.Started, { sessionID, reason: "manual", inputID: next.id }],
                    ])
                  if (next?.type === "move")
                    yield* restore(
                      Effect.gen(function* () {
                        yield* modelTransport.close(sessionID)
                        yield* bus.publishAll([
                          [SessionEvent.InboxDelivered, { sessionID, inboxID: next.id }],
                          [SessionEvent.Moved, { sessionID, ...next.payload }],
                        ])
                      }),
                    )
                  return next
                }),
              )
              if (!continuing && pending?.delivery !== "steer") {
                entering = true
                step = 1
              }
              if (pending?.type === "move")
                return DrainResult.Moved({
                  continuation: continuing ? { step } : undefined,
                  stepped: !continuing && stepped ? true : undefined,
                })
              if (pending?.type === "compaction") {
                const compacted = yield* restore(
                  Effect.gen(function* () {
                    yield* plugins.awaitActivation
                    const selected = yield* context.select(sessionID)
                    const model = yield* context.resolveModel(selected.session)
                    // Preview updates without admitting them after the already-delivered compaction marker.
                    const history = yield* SessionHistory.preview(db, sessionID, selected.instructions, model.ref)
                    return yield* compaction.compact({
                      reason: "manual",
                      inputID: pending.id,
                      context: {
                        session: selected.session,
                        agent: selected.agent,
                        tools: selected.tools,
                        model,
                        initial: history.initial,
                        messages: history.messages,
                      },
                    })
                  }).pipe(
                    Effect.catch((error) =>
                      bus.publish(SessionEvent.Compaction.Failed, {
                        sessionID,
                        reason: "manual",
                        inputID: pending.id,
                        error: toSessionError(error),
                      }),
                    ),
                  ),
                ).pipe(Effect.exit)
                if (Exit.isFailure(compacted)) {
                  yield* bus.publish(SessionEvent.Compaction.Failed, {
                    sessionID,
                    reason: "manual",
                    error: Cause.hasInterruptsOnly(compacted.cause)
                      ? { type: "aborted", message: "Compaction cancelled" }
                      : { type: "compaction.failed", message: Cause.pretty(compacted.cause) },
                    inputID: pending.id,
                  })
                  return yield* Effect.failCause(compacted.cause)
                }
                force = false
                continue
              }
              if (!force && !continuing && (!pending || (pending.delivery === "queue" && promotable === "steer"))) {
                // Control-only drains such as a manual compaction never ran the model, so they skip the hook.
                if (pending || !stepped) return DrainResult.Complete()
                // The Session would go idle; a plugin may admit input to keep this execution working.
                yield* restore(
                  SessionBackground.outstanding(jobs, store, sessionID).pipe(
                    Effect.flatMap((background) => hooks.trigger("session", "experimental.idle", { sessionID, background })),
                  ),
                )
                if (!(yield* SessionInbox.has(db, sessionID, "input"))) return DrainResult.Complete()
                continue
              }
              const ready = yield* restore(
                Effect.gen(function* () {
                  const selected = yield* prepareContext(sessionID)
                  const promoted = yield* SessionInbox.promote(
                    db,
                    bus,
                    sessionID,
                    entering && !continuing ? promotable : "steer",
                  )
                  // A control admitted during context preparation owns this boundary.
                  if (promoted === undefined) return undefined
                  if (promoted > 0 && !selected.session.parentID && SessionTitle.isUntitled(selected.session))
                    yield* FiberMap.run(titles, sessionID, title.generate(sessionID), {
                      onlyIfMissing: true,
                    })
                  if (promoted > 0) step = 1
                  return { _tag: "Ready" as const, context: yield* context.load(selected) }
                }),
              )
              if (ready) return ready
            }
          }),
        ),
      )

      while (true) {
        const next = yield* advanceToStep()
        if (next._tag !== "Ready") return next
        continuing = yield* runStep(next.context, step)
        stepped = true
        step++
        force = false
        entering = false
      }
    })

    const prepareContext = Effect.fn("SessionRunner.prepareContext")(function* (sessionID: SessionSchema.ID) {
      // Plugins can reload mid-turn; each step and retry must read the settled agents, models and skills.
      yield* plugins.awaitActivation
      const selected = yield* context.select(sessionID)
      // A blocked initial instruction baseline must leave admitted input pending.
      yield* InstructionState.prepare(db, bus, selected.instructions, sessionID)
      return selected
    })

    /** Owns logical Step policy; each attempt owns its streaming, tools, and durable settlement. */
    const runStep = Effect.fn("SessionRunner.runStep")(function* (first: SessionContext.Loaded, step: number) {
      const sessionID = first.session.id
      let assistantMessageID = SessionMessage.ID.create()
      const retry = yield* SessionRunnerRetry.make(bus, sessionID)
      let initial: SessionContext.Loaded | undefined = first
      let recoverOverflow = true
      let recoverContinuation = true
      let retryAttempt: number | undefined
      // The cascade budget: a step that produced no output within it gives
      // up with the generic message instead of hopping through frozen
      // models forever. Output already started means the user is seeing
      // progress, so the budget only bounds total silence.
      const stepStartedAt = yield* Clock.currentTimeMillis
      let outputStarted = false
      // ManosTech router: the hop chain for this step, from the providers
      // connected right now. Only models that actually fail in this step
      // count as tried: the session model just answered the previous step,
      // so it is a valid hop target. Pre-seeding it here once made a step
      // fail with the chain "exhausted" while the only working model sat
      // unused.
      const available = yield* models.available()
      const configured = yield* models.configuredDefault()
      const lastUser = [...first.messages]
        .reverse()
        .find((message): message is SessionMessage.User => message.type === "user")
      const effort =
        lastUser?.metadata !== undefined
          ? SessionRouter.effortFromMetadata(lastUser.metadata)
          : SessionRouter.effortFromVariant(first.model.ref.variant)
      // ManosTech multi-agent: the composer's toggle for this turn, carried
      // in the same prompt metadata as the effort. On by default: a prompt
      // without the metadata — CLI, ACP, schedules, child sessions — runs
      // multi-agent, and only an explicit false turns it off.
      const multiAgent = SessionRouter.multiAgentFromMetadata(lastUser?.metadata)
      const explicit = configured !== undefined || first.agent.info.model !== undefined
      const complexity = SessionRouter.classifyComplexity(lastUser?.text ?? "")
      // The chain only carries models that fit this turn's real prompt:
      // a model that answered a small probe can still freeze on the real
      // request, so the size used here is the packed turn, never a probe.
      const promptTokens = SessionCompaction.estimateContext(first)
      // Every step rotates the starting free model past the one that
      // answered the previous step, so a long task spreads across the
      // free pool instead of draining a single model to its free limit:
      // the chain is rebuilt per step, and the free run starts after
      // the session model. An explicit model never rotates.
      const rotateAfter = !explicit ? first.session.model : undefined
      const chain = SessionRouter.buildChain(available, {
        complexity,
        effort,
        promptTokens,
        rotateAfter,
      })
      const tried = new Set<string>()
      // Providers killed for this step: a model that fails with a dead
      // key or an empty quota condemns its whole provider, not just
      // itself — every other model of that provider would fail the same
      // way, so the hop skips them all instead of burning the cascade
      // budget ping-ponging between dead providers.
      const deadProviders = new Set<string>()
      // Fall back to the session model once per step: when the chain is
      // exhausted, the session keeps the model it was on instead of dying.
      // The switch is published like any hop, so the loop below
      // re-resolves the new model; the user never sees the change.
      let sessionFallbackUsed = false
      const fallbackToSessionModel = (currentRef: Model.Ref) =>
        Effect.gen(function* () {
          const target = SessionRouter.sessionFallback(first.session.model, currentRef, sessionFallbackUsed)
          if (target === undefined) return false
          sessionFallbackUsed = true
          tried.add(SessionRouter.refKey(target))
          yield* Effect.logInfo("manostech router fallback to session model", {
            sessionID,
            from: SessionRouter.refKey(currentRef),
            to: SessionRouter.refKey(target),
            tried: tried.size,
            chain: chain.length,
          })
          yield* bus.publish(SessionEvent.ModelSelected, {
            sessionID,
            model: target,
            previous: currentRef,
          })
          return true
        })
      // Diagnostic log only, never the screen: the next failure has to
      // show whether the chain was born short (providers connected but
      // absent from `available()`, gateway credential not connected) or
      // long and exhausted one model at a time.
      yield* Effect.logInfo("manostech router chain", {
        sessionID,
        available: available.length,
        chain: chain.length,
        promptTokens,
        sessionModel:
          first.session.model === undefined ? undefined : SessionRouter.refKey(first.session.model),
        complexity,
        effort,
        multiAgent,
        explicit,
      })
      if (!explicit && !SessionRouter.isGatewayModel(first.session.model)) {
        // The chain head answers this step unless it is already the session
        // model. The switch is published, so the loop below re-resolves the
        // new model; the user never sees the change. A head that is already
        // the session model needs no switch and no context reload. On a
        // continuation step the head is the next free model after the
        // session model when the turn runs on a free model, so rotation
        // keeps moving mid-task; a turn on a paid model keeps its model
        // (see stepHead). A session on the gateway keeps its model too:
        // the gateway is the automatic mode, not a free model to rotate
        // away from, and leaving it would bypass the panel.
        const sessionModel = first.session.model
        const sessionModelFree =
          sessionModel !== undefined &&
          available.some(
            (model) =>
              SessionRouter.isFreeModel(model) &&
              SessionRouter.refKey(model) === SessionRouter.refKey(sessionModel),
          )
        const head = SessionRouter.stepHead(chain, tried, first.session.model, step === 1, sessionModelFree)
        if (head !== undefined) {
          tried.add(SessionRouter.refKey(head))
          if (
            first.session.model === undefined ||
            SessionRouter.refKey(head) !== SessionRouter.refKey(first.session.model)
          ) {
            yield* bus.publish(SessionEvent.ModelSelected, {
              sessionID,
              model: head,
              previous: first.session.model,
            })
            initial = undefined
          }
        }
      }
      while (true) {
        const now = yield* Clock.currentTimeMillis
        if (SessionRouter.cascadeBudgetSpent(stepStartedAt, now, outputStarted))
          return yield* new StepFailedError({ error: SessionRouter.CASCADE_EXHAUSTED })
        // Reuse boundary preparation once; retries refresh context without delivering more input.
        const loaded = initial ?? (yield* prepareContext(sessionID).pipe(Effect.flatMap(context.load)))
        initial = undefined
        const estimate = SessionCompaction.estimatePrompt(loaded)
        const compacted = yield* compaction.compact({ reason: "auto", context: loaded, estimate })
        if (compacted.status === "failed") {
          // A compaction that fails because its model is down must not
          // kill the step: the compaction model is a model like any
          // other, so a hop-signal failure hops to the next model in the
          // chain and the step retries with it — the same hop the step's
          // own model call makes. Only a failure that is not a hop
          // signal (the compaction itself cannot run) still fails the
          // step, and only after the chain and the session model are
          // exhausted does the step fail — with the generic message,
          // never the provider's own error.
          if (!SessionRouter.isHopSignal(compacted.error))
            return yield* new StepFailedError({ error: compacted.error })
          if (SessionRouter.isProviderDead(compacted.error))
            deadProviders.add(loaded.model.ref.providerID)
          const next = SessionRouter.nextHopFor(
            chain,
            tried,
            available,
            compacted.error,
            loaded.model,
            deadProviders,
          )
          if (next !== undefined) {
            tried.add(SessionRouter.refKey(next))
            yield* Effect.logInfo("manostech router hop", {
              sessionID,
              from: SessionRouter.refKey(loaded.model.ref),
              to: SessionRouter.refKey(next),
              errorType: compacted.error.type,
              errorStatus: compacted.error.status,
              tried: tried.size,
              chain: chain.length,
            })
            yield* bus.publish(SessionEvent.ModelSelected, {
              sessionID,
              model: next,
              previous: loaded.session.model,
            })
            continue
          }
          if (yield* fallbackToSessionModel(loaded.model.ref)) continue
          return yield* new StepFailedError({ error: SessionRouter.CASCADE_EXHAUSTED })
        }
        if (compacted.status === "completed") {
          assistantMessageID = SessionMessage.ID.create()
          continue
        }
        yield* compaction.precompute(Effect.succeed(loaded), estimate)
        // ManosTech: the cap always applies — an agent without an explicit
        // `steps` value resolves to the shared default (audit C-04).
        const stepLimitReached = step >= resolveStepLimit(loaded.agent.info)
        const transcript = SessionModelRequest.baseTranscript({
          agent: loaded.agent.info,
          model: loaded.model,
          tools: loaded.tools,
          initial: loaded.initial,
          multiAgent,
          // ManosTech history packaging: the turn only resends the last 20
          // messages plus a condensed summary of the rest, so a long
          // conversation stops re-sending its whole context on every turn.
          // The full history stays in the session; only the request is packed.
          messages: SessionHistoryPackage.packageHistory(loaded.messages),
        })
        const prepared = yield* context.request
          .primary({
            session: loaded.session,
            agent: loaded.agent.id,
            model: loaded.model,
            tools: loaded.tools,
            system: transcript.system,
            messages: stepLimitReached
              ? [...transcript.messages, Message.assistant(MAX_STEPS_PROMPT)]
              : transcript.messages,
            // Keep tool definitions on the final Step to preserve the provider's cached prefix.
            toolChoice: stepLimitReached ? "none" : undefined,
            webSocket: "session",
            inputTokens: estimate,
            // Gateway mode: the classified complexity rides to the server
            // on the primary request, so a complex turn routes to the
            // gateway's paid head first instead of entering as "simples".
            complexity,
          })
          .pipe(
            // The hook event holds every message from before images are bounded, screenshots included, and is a separate
            // copy once a plugin hook has rewritten it. The step and its tool callbacks live as long as the slowest tool,
            // so they keep only what they use.
            Effect.map((prepared) => ({
              request: prepared.request,
              options: prepared.options,
              retry: prepared.retry,
              executeTool: prepared.executeTool,
            })),
          )
        const outcome = yield* steps.attempt({
          isLocationClosed: lifecycle.isClosed,
          sessionID,
          assistantMessageID,
          agent: loaded.agent.id,
          model: loaded.model,
          prepared: {
            ...prepared,
            // A tool call can arrive during a reload; its permission check reads the session's agent.
            executeTool: (call) => plugins.awaitActivation.pipe(Effect.andThen(prepared.executeTool(call))),
          },
          retryAttempt,
          firstOutputTimeoutMs: SessionRouter.FIRST_OUTPUT_TIMEOUT_MS,
          retry: (cause, error, proposed) =>
            Effect.gen(function* () {
              // ManosTech router: on exhausted credit, hop to the next
              // connected model instead of failing the turn. A plain
              // throttle hops too — a 429 is a per-model or per-account
              // cap, and another provider answers now while the same
              // model would burn its backoff retries and die with the
              // throttle message. A model that freezes or fails mid-task
              // (timeout, provider failure, broken reply) hops the same
              // way: it cannot carry this task, so the next capable model
              // tries instead of retrying the same one until the turn
              // dies. An authentication failure hops the same way: the
              // credential is per provider, so a dead key on one provider
              // must not condemn the models of the others, and the hop
              // prefers a different provider. A prompt the model cannot
              // hold hops to a bigger window, never to a smaller one. The
              // switch is published as ModelSelected, so the retry
              // re-resolves the new model; the user never sees the hop.
              // When the whole chain is exhausted, the turn goes back to
              // the session model — the one the session was on — and
              // tries it once more instead of failing: a key that just
              // failed on another model may still answer on it. Only
              // after that does an exhaustion error fail at once with
              // the generic message: falling through would let the retry
              // policy burn its same-model attempts (a rate-limit-shaped
              // exhaustion is retryable) and only then fail — with the
              // original error, not the generic one. An auth error with
              // no hop left and no session model to fall back to fails
              // at once the same way: retrying the same model would fail
              // the same way, and the per-model auth error must never
              // reach the user. A throttle or a mid-task failure with no
              // hop left falls through to the same-model retry instead.
              // Diagnostic log only, never the screen: each hop records
              // which model was tried and why the chain stopped.
              if (SessionRouter.isHopSignal(error)) {
                const exhausted = SessionRouter.isExhaustionError(error)
                if (SessionRouter.isProviderDead(error)) deadProviders.add(loaded.model.ref.providerID)
                const next = SessionRouter.nextHopFor(chain, tried, available, error, loaded.model, deadProviders)
                if (next !== undefined) {
                  tried.add(SessionRouter.refKey(next))
                  yield* Effect.logInfo("manostech router hop", {
                    sessionID,
                    from: SessionRouter.refKey(loaded.model.ref),
                    to: SessionRouter.refKey(next),
                    errorType: error.type,
                    errorStatus: error.status,
                    tried: tried.size,
                    chain: chain.length,
                  })
                  yield* bus.publish(SessionEvent.ModelSelected, {
                    sessionID,
                    model: next,
                    previous: loaded.session.model,
                  })
                  return { retry: true as const, attempt: (retryAttempt ?? 1) + 1, delay: 0 }
                }
                // The chain is exhausted. Keep trying: go back to the
                // session model — the one the session was on — and try it
                // once more instead of failing the turn.
                if (yield* fallbackToSessionModel(loaded.model.ref)) {
                  return { retry: true as const, attempt: (retryAttempt ?? 1) + 1, delay: 0 }
                }
                if (exhausted) {
                  yield* Effect.logWarning("manostech router chain exhausted", {
                    sessionID,
                    lastModel: SessionRouter.refKey(loaded.model.ref),
                    errorType: error.type,
                    errorStatus: error.status,
                    tried: tried.size,
                    chain: chain.length,
                  })
                  return { retry: false as const }
                }
                if (error.type === "provider.auth") {
                  // A dead key never heals with backoff: the same model
                  // would fail the same way, so the turn ends now with
                  // the generic message instead of the auth error.
                  yield* Effect.logWarning("manostech router chain exhausted", {
                    sessionID,
                    lastModel: SessionRouter.refKey(loaded.model.ref),
                    errorType: error.type,
                    errorStatus: error.status,
                    tried: tried.size,
                    chain: chain.length,
                  })
                  return yield* new StepFailedError({ error: SessionRouter.CASCADE_EXHAUSTED })
                }
                yield* Effect.logInfo("manostech router no hop left, same-model retry", {
                  sessionID,
                  model: SessionRouter.refKey(loaded.model.ref),
                  errorType: error.type,
                  errorStatus: error.status,
                  tried: tried.size,
                  chain: chain.length,
                })
              }
              if (error.type === "provider.key-expired") {
                // The ManosTech client key expired mid-session: no hop
                // (every gateway model shares that one key) and no
                // backoff retry (a dead key never heals) — the turn ends
                // now with the error itself, so the timeline tells the
                // user to send the message again instead of the generic
                // exhaustion message.
                yield* Effect.logWarning("manostech router key expired", {
                  sessionID,
                  lastModel: SessionRouter.refKey(loaded.model.ref),
                  errorType: error.type,
                  errorStatus: error.status,
                })
                return yield* new StepFailedError({ error })
              }
              return yield* retry.decide({
                cause,
                error,
                agent: loaded.agent.id,
                model: loaded.model.ref,
                hook: prepared.retry,
                retry: proposed,
              })
            }),
          recoverContinuation,
          recoverOverflow: Effect.suspend(() => {
            if (!recoverOverflow) return Effect.succeed(false)
            // A bigger model takes this prompt whole: hop to it instead of
            // shrinking the prompt for a model that cannot hold it. The
            // retry callback below makes the hop; compaction only runs
            // when no bigger model remains in the chain.
            if (
              SessionRouter.nextHopWithLargerWindow(available, chain, tried, loaded.model, deadProviders) !==
              undefined
            )
              return Effect.succeed(false)
            return compaction
              .compact({ reason: "overflow", context: loaded, estimate })
              .pipe(Effect.map((result) => result.status === "completed"))
          }),
        })
        retryAttempt = undefined
        const completed = yield* SessionStep.Outcome.$match(outcome, {
          Completed: Effect.fnUntraced(function* (outcome) {
            // The Session is about to go idle, which leaves the background summary time to finish.
            if (!outcome.needsContinuation)
              yield* compaction.precompute(
                store.context(sessionID).pipe(Effect.map((messages) => ({ ...loaded, messages }))),
              )
            return outcome.needsContinuation
          }),
          Retry: Effect.fnUntraced(function* (outcome) {
            retryAttempt = outcome.decision.attempt
            // A same-model retry that would wait past the budget fails now
            // with the generic message instead of sleeping through it.
            const now = yield* Clock.currentTimeMillis
            if (SessionRouter.cascadeBudgetSpent(stepStartedAt, now + outcome.decision.delay, outputStarted))
              return yield* new StepFailedError({ error: SessionRouter.CASCADE_EXHAUSTED })
            yield* retry.wait({
              decision: outcome.decision,
              error: outcome.error,
              assistantMessageID,
            })
          }),
          Continue: Effect.fnUntraced(function* (outcome) {
            outputStarted = true
            retryAttempt = outcome.decision.attempt
            yield* retry.wait({
              decision: outcome.decision,
              error: outcome.error,
              assistantMessageID,
            })
            yield* bus.publish(SessionEvent.Synthetic, { sessionID, text: CONTINUE_AFTER_INCOMPLETE_STREAM })
            assistantMessageID = SessionMessage.ID.create()
          }),
          OutputLimit: Effect.fn("SessionRunner.continueOutputLimit")(function* (outcome) {
            outputStarted = true
            // The current response is included. User input or any other finish breaks the streak.
            const recent = yield* db
              .select({
                type: SessionMessageTable.type,
                finish: sql<string | null>`json_extract(${SessionMessageTable.data}, '$.finish')`,
              })
              .from(SessionMessageTable)
              .where(
                and(
                  eq(SessionMessageTable.session_id, sessionID),
                  inArray(SessionMessageTable.type, ["user", "assistant"]),
                ),
              )
              .orderBy(desc(SessionMessageTable.seq))
              .limit(3)
              .all()
              .pipe(Effect.orDie)
            const exhausted =
              recent.length === 3 && recent.every((row) => row.type === "assistant" && row.finish === "length")
            if (exhausted)
              return yield* new StepFailedError({
                error: {
                  type: "output-limit",
                  message: "Response still truncated after two output token limit continuations",
                },
              })
            if (outcome.needsContinuation) return true
            yield* bus.publish(SessionEvent.Synthetic, { sessionID, text: CONTINUE_AFTER_OUTPUT_LIMIT })
            assistantMessageID = SessionMessage.ID.create()
          }),
          Compacted: Effect.fnUntraced(function* () {
            recoverOverflow = false
            assistantMessageID = SessionMessage.ID.create()
          }),
          RecoverFull: Effect.fnUntraced(function* () {
            recoverContinuation = false
          }),
        })
        if (completed !== undefined) return completed
      }
    })

    const settleStaleCompactions = Effect.fn("SessionRunner.settleStaleCompactions")(function* (
      sessionID: SessionSchema.ID,
    ) {
      // A process death skips compaction finalizers. Include orphans behind a
      // completed checkpoint, and settle newest first to match event projection.
      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, sessionID),
            eq(SessionMessageTable.type, "compaction"),
            sql`json_extract(${SessionMessageTable.data}, '$.status') = 'running'`,
          ),
        )
        .orderBy(desc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      for (const row of rows) {
        const message = yield* SessionHistory.decodeMessageRow(row)
        if (message.type !== "compaction") continue
        yield* bus.publish(SessionEvent.Compaction.Failed, {
          sessionID,
          reason: message.reason,
          inputID: message.id,
          error: { type: "compaction.interrupted", message: "Compaction was interrupted" },
        })
      }
    })

    const settleStaleToolCalls = Effect.fn("SessionRunner.settleStaleToolCalls")(function* (
      sessionID: SessionSchema.ID,
    ) {
      for (const message of yield* SessionHistory.incompleteAssistants(db, sessionID)) {
        if (message.type !== "assistant") continue
        for (const tool of message.content) {
          if (tool.type !== "tool" || (tool.state.status !== "streaming" && tool.state.status !== "running")) continue
          const metadata = tool.state.status === "running" ? tool.state.metadata : undefined
          const childID =
            tool.name === "subagent" && typeof metadata?.sessionID === "string" ? metadata.sessionID : undefined
          yield* bus.publish(SessionEvent.Tool.Failed, {
            sessionID,
            assistantMessageID: message.id,
            id: tool.id,
            error: {
              type: "aborted",
              message: `Tool execution interrupted: ${tool.name}${childID ? ` (sessionID: ${childID})` : ""}`,
            },
            ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
            executed: tool.executed === true,
          })
        }
      }
    })

    return Service.of({
      drain: (input) => drain(input).pipe(Effect.annotateSpans("session.id", input.sessionID)),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Bus.node,
    LocationLifecycle.node,
    llmClient,
    SessionContext.node,
    Model.node,
    SessionModelTransport.node,
    SessionStore.node,
    SessionCompaction.node,
    Plugin.node,
    PluginHooks.node,
    Job.node,
    SessionTitle.node,
    Snapshot.node,
    ToolOutput.node,
    Database.node,
  ],
})
