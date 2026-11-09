import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Loader } from "@opencode/ui/loader"
import { Tooltip } from "@opencode/ui/tooltip"
import { createSignal, onCleanup, Show } from "solid-js"
import type { ComposerEditorModel } from "@/composer/editor/interaction"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { useServer } from "@/runtime/server/current"
import { showToast } from "@/shell/notifications/toast"
import { DictationFailure, DictationTransport, type DictationEngine } from "./dictation-transport"
import { GatewayDictationTransport } from "./gateway-dictation-transport"
import type { DictationJoinFailure } from "./dictation-machine"
import type { VoiceEvent } from "./protocol"

type DictationStatus = "idle" | "connecting" | "recording"

const failureTitle = {
  unavailable: "composer.dictation.failure.unavailable",
  microphone: "composer.dictation.failure.microphone",
  connection: "composer.dictation.failure.connection",
  transcription: "composer.dictation.failure.transcription",
  dropped: "composer.dictation.failure.dropped",
} as const

/**
 * The microphone in the composer: records, transcribes live into the draft, and leaves the text
 * there to send. The audio itself is discarded; only the transcript is kept.
 */
export function DictationButton(props: { controller: ComposerEditorModel }) {
  const language = useLanguage()
  const platform = usePlatform()
  const server = useServer()
  const [status, setStatus] = createSignal<DictationStatus>("idle")

  let transport: DictationEngine | undefined
  // The current utterance's interim text, already typed into the draft.
  let pending = ""
  // The user ended the recording while it was still connecting; its failure is not an error.
  let stopping = false

  onCleanup(() => {
    void transport?.close()
  })

  const fail = (reason: DictationJoinFailure | "dropped") => {
    setStatus("idle")
    showToast({ variant: "error", title: language.t(failureTitle[reason]) })
  }

  const onEvent = (event: VoiceEvent) => {
    if (status() !== "recording") return

    if (event.type === "conversation.item.input_audio_transcription.delta") {
      const delta = event.delta ?? ""

      if (!delta) return
      pending += delta
      props.controller.insertText(delta)

      return
    }

    if (event.type === "conversation.item.input_audio_transcription.completed") {
      const transcript = event.transcript ?? ""

      // The deltas already typed usually add up to the final text; only rewrite when they differ,
      // and only when the interim text is still right before the caret.
      if (transcript && transcript !== pending && props.controller.value().endsWith(pending)) {
        props.controller.removeTextBefore(pending)
        props.controller.insertText(transcript)
      }
      pending = ""
    }
  }

  const dropped = () => {
    if (status() !== "recording") return
    transport = undefined
    fail("dropped")
  }

  // A gateway slice failed: the text of that slice is lost, but the recording keeps going
  // (the Forge kept it going) — only the toast shows, never a state change. This also
  // covers a slice that fails while the recording is already finalizing, when the button
  // is idle and there is no recording status to change.
  const gatewayFailed = (reason: DictationJoinFailure) => {
    showToast({ variant: "error", title: language.t(failureTitle[reason]) })
  }

  const startEngine = (engine: DictationEngine) => {
    transport = engine
    const current = transport
    void current.join().then(
      () => {
        if (transport !== current || stopping) return
        setStatus("recording")
        props.controller.restoreFocus()
      },
      (error) => {
        if (transport !== current || stopping) return
        const reason = error instanceof DictationFailure ? error.reason : "connection"
        // The Realtime engine is not available; the gateway takes over silently when the
        // client is logged in — the user never sees which engine is behind the microphone.
        if (reason === "unavailable" && current instanceof DictationTransport) {
          void startGatewayEngine()
          return
        }
        transport = undefined
        fail(reason)
      },
    )
  }

  /** Starts the gateway engine when the client is logged in; otherwise the mic is unavailable. */
  const startGatewayEngine = async () => {
    const active = await platform.isClientGatewayActive?.().catch(() => false)
    const transcribe = platform.transcribeClientAudio

    if (!active || !transcribe) {
      transport = undefined
      fail("unavailable")

      return
    }

    startEngine(new GatewayDictationTransport({ event: onEvent, failed: gatewayFailed, transcribe }))
  }

  const start = () => {
    if (status() !== "idle") return
    setStatus("connecting")
    stopping = false
    pending = ""
    startEngine(
      new DictationTransport({
        voice: server.ctx.sdk.api.experimental.voice,
        event: onEvent,
        dropped,
      }),
    )
  }

  const stop = () => {
    if (status() === "idle") return
    stopping = true
    const current = transport
    transport = undefined
    // The status stays "recording" until the close settles: the final slice's
    // transcription can still be in flight, and onEvent drops events once the
    // status is idle — stopping must not eat the user's last words.
    const closing = current?.close()
    if (!closing) {
      setStatus("idle")

      return
    }
    void closing.then(() => {
      // A new recording started meanwhile; its status is its own.
      if (transport) return
      setStatus("idle")
    })
  }

  return (
    <Show
      when={status() === "recording"}
      fallback={
        <Tooltip placement="top" value={language.t("composer.dictation.record")}>
          <IconButton
            data-action="composer-dictate"
            type="button"
            icon={status() === "connecting" ? <Loader /> : <Icon name="mic" />}
            variant="ghost-muted"
            size="large"
            disabled={status() === "connecting"}
            aria-label={language.t("composer.dictation.record")}
            onClick={start}
          />
        </Tooltip>
      }
    >
      <Tooltip placement="top" value={language.t("composer.dictation.recording")}>
        <Button data-action="composer-dictate-stop" type="button" variant="ghost" size="small" onClick={stop}>
          <span class="text-v2-state-fg-danger">■</span>
          {language.t("composer.dictation.finish")}
        </Button>
      </Tooltip>
    </Show>
  )
}
