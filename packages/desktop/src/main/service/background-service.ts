import { app } from "electron"
import type { Endpoint } from "@opencode/client/service"
import { Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { SidecarChanged } from "../../shared/ipc-rpc/events"
import { CHANNEL } from "../constants"
import { loadApiKey } from "../client-auth/store"
import { connectionServerEnv, loadAllConnectionStatuses } from "../connections/store"
import { emitIpcEvent } from "../ipc-events"
import { getStore } from "../storage/store"
import { getMainWindows } from "../windows"
import { clientFilePath } from "../client-auth/reporter-file"
import { BackgroundServiceMachine } from "./background-service-machine"
import { setBackgroundServiceRestarter } from "./background-service-restart"
import { cleanStages } from "./cli-stages"
import { keptStages, serviceVersion, shouldAdoptProbedService, shouldRetryEnsure } from "./cli-version"
import { DesktopCli } from "./desktop-cli"
import { manostechToolsEnv, resolveManostechTools } from "./manostech-tools"
import { SidecarCredentials } from "./sidecar-credentials"
import { takeSidecarProbe } from "./sidecar-probe"
import { DesktopPaths } from "../paths"

export * as BackgroundService from "./background-service"

const RegisteredService = Schema.Struct({ version: Schema.optional(Schema.String) })

export interface Interface {
  readonly connection: Effect.Effect<SidecarCredentials.Data>
  readonly reconnect: Effect.Effect<SidecarCredentials.Data>
  readonly restart: Effect.Effect<SidecarCredentials.Data>
}

export class Service extends Context.Service<Service, Interface>()("opencode/desktop/BackgroundService") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | DesktopCli.Service>()

    const machine = yield* BackgroundServiceMachine.make({
      probe: probe().pipe(Effect.provide(context)),
      ensure: (mode) => ensure(mode).pipe(Effect.provide(context)),
      publish: (data) => {
        SidecarCredentials.set(data)
        // Every window moves its requests and event stream to the new origin, not only the one that reconnected.
        const event = new SidecarChanged({ url: data.url })
        getMainWindows().forEach((win) => emitIpcEvent(win.webContents, event))
      },
    })

    // Plain main code (the client login) asks for a restart through this
    // bridge: the machine owns the transition, this only dispatches it.
    // A failed restart keeps the last service (the machine's contract),
    // so the login never depends on it.
    setBackgroundServiceRestarter(() => {
      void Effect.runFork(machine.restart.pipe(Effect.ignore))
    })

    return Service.of(machine)
  }),
)

// A compatible service the entry module already found is adopted at once; the machine still verifies it with
// `ensure("initial")` (which also completes a terminal handoff), off the renderer's path. A probed service
// running a different version than the bundled CLI is not adopted at all: the machine runs `ensure("initial")`
// instead, which stops the old engine and starts a new one. Adopting it and trusting the background
// verification alone used to leave the old engine answering when that verification failed.
const probe = Effect.fn("BackgroundService.probe")(function* () {
  const service = yield* Effect.promise(takeSidecarProbe)

  if (!service) return undefined
  const setup = yield* prepare("initial")
  const ready = yield* adopt(setup, service, true)

  if (!shouldAdoptProbedService(ready.runningVersion, setup.version)) {
    yield* Effect.logWarning("v2 CLI background service version mismatch after probe; starting a new service", {
      runningVersion: ready.runningVersion,
      version: setup.version,
    })

    return undefined
  }

  return ready.credentials
})

const ensure = Effect.fn("BackgroundService.ensure")(function* (mode: BackgroundServiceMachine.ConnectMode) {
  const runFork = Effect.runForkWith(yield* Effect.context<FileSystem.FileSystem | Path.Path>())
  const setup = yield* prepare(mode)

  // A restart replaces the running server: stop it first, so the ensure
  // below spawns a fresh one with the current environment. A reconnect
  // would reuse the running server and its frozen environment.
  // `Service.stop` is the Promise client: no service registered is a
  // no-op, and a failure to stop must not block the fresh ensure.
  if (mode === "restart")
    yield* Effect.tryPromise(() => setup.client.Service.stop({ file: setup.file })).pipe(Effect.ignore)

  const ingestApiKey = loadApiKey()
  const run = (version = setup.version) =>
    setup.client.Service.ensure({
      file: setup.file,
      version,
      // A fixed port makes a second contender fail to bind and back off; port 0 never collides, so two
      // services could boot against the same database.
      command: [
        ...setup.cli.command,
        "serve",
        "--service",
        ...(setup.isolated ? ["--hostname", "0.0.0.0", "--port", String(0x0c0c)] : []),
      ],
      // ManosTech: the usage reporter in the server reads the client identity
      // from this file and authenticates with the client's own API key,
      // which the main reads from its encrypted store and hands to the
      // sidecar here. No shared secret is baked into the installer: the
      // key belongs to the logged-in client, and the panel rejects any
      // event whose client_id is not the key's. The file is read fresh on
      // every reported step, but the key arrives only in this environment,
      // so it is read once per service start: a login that stores a key
      // after startup asks for a service restart, or the reporter keeps
      // running without the key until the app restarts.
      env: {
        MANOSTECH_CLIENT_FILE: clientFilePath(),
        ...(ingestApiKey ? { MANOSTECH_INGEST_API_KEY: ingestApiKey } : {}),
        // ManosTech: as conexões da conta do cliente chegam ao servidor
        // só como estado (conectado + nome da conta), nunca como token —
        // o token fica no store do processo principal. O guia /publicar
        // lê daqui qual conexão falta; a execução via API ainda não
        // existe e segue guiada/manual.
        ...connectionServerEnv(loadAllConnectionStatuses(getStore())),
        // ManosTech: the bundled video tools (Node + FFmpeg) go on the
        // sidecar's PATH so the agent's shell finds them without installing
        // anything. Nothing is added when the build did not stage them.
        ...manostechToolsEnv(setup.tools, process.env.PATH),
      },
      onStart: (reason, previousVersion) =>
        runFork(Effect.logInfo("v2 CLI background service starting", { reason, previousVersion })),
    })

  const service = yield* Effect.tryPromise(() =>
    run().catch((error) => {
      if (!shouldRetryEnsure(setup.version, error instanceof Error ? error.message : String(error))) throw error

      return run(setup.cli.version)
    }),
  )

  const ready = yield* adopt(setup, service, false)

  // Only packaged and isolated builds run a staged copy; any other binary sits in the source tree.
  // Keep both the bundled stage and the running server's stage so its executable stays on disk. This runs only
  // once `Service.ensure` settled which server runs, never for a probed one it may still replace.
  if (mode === "initial" && (app.isPackaged || setup.isolated) && setup.cli.binary && ready.runningVersion)
    runFork(
      cleanStages(setup.cli.binary, { keep: keptStages(setup.cli.version, ready.runningVersion) }).pipe(
        Effect.catch((error) => Effect.logError("failed to clean staged v2 CLIs", { error })),
      ),
    )

  return ready.credentials
})

const prepare = Effect.fn("BackgroundService.prepare")(function* (mode: BackgroundServiceMachine.ConnectMode) {
  yield* Effect.logInfo("starting v2 background service")
  const path = yield* Path.Path
  const desktopCli = yield* DesktopCli.Service
  const isolated = !app.isPackaged && process.env.OPENCODE_DESKTOP_ISOLATED_SERVER === "1"
  const cli = yield* desktopCli.resolve
  const version = serviceVersion({ channel: CHANNEL, isolated, mode, version: cli.version })

  const desktopPaths = yield* DesktopPaths.resolve
  const tools = yield* Effect.sync(() =>
    resolveManostechTools({
      resourcesRoot: app.isPackaged ? process.resourcesPath : desktopPaths.developmentResourcesRoot,
    }),
  )

  if (tools) yield* Effect.logInfo("bundled video tools resolved", { dir: tools.dir })

  if (isolated) process.env.XDG_STATE_HOME = app.getPath("userData")
  const client = yield* Effect.promise(() => import("@opencode/client/service"))

  const file =
    process.env.OPENCODE_DESKTOP_SERVER_CHANNEL === "local"
      ? path.join(
          process.env.XDG_STATE_HOME ?? path.join(app.getPath("home"), ".local", "state"),
          "opencode",
          "service-local.json",
        )
      : undefined

  return { cli, client, file, isolated, tools, version }
})

const adopt = Effect.fn("BackgroundService.adopt")(function* (
  setup: Effect.Success<ReturnType<typeof prepare>>,
  service: Endpoint,
  probed: boolean,
) {
  const fs = yield* FileSystem.FileSystem

  if (service.auth?.type !== "basic") throw new Error("V2 CLI background service did not provide authentication")
  const url = new URL(service.url)

  if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1"

  const runningVersion = yield* fs.readFileString(setup.file ?? setup.client.fallback()).pipe(
    Effect.map(
      (text) =>
        Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(RegisteredService))(text))?.version,
    ),
    Effect.orElseSucceed(() => undefined),
  )

  yield* Effect.logInfo("v2 CLI background service ready", {
    version: setup.version,
    runningVersion,
    probed,
    ...endpoint(url.origin),
  })

  return {
    credentials: { url: url.origin, password: service.auth.password } satisfies SidecarCredentials.Data,
    runningVersion,
  }
})

function endpoint(url: string | undefined) {
  if (!url || !URL.canParse(url)) return {}
  const parsed = new URL(url)

  return { url, hostname: parsed.hostname, port: parsed.port }
}
