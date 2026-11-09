import type { ClientTranscribeResult } from "../runtime/platform/platform"
import {
  canJoinGatewayDictation,
  createGatewayDictationState,
  GATEWAY_DICTATION_SLICE_MS,
  transitionGatewayDictation,
  type GatewayDictationEffect,
  type GatewayDictationEvent,
} from "./gateway-dictation-machine"
import type { DictationJoinFailure } from "./dictation-machine"
import { DictationFailure, type DictationEngine } from "./dictation-transport"
import type { VoiceEvent } from "./protocol"

/** A recorded slice (a `Blob`) as a data URL, the form the gateway call takes. */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ""))
    reader.onerror = () => reject(new Error("Could not read the audio."))
    reader.readAsDataURL(blob)
  })
}

/**
 * One dictation through the ManosTech gateway: the microphone is recorded in ~4 s slices
 * (Forge 2.96.4, Fase 4 — the mechanism that already worked in the old editor), each slice
 * is sent to the panel gateway for transcription, and the text reaches the composer in real
 * time. The audio is transcribed and discarded; nothing is saved.
 *
 * The gateway holds the shared provider key, so the renderer never sees a key: each slice
 * goes through the main process (`transcribe`), which posts it to the gateway with the
 * client's API key. The transport speaks the same transcript events as the Realtime
 * transport, so the composer cannot tell which engine is behind the microphone.
 * `gateway-dictation-machine.ts` owns its lifecycle.
 */
export class GatewayDictationTransport implements DictationEngine {
  private stream?: MediaStream
  private recorder?: MediaRecorder
  private sliceTimer?: ReturnType<typeof setInterval>
  private finalizeTimer?: ReturnType<typeof setTimeout>
  private joinTimer?: ReturnType<typeof setTimeout>
  private state = createGatewayDictationState()
  private joined = Promise.withResolvers<void>()
  private released = Promise.withResolvers<void>()
  /** The user asked to stop; the recorder's `onstop` must not start another slice. */
  private stopRequested = false
  /** The final slice was produced (the recorder stopped after the stop request). */
  private recorderStopped = false
  /** A recorder is running, or stopped with its `onstop` still pending. */
  private pendingSlice = false
  /** Slices produced but not yet sent for transcription (the data-URL conversion is async). */
  private pendingSlices = 0
  /** Slices sent for transcription and not yet answered, in spoken order. */
  private inFlight = 0
  /** Transcriptions run in spoken order: each slice waits for the previous one. */
  private chain: Promise<void> = Promise.resolve()

  constructor(
    private readonly inputOptions: {
      event: (event: VoiceEvent) => void
      failed: (reason: DictationJoinFailure) => void
      transcribe: (audioDataUrl: string) => Promise<ClientTranscribeResult>
    },
  ) {}

  join() {
    if (!canJoinGatewayDictation(this.state)) return Promise.reject(new DictationFailure("connection"))
    this.dispatch({ type: "join" })

    return this.joined.promise
  }

  /** Settles once the in-flight transcriptions are done (or the finalize timeout fires). */
  close() {
    this.dispatch({ type: "close" })

    return this.released.promise
  }

  private dispatch(event: GatewayDictationEvent) {
    const next = transitionGatewayDictation(this.state, event)
    // Set first: an effect's callback may close this transport again.
    this.state = next.state
    next.effects.forEach((effect) => this.perform(effect))
  }

  private perform(effect: GatewayDictationEffect) {
    if (effect.type === "join.timer.start") {
      this.joinTimer = setTimeout(() => this.dispatch({ type: "join.timeout" }), effect.ms)

      return
    }

    if (effect.type === "join.timer.clear") return clearTimeout(this.joinTimer)

    if (effect.type === "acquire.mic") {
      void this.acquireMic()

      return
    }

    if (effect.type === "start.recorder") return this.startRecorder()

    if (effect.type === "stop.recording") return this.stopRecording()

    if (effect.type === "transcribe.slice") {
      this.enqueueTranscription(effect.audio)

      return
    }

    if (effect.type === "forward.event") return this.inputOptions.event(effect.event)

    if (effect.type === "join.resolve") return this.joined.resolve()

    if (effect.type === "join.reject") return this.joined.reject(new DictationFailure(effect.reason))

    if (effect.type === "notify.failed") return this.inputOptions.failed(effect.reason)

    if (effect.type === "finalize.timer.start") {
      this.finalizeTimer = setTimeout(() => this.dispatch({ type: "finalize.timeout" }), effect.ms)

      return
    }

    if (effect.type === "finalize.timer.clear") return clearTimeout(this.finalizeTimer)

    if (effect.type === "release.media") return this.releaseMedia()

    this.released.resolve()
  }

  private async acquireMic() {
    if (typeof MediaRecorder === "undefined")
      return this.dispatch({ type: "mic.failed", reason: "unavailable" })

    let stream: MediaStream

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      })
    } catch {
      return this.dispatch({ type: "mic.failed", reason: "microphone" })
    }

    // A permission granted after close must not keep the microphone on.
    if (this.state.status !== "connecting") return stream.getTracks().forEach((track) => track.stop())

    // Probe the recorder now: a constructor that throws here means this browser cannot
    // record at all, and the stream is released before the join fails.
    let recorder: MediaRecorder

    try {
      recorder = new MediaRecorder(stream)
    } catch {
      stream.getTracks().forEach((track) => track.stop())
      return this.dispatch({ type: "mic.failed", reason: "unavailable" })
    }

    this.stream = stream
    this.attachRecorder(recorder)
    this.dispatch({ type: "mic.ready" })
  }

  /** Starts the slice recorder and the 4 s slice timer. */
  private startRecorder() {
    const recorder = this.recorder

    if (!recorder) return

    try {
      recorder.start()
    } catch {
      // The constructor probe already passed; a start failure means the stream died.
      if (this.sliceTimer) clearInterval(this.sliceTimer)
      this.sliceTimer = undefined

      return
    }
    this.pendingSlice = true
    this.sliceTimer = setInterval(() => {
      if (this.state.status !== "live") return
      if (this.recorder?.state === "recording") this.recorder.stop()
    }, GATEWAY_DICTATION_SLICE_MS)
  }

  /** Starts the next slice recorder on the same microphone. */
  private startSliceRecorder() {
    const stream = this.stream

    if (!stream) return

    let recorder: MediaRecorder

    try {
      recorder = new MediaRecorder(stream)
    } catch {
      // The first recorder already proved the constructor works; a failure here means the
      // stream died. Stop slicing and wait for the user to stop the recording.
      if (this.sliceTimer) clearInterval(this.sliceTimer)
      this.sliceTimer = undefined

      return
    }

    this.attachRecorder(recorder)

    try {
      recorder.start()
      this.pendingSlice = true
    } catch {
      if (this.sliceTimer) clearInterval(this.sliceTimer)
      this.sliceTimer = undefined
    }
  }

  private attachRecorder(recorder: MediaRecorder) {
    this.recorder = recorder
    const chunks: Blob[] = []
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data)
    }
    recorder.onstop = () => {
      this.pendingSlice = false
      const slice = new Blob(chunks, { type: recorder.mimeType || "audio/webm" })
      if (slice.size > 0) {
        this.pendingSlices++
        void this.sliceReady(slice)
      }

      if (this.stopRequested) {
        this.recorderStopped = true
        this.maybeSettle()

        return
      }

      // The microphone went away: stop slicing, keep the recording live until the user
      // stops it — restarting on a dead stream would spin empty slices forever.
      if (!this.stream?.getAudioTracks().some((track) => track.readyState === "live")) {
        if (this.sliceTimer) clearInterval(this.sliceTimer)
        this.sliceTimer = undefined

        return
      }

      this.startSliceRecorder()
    }
  }

  private async sliceReady(slice: Blob) {
    const audio = await blobToDataUrl(slice).catch(() => "")
    this.pendingSlices--

    if (audio) this.dispatch({ type: "slice.ready", audio })
    this.maybeSettle()
  }

  /** Stops the slice timer and the current recorder; its `onstop` yields the final slice. */
  private stopRecording() {
    this.stopRequested = true
    if (this.sliceTimer) clearInterval(this.sliceTimer)
    this.sliceTimer = undefined

    const recorder = this.recorder

    if (recorder && recorder.state === "recording") {
      try {
        recorder.stop()
      } catch {
        this.recorderStopped = true
        this.maybeSettle()
      }

      return
    }

    // No recorder running. When a slice is still pending its `onstop` settles this; only
    // when nothing is pending is the chain already drained.
    if (!this.pendingSlice) {
      this.recorderStopped = true
      this.maybeSettle()
    }
  }

  private enqueueTranscription(audio: string) {
    this.inFlight++
    this.chain = this.chain.then(() => this.transcribeSlice(audio)).catch(() => undefined)
  }

  private async transcribeSlice(audio: string) {
    try {
      let result: ClientTranscribeResult

      try {
        result = await this.inputOptions.transcribe(audio)
      } catch {
        result = { ok: false, error: "failed" }
      }

      if (!result.ok)
        this.dispatch({
          type: "slice.failed",
          reason: result.error === "unavailable" ? "unavailable" : "transcription",
        })
      else this.dispatch({ type: "slice.transcribed", text: result.text })
    } finally {
      this.inFlight--
      this.maybeSettle()
    }
  }

  /** Settles the close once the final slice was produced and the chain drained. */
  private maybeSettle() {
    if (this.state.status !== "finalizing") return
    if (!this.recorderStopped) return
    if (this.pendingSlices > 0) return
    if (this.inFlight > 0) return
    this.dispatch({ type: "transcriptions.settled" })
  }

  private releaseMedia() {
    if (this.sliceTimer) clearInterval(this.sliceTimer)
    if (this.joinTimer) clearTimeout(this.joinTimer)
    if (this.finalizeTimer) clearTimeout(this.finalizeTimer)
    this.sliceTimer = undefined
    this.joinTimer = undefined
    this.finalizeTimer = undefined
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = undefined
    this.recorder = undefined
  }
}
