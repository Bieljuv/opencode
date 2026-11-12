import manostechLogo from "@/assets/manostech-logo.png"
import { useLanguage } from "@opencode/app/desktop"
import { usePlatform } from "@/runtime/platform/platform"
import { Button } from "@opencode/ui/button"
import { Loader } from "@opencode/ui/loader"
import { TextInput } from "@opencode/ui/text-input"
import { Match, Show, Switch, createEffect, createSignal, onCleanup, untrack, type JSX } from "solid-js"
import type { ElectronAPI } from "../api-types"
import {
  createClientGateState,
  errorKey,
  transitionClientGate,
  type ClientGateEffect,
  type ClientGateError,
  type ClientGateEvent,
} from "./machine"
import { transitionExportLogs, type ExportLogsState } from "./export-logs"
import "./gate.css"

/**
 * ManosTech: o portão da conta do cliente. Cobre o editor inteiro enquanto
 * não há sessão válida. Quando a sessão está válida, não desenha nada.
 * Segue o mesmo desenho do componente de onboarding: máquina pura + driver
 * fino na borda, sem reiniciar nada.
 */

const CONTACT_EMAIL_URL = "mailto:contato@manostech-system.com.br"
const CONTACT_WHATSAPP_URL = "https://wa.me/5547997049730"
const REVALIDATE_MS = 15 * 60_000

export function ManosTechClientGate(props: { api: ElectronAPI }) {
  const language = useLanguage()
  const platform = usePlatform()
  const initial = createClientGateState()
  const [state, setState] = createSignal(initial.state)
  const [email, setEmail] = createSignal("")
  const [password, setPassword] = createSignal("")
  const [currentPassword, setCurrentPassword] = createSignal("")
  const [nextPassword, setNextPassword] = createSignal("")
  const [confirmPassword, setConfirmPassword] = createSignal("")
  const [mismatch, setMismatch] = createSignal(false)
  const [copied, setCopied] = createSignal(false)
  const [exportLogs, setExportLogs] = createSignal<ExportLogsState>("idle")

  const queue: ClientGateEvent[] = []
  let revalidateTimer: ReturnType<typeof setTimeout> | undefined
  let copiedTimer: ReturnType<typeof setTimeout> | undefined

  const dispatch = (event: ClientGateEvent) => {
    queue.push(event)

    if (queue.length === 1) drain()
  }

  const drain = () => {
    const event = queue[0]

    if (!event) return

    try {
      const next = transitionClientGate(untrack(state), event)
      setState(next.state)
      next.effects.forEach((effect) =>
        Promise.try(() => run(effect)).catch((error) =>
          console.error("[manostech-client] effect failed", { effect: effect.type, error }),
        ),
      )
    } finally {
      queue.shift()
    }

    drain()
  }

  const run = (effect: ClientGateEffect) => {
    switch (effect.type) {
      case "check-status":
        return void props.api.getClientStatus().then(
          (status) => dispatch({ type: "status.settled", status }),
          () => dispatch({ type: "status.failed" }),
        )

      case "check-google":
        return void props.api.getClientGoogleAvailable().then(
          (available) => dispatch({ type: "google.availability.settled", available }),
          () => dispatch({ type: "google.availability.settled", available: false }),
        )

      case "do-login":
        return void props.api.loginClient(effect.email, effect.password).then(
          (result) =>
            result.ok
              ? dispatch({ type: "login.succeeded", status: result.status })
              : dispatch({ type: "login.failed", error: result.error }),
          () => dispatch({ type: "login.failed", error: { tag: "network" } }),
        )

      case "do-change":
        return void props.api.changeClientPassword(effect.current, effect.next).then(
          (result) =>
            result.ok
              ? dispatch({ type: "change.succeeded" })
              : dispatch({ type: "change.failed", error: result.error }),
          () => dispatch({ type: "change.failed", error: { tag: "network" } }),
        )

      case "do-forgot":
        return void props.api.forgotClientPassword(effect.email).then(
          (result) =>
            result.ok
              ? dispatch({ type: "forgot.succeeded" })
              : dispatch({ type: "forgot.failed", error: result.error }),
          () => dispatch({ type: "forgot.failed", error: { tag: "network" } }),
        )

      case "do-google-start":
        return void props.api.startClientGoogle().then(
          (result) =>
            result.available
              ? dispatch({ type: "google.started", authorizeUrl: result.authorizeUrl })
              : dispatch({ type: "google.unavailable" }),
          () => dispatch({ type: "google.unavailable" }),
        )

      case "do-google-cancel":
        return void props.api.cancelClientGoogle().catch(() => undefined)

      case "schedule-revalidation": {
        if (revalidateTimer !== undefined) clearTimeout(revalidateTimer)

        const current = untrack(state)
        const trialEndsAt = current.status === "ready" ? current.trialEndsAt : null
        const untilTrialEnd = trialEndsAt ? Date.parse(trialEndsAt) - Date.now() : Number.POSITIVE_INFINITY
        // A data de renovação da chave: revalidar NA virada do ciclo, para
        // a chave nova ser buscada e o gateway reconectado antes de a velha
        // parar de responder no meio da sessão — em vez de até 15 min tarde.
        const renewsAt = current.status === "ready" ? current.apiKeyRenewsAt : null
        const untilRenewal = renewsAt ? Date.parse(renewsAt) - Date.now() : Number.POSITIVE_INFINITY
        const delay = Math.min(
          REVALIDATE_MS,
          untilTrialEnd <= 0 ? 5_000 : untilTrialEnd,
          untilRenewal <= 0 ? 5_000 : untilRenewal,
        )
        revalidateTimer = setTimeout(() => dispatch({ type: "revalidate" }), delay)

        return
      }

      case "cancel-revalidation":
        if (revalidateTimer !== undefined) {
          clearTimeout(revalidateTimer)
          revalidateTimer = undefined
        }

        return
    }
  }

  const stopClientChanged = props.api.onClientChanged(() => dispatch({ type: "client.changed" }))

  onCleanup(() => {
    stopClientChanged()
    if (revalidateTimer !== undefined) clearTimeout(revalidateTimer)
    if (copiedTimer !== undefined) clearTimeout(copiedTimer)
    dispatch({ type: "disposed" })
  })

  createEffect(() => {
    initial.effects.forEach((effect) => void run(effect))
  })

  const loginBusy = () => {
    const current = state()

    return current.status === "login" && current.busy
  }

  const loginError = (): ClientGateError | undefined => {
    const current = state()

    return current.status === "login" ? current.error : undefined
  }

  const googleVisible = () => {
    const current = state()

    return current.status === "login" && current.googleAvailable === true
  }

  const changeBusy = () => {
    const current = state()

    return current.status === "change-password" && current.busy
  }

  const changeError = (): ClientGateError | undefined => {
    const current = state()

    return current.status === "change-password" ? current.error : undefined
  }

  const waitingUrl = (): string | undefined => {
    const current = state()

    return current.status === "waiting-google" ? current.authorizeUrl : undefined
  }

  const retryGoogle = (url: string) => {
    void platform.openBrowser?.(url)
  }

  const copyGoogleLink = async (url: string) => {
    try {
      await (platform.writeClipboardText?.(url) ?? navigator.clipboard.writeText(url))
      setCopied(true)
      if (copiedTimer !== undefined) clearTimeout(copiedTimer)
      copiedTimer = setTimeout(() => setCopied(false), 2_000)
    } catch {
      // Sem feedback de erro: o botão continua "Copiar link".
    }
  }

  // A exportação de logs a partir da tela de login: o mesmo exportador que
  // o menu e a página de erro já usam, sem exigir sessão. O zip cai na
  // pasta Downloads e o Explorer abre com ele selecionado; a tela só mostra
  // a confirmação genérica (ou o erro genérico), nunca detalhe técnico.
  const exportLogsNow = () => {
    const next = transitionExportLogs(exportLogs(), {
      type: "export.requested",
      available: !!platform.exportDebugLogs,
    })
    setExportLogs(next.state)

    if (next.effects.length === 0) return

    const runExport = platform.exportDebugLogs

    if (!runExport) return

    void runExport().then(
      () => setExportLogs(transitionExportLogs(exportLogs(), { type: "export.succeeded" }).state),
      () => setExportLogs(transitionExportLogs(exportLogs(), { type: "export.failed" }).state),
    )
  }

  const forgotBusy = () => {
    const current = state()

    return current.status === "forgot" && current.busy
  }

  const forgotError = (): ClientGateError | undefined => {
    const current = state()

    return current.status === "forgot" ? current.error : undefined
  }

  const submitLogin = (event: Event) => {
    event.preventDefault()
    dispatch({ type: "login.submitted", email: email(), password: password() })
  }

  const submitChange = (event: Event) => {
    event.preventDefault()

    if (nextPassword() !== confirmPassword()) {
      setMismatch(true)

      return
    }

    setMismatch(false)
    dispatch({ type: "change.submitted", current: currentPassword(), next: nextPassword() })
  }

  const submitForgot = (event: Event) => {
    event.preventDefault()
    dispatch({ type: "forgot.submitted", email: email() })
  }

  return (
    <Switch>
      <Match when={state().status === "ready"}>{null}</Match>

      <Match when={state().status === "checking"}>
        <GateShell>
          <Loader width={24} height={24} />
          <p role="status">{language.t("client.checking")}</p>
        </GateShell>
      </Match>

      <Match when={state().status === "login"}>
        <GateShell>
          <header>
            <h1>{language.t("client.login.title")}</h1>
            <p>{language.t("client.login.description")}</p>
          </header>
          <form onSubmit={submitLogin}>
            <div class="client-gate-field">
              <label for="client-gate-email">{language.t("client.login.email")}</label>
              <TextInput
                id="client-gate-email"
                name="email"
                dir="ltr"
                type="email"
                inputMode="email"
                autocapitalize="off"
                spellcheck={false}
                autocomplete="username"
                required
                appearance="large"
                placeholder={language.t("client.login.email.placeholder")}
                value={email()}
                disabled={loginBusy()}
                aria-describedby={loginError() ? "client-gate-error" : undefined}
                onInput={(event) => setEmail(event.currentTarget.value)}
              />
            </div>
            <div class="client-gate-field">
              <label for="client-gate-password">{language.t("client.login.password")}</label>
              <TextInput
                id="client-gate-password"
                name="password"
                type="password"
                autocomplete="current-password"
                required
                appearance="large"
                placeholder={language.t("client.login.password.placeholder")}
                value={password()}
                disabled={loginBusy()}
                aria-describedby={loginError() ? "client-gate-error" : undefined}
                onInput={(event) => setPassword(event.currentTarget.value)}
              />
            </div>
            <Show when={loginError()}>
              {(error) => (
                <span id="client-gate-error" class="client-gate-error" role="alert">
                  {language.t(errorKey(error()))}
                </span>
              )}
            </Show>
            <Button type="submit" variant="submit" disabled={loginBusy()}>
              {language.t(loginBusy() ? "client.login.entering" : "client.login.button")}
            </Button>
          </form>
          <Button variant="ghost" disabled={loginBusy()} onClick={() => dispatch({ type: "forgot.requested" })}>
            {language.t("client.login.forgotPassword")}
          </Button>
          <Show when={googleVisible()}>
            <div class="client-gate-divider">
              <span>{language.t("client.login.or")}</span>
            </div>
            <Button variant="outline" disabled={loginBusy()} onClick={() => dispatch({ type: "google.submitted" })}>
              {language.t("client.login.google")}
            </Button>
          </Show>
          <Show when={platform.platform === "desktop" && platform.exportDebugLogs}>
            <Button
              variant="ghost"
              disabled={exportLogs() === "exporting" || loginBusy()}
              onClick={exportLogsNow}
            >
              {language.t("command.logs.export")}
            </Button>
            <Show when={exportLogs() === "exported"}>
              <p role="status">{language.t("client.login.exportLogs.exported")}</p>
            </Show>
            <Show when={exportLogs() === "failed"}>
              <span class="client-gate-error" role="alert">
                {language.t("common.requestFailed")}
              </span>
            </Show>
          </Show>
        </GateShell>
      </Match>

      <Match when={state().status === "forgot"}>
        <GateShell>
          <header>
            <h1>{language.t("client.forgotPassword.title")}</h1>
            <p>{language.t("client.forgotPassword.description")}</p>
          </header>
          <form onSubmit={submitForgot}>
            <div class="client-gate-field">
              <label for="client-gate-forgot-email">{language.t("client.login.email")}</label>
              <TextInput
                id="client-gate-forgot-email"
                name="email"
                dir="ltr"
                type="email"
                inputMode="email"
                autocapitalize="off"
                spellcheck={false}
                autocomplete="username"
                required
                appearance="large"
                placeholder={language.t("client.login.email.placeholder")}
                value={email()}
                disabled={forgotBusy()}
                aria-describedby={forgotError() ? "client-gate-forgot-error" : undefined}
                onInput={(event) => setEmail(event.currentTarget.value)}
              />
            </div>
            <Show when={forgotError()}>
              {(error) => (
                <span id="client-gate-forgot-error" class="client-gate-error" role="alert">
                  {language.t(errorKey(error()))}
                </span>
              )}
            </Show>
            <Button type="submit" variant="submit" disabled={forgotBusy()}>
              {language.t(forgotBusy() ? "client.forgotPassword.sending" : "client.forgotPassword.button")}
            </Button>
          </form>
          <Button variant="ghost" onClick={() => dispatch({ type: "forgot.cancelled" })}>
            {language.t("client.forgotPassword.back")}
          </Button>
        </GateShell>
      </Match>

      <Match when={state().status === "forgot-sent"}>
        <GateShell>
          <header>
            <h1>{language.t("client.forgotPassword.title")}</h1>
            <p>{language.t("client.forgotPassword.sent")}</p>
          </header>
          <Button variant="submit" onClick={() => dispatch({ type: "forgot.cancelled" })}>
            {language.t("client.forgotPassword.back")}
          </Button>
        </GateShell>
      </Match>

      <Match when={state().status === "waiting-google"}>
        <GateShell>
          <Loader width={24} height={24} />
          <p role="status">{language.t("client.google.waiting")}</p>
          <Show when={waitingUrl()}>
            {(url) => (
              <>
                <Button variant="submit" onClick={() => retryGoogle(url())}>
                  {language.t("client.google.retry")}
                </Button>
                <p>{language.t("client.google.copyHint")}</p>
                <div class="client-gate-link" dir="ltr">
                  {url()}
                </div>
                <Button variant="outline" onClick={() => void copyGoogleLink(url())}>
                  {language.t(copied() ? "common.copied" : "client.google.copyLink")}
                </Button>
              </>
            )}
          </Show>
          <Button variant="ghost" onClick={() => dispatch({ type: "google.cancelled" })}>
            {language.t("client.google.back")}
          </Button>
        </GateShell>
      </Match>

      <Match when={state().status === "change-password"}>
        <GateShell>
          <header>
            <h1>{language.t("client.changePassword.title")}</h1>
            <p>{language.t("client.changePassword.description")}</p>
          </header>
          <form onSubmit={submitChange}>
            <div class="client-gate-field">
              <label for="client-gate-current">{language.t("client.changePassword.current")}</label>
              <TextInput
                id="client-gate-current"
                name="current-password"
                type="password"
                autocomplete="current-password"
                appearance="large"
                value={currentPassword()}
                disabled={changeBusy()}
                onInput={(event) => setCurrentPassword(event.currentTarget.value)}
              />
            </div>
            <div class="client-gate-field">
              <label for="client-gate-next">{language.t("client.changePassword.next")}</label>
              <TextInput
                id="client-gate-next"
                name="new-password"
                type="password"
                autocomplete="new-password"
                required
                appearance="large"
                value={nextPassword()}
                disabled={changeBusy()}
                onInput={(event) => {
                  setNextPassword(event.currentTarget.value)
                  setMismatch(false)
                }}
              />
            </div>
            <div class="client-gate-field">
              <label for="client-gate-confirm">{language.t("client.changePassword.confirm")}</label>
              <TextInput
                id="client-gate-confirm"
                name="confirm-password"
                type="password"
                autocomplete="new-password"
                required
                appearance="large"
                value={confirmPassword()}
                disabled={changeBusy()}
                onInput={(event) => {
                  setConfirmPassword(event.currentTarget.value)
                  setMismatch(false)
                }}
              />
            </div>
            <Show when={mismatch()}>
              <span class="client-gate-error" role="alert">
                {language.t("client.changePassword.error.mismatch")}
              </span>
            </Show>
            <Show when={changeError()}>
              {(error) => (
                <span class="client-gate-error" role="alert">
                  {language.t(errorKey(error()))}
                </span>
              )}
            </Show>
            <Button type="submit" variant="submit" disabled={changeBusy()}>
              {language.t(changeBusy() ? "client.changePassword.saving" : "client.changePassword.button")}
            </Button>
          </form>
        </GateShell>
      </Match>

      <Match when={state().status === "trial-expired"}>
        <GateShell>
          <header>
            <h1>{language.t("client.trialExpired.title")}</h1>
            <p>{language.t("client.trialExpired.description")}</p>
          </header>
          <Button variant="submit" onClick={() => platform.openExternal(CONTACT_EMAIL_URL)}>
            {language.t("client.trialExpired.email")}
          </Button>
          <Button variant="outline" onClick={() => platform.openExternal(CONTACT_WHATSAPP_URL)}>
            {language.t("client.trialExpired.whatsapp")}
          </Button>
          <Button variant="ghost" onClick={() => dispatch({ type: "trial-expired.back" })}>
            {language.t("client.trialExpired.back")}
          </Button>
        </GateShell>
      </Match>
    </Switch>
  )
}

function GateShell(props: { children: JSX.Element }) {
  return (
    <div data-component="client-gate" class="fixed inset-0 z-[100]">
      <main>
        <div class="client-gate-content">
          <div class="client-gate-brand" role="img" aria-label="ManosTech">
            <img src={manostechLogo} alt="" class="mx-auto block size-28" />
          </div>
          {props.children}
        </div>
      </main>
    </div>
  )
}
