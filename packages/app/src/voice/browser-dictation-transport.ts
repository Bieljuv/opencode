import {
  canJoinBrowserDictation,
  createBrowserDictationState,
  transitionBrowserDictation,
  type BrowserDictationEffect,
  type BrowserDictationEvent,
} from "./browser-dictation-machine"
import type { DictationJoinFailure } from "./dictation-machine"
import { DictationFailure, type DictationEngine } from "./dictation-transport"
import type { VoiceEvent } from "./protocol"

/**
 * Minimal shape of the Web Speech API. `lib.dom` does not declare `webkitSpeechRecognition`,
 * so the recognition is reached through a feature check on `window` instead of the global type.
 */
interface BrowserSpeechAlternative {
  readonly transcript: string
  readonly confidence: number
}

interface BrowserSpeechResult {
  readonly isFinal: boolean
  readonly length: number
  [index: number]: BrowserSpeechAlternative
}

interface BrowserSpeechResultList {
  readonly length: number
  [index: number]: BrowserSpeechResult
}

interface BrowserSpeechResultEvent extends Event {
  readonly resultIndex: number
  readonly results: BrowserSpeechResultList
}

interface BrowserSpeechErrorEvent extends Event {
  readonly error: string
  readonly message: string
}

interface BrowserSpeechRecognition extends EventTarget {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  start(): void
  stop(): void
  abort(): void
  onstart: ((event: Event) => void) | null
  onresult: ((event: BrowserSpeechResultEvent) => void) | null
  onerror: ((event: BrowserSpeechErrorEvent) => void) | null
  onend: ((event: Event) => void) | null
}

type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition

function getSpeechRecognition(): BrowserSpeechRecognitionConstructor | undefined {
  const scope = window as unknown as {
    SpeechRecognition?: BrowserSpeechRecognitionConstructor
    webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor
  }

  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition
}

/** Maps a recognition error to the failure the button already knows how to report. */
function mapRecognitionError(error: string): DictationJoinFailure {
  if (error === "not-allowed" || error === "audio-capture") return "microphone"
  if (error === "network") return "offline"
  if (error === "service-not-allowed") return "unavailable"

  return "connection"
}

/**
 * One dictation through the browser's own speech recognition (Web Speech API): no key, no cost,
 * Portuguese. It speaks the same transcript events as the Realtime transport
 * (`conversation.item.input_audio_transcription.delta` / `.completed`), so the composer cannot
 * tell which engine is behind the microphone. `browser-dictation-machine.ts` owns its lifecycle.
 *
 * The recognition runs in the browser's service, not locally: it needs network, and the
 * microphone is captured by the service itself, so there is no `getUserMedia` stream here.
 */
export class BrowserDictationTransport implements DictationEngine {
  private recognition?: BrowserSpeechRecognition
  private state = createBrowserDictationState()
  private joined = Promise.withResolvers<void>()
  private released = Promise.withResolvers<void>()
  private joinTimer?: ReturnType<typeof setTimeout>
  /** Interim text already typed for the current utterance; deltas carry only what is new. */
  private lastInterim = ""

  constructor(
    private readonly inputOptions: {
      event: (event: VoiceEvent) => void
      dropped: () => void
    },
  ) {}

  join() {
    if (!canJoinBrowserDictation(this.state)) return Promise.reject(new DictationFailure("connection"))
    this.dispatch({ type: "join" })

    return this.joined.promise
  }

  /** Settles once the recognition handlers are detached and any pending start is aborted. */
  close() {
    this.dispatch({ type: "close" })

    return this.released.promise
  }

  private dispatch(event: BrowserDictationEvent) {
    const next = transitionBrowserDictation(this.state, event)
    // Set first: an effect's callback may close this transport again.
    this.state = next.state
    next.effects.forEach((effect) => this.perform(effect))
  }

  private perform(effect: BrowserDictationEffect) {
    if (effect.type === "join.timer.start") {
      this.joinTimer = setTimeout(() => this.dispatch({ type: "join.timeout" }), effect.ms)

      return
    }

    if (effect.type === "join.timer.clear") return clearTimeout(this.joinTimer)

    if (effect.type === "check.availability") {
      this.checkAvailability()

      return
    }

    if (effect.type === "start.recognition" || effect.type === "restart.recognition") {
      this.startRecognition()

      return
    }

    if (effect.type === "stop.recognition") {
      try {
        this.recognition?.stop()
      } catch {
        // Already stopped: the `end` event is on its way (or already fired).
      }

      return
    }

    if (effect.type === "release.recognition") {
      this.releaseRecognition()

      return
    }

    if (effect.type === "forward.event") return this.inputOptions.event(effect.event)

    if (effect.type === "join.resolve") return this.joined.resolve()

    if (effect.type === "join.reject") return this.joined.reject(new DictationFailure(effect.reason))

    if (effect.type === "notify.dropped") return this.inputOptions.dropped()

    this.released.resolve()
  }

  private checkAvailability() {
    const Recognition = getSpeechRecognition()

    if (!Recognition)
      return this.dispatch({ type: "step.failed", step: "check", reason: "unavailable" })

    const recognition = new Recognition()
    recognition.lang = "pt-BR"
    recognition.continuous = true
    recognition.interimResults = true
    recognition.maxAlternatives = 1
    recognition.onstart = () => this.dispatch({ type: "recognition.started" })
    recognition.onresult = (event) => this.handleResult(event)
    recognition.onerror = (event) => this.handleError(event)
    recognition.onend = () => this.dispatch({ type: "recognition.ended" })
    this.recognition = recognition
    this.dispatch({ type: "check.ready" })
  }

  private startRecognition() {
    try {
      this.recognition?.start()
    } catch {
      // `start()` throws when the recognition is already running; that run is ending, so a
      // live session drops instead of hanging on a start that never comes.
      if (this.state.status === "live") return this.dispatch({ type: "recognition.error" })
      this.dispatch({ type: "step.failed", step: "starting", reason: "connection" })
    }
  }

  private handleResult(event: BrowserSpeechResultEvent) {
    for (let index = event.resultIndex; index < event.results.length; index++) {
      const result = event.results[index]
      const transcript = result[0]?.transcript ?? ""

      if (!transcript) continue

      if (result.isFinal) {
        this.lastInterim = ""
        this.dispatch({
          type: "recognition.result",
          event: { type: "conversation.item.input_audio_transcription.completed", transcript },
        })

        continue
      }

      // Interim results grow as the user speaks; only the new suffix is a delta. When the
      // service revises what it heard, the interim no longer extends the last one — send the
      // revised text as a completion so the composer replaces the stale partial instead of
      // duplicating it.
      if (transcript.startsWith(this.lastInterim)) {
        const delta = transcript.slice(this.lastInterim.length)
        this.lastInterim = transcript
        if (delta)
          this.dispatch({
            type: "recognition.result",
            event: { type: "conversation.item.input_audio_transcription.delta", delta },
          })
      } else {
        this.lastInterim = transcript
        this.dispatch({
          type: "recognition.result",
          event: { type: "conversation.item.input_audio_transcription.completed", transcript },
        })
      }
    }
  }

  private handleError(event: BrowserSpeechErrorEvent) {
    // A pause reports `no-speech` and ending the recording reports `aborted`; neither ends the
    // dictation — `onend` follows and the machine restarts a clean end.
    if (event.error === "no-speech" || event.error === "aborted") return

    if (this.state.status === "connecting")
      return this.dispatch({
        type: "step.failed",
        step: "starting",
        reason: mapRecognitionError(event.error),
      })

    if (this.state.status === "live") return this.dispatch({ type: "recognition.error" })
  }

  private releaseRecognition() {
    const recognition = this.recognition
    this.recognition = undefined
    if (recognition) {
      recognition.onstart = null
      recognition.onresult = null
      recognition.onerror = null
      recognition.onend = null
      try {
        recognition.abort()
      } catch {
        // Already stopped: nothing left to abort.
      }
    }
    this.dispatch({ type: "recognition.released" })
  }
}
