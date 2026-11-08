import type { OpenCodeClient } from "@opencode/client/promise"
import { uuid } from "@opencode/util/uuid"
import { decodeEvent, type VoiceEvent } from "./protocol"
import {
  canJoinDictationTransport,
  createDictationTransportState,
  isAcquiringMicDictationTransport,
  transitionDictationTransport,
  type DictationJoinFailure,
  type DictationTransportEffect,
  type DictationTransportEvent,
} from "./dictation-machine"

export class DictationFailure extends Error {
  constructor(readonly reason: DictationJoinFailure | "dropped") {
    super(reason)
  }
}

/** What the composer button drives: either dictation engine joins, records and closes the same way. */
export interface DictationEngine {
  join(): Promise<void>
  close(): Promise<void>
}

/** The Realtime model that transcribes; the session never speaks or acts. */
export const DICTATION_MODEL = "gpt-realtime-2.1"

/**
 * A transcription-only Realtime session: text modalities so nothing speaks back, server-side
 * voice-activity detection that never answers, and Portuguese transcription.
 */
const DICTATION_SESSION = {
  modalities: ["text"],
  instructions: "Transcribe the user's speech. Do not respond.",
  input_audio_transcription: { model: "gpt-4o-mini-transcribe", language: "pt" },
  turn_detection: { type: "server_vad", create_response: false },
}

/** One dictation of a WebRTC transcription session; `dictation-machine.ts` owns its lifecycle. */
export class DictationTransport implements DictationEngine {
  private readonly abort = new AbortController()
  private peer = new RTCPeerConnection({ iceServers: [], bundlePolicy: "max-bundle", rtcpMuxPolicy: "require" })
  private channel = this.peer.createDataChannel("oai-events", { negotiated: true, id: 4, ordered: true })
  private sender = this.peer.addTransceiver("audio", { direction: "sendonly" }).sender
  private state = createDictationTransportState()
  private joined = Promise.withResolvers<void>()
  private released = Promise.withResolvers<void>()
  private stream?: MediaStream
  private joinTimer?: ReturnType<typeof setTimeout>
  private closeTimer?: ReturnType<typeof setTimeout>

  constructor(
    private readonly inputOptions: {
      voice: OpenCodeClient["experimental"]["voice"]
      event: (event: VoiceEvent) => void
      dropped: () => void
    },
  ) {
    this.channel.onmessage = (message: MessageEvent<string>) => {
      const event = decodeEvent(message.data)

      if (event) this.dispatch({ type: "channel.message", event })
    }

    this.channel.onclose = () => this.dispatch({ type: "channel.closed" })
    this.peer.onicegatheringstatechange = () => {
      if (this.peer.iceGatheringState === "complete") this.dispatch({ type: "ice.complete" })
    }

    this.peer.onconnectionstatechange = () => this.dispatch({ type: "peer.state", state: this.peer.connectionState })
  }

  /** Aborts once the transport starts closing. */
  get signal() {
    return this.abort.signal
  }

  join() {
    if (!canJoinDictationTransport(this.state)) return Promise.reject(new DictationFailure("connection"))
    this.dispatch({ type: "join" })

    return this.joined.promise
  }

  /** Settles once the peer connection and audio are released. */
  close() {
    this.dispatch({ type: "close" })

    return this.released.promise
  }

  private dispatch(event: DictationTransportEvent) {
    const next = transitionDictationTransport(this.state, event)
    // Set first: an effect's callback may close this transport again.
    this.state = next.state
    next.effects.forEach((effect) => this.perform(effect))
  }

  private perform(effect: DictationTransportEffect) {
    if (effect.type === "join.timer.start") {
      this.joinTimer = setTimeout(() => this.dispatch({ type: "join.timeout" }), effect.ms)

      return
    }

    if (effect.type === "join.timer.clear") return clearTimeout(this.joinTimer)

    if (effect.type === "prepare.offer") {
      void this.prepareOffer().catch(() => this.dispatch({ type: "step.failed", step: "offer", reason: "connection" }))

      return
    }

    if (effect.type === "negotiate") {
      void this.negotiate().catch(() =>
        this.dispatch({ type: "step.failed", step: "negotiating", reason: "connection" }),
      )

      return
    }

    if (effect.type === "acquire.mic") {
      void this.acquireMic().catch(() => this.dispatch({ type: "step.failed", step: "mic", reason: "connection" }))

      return
    }

    if (effect.type === "stop.media") {
      this.stream?.getTracks().forEach((track) => track.stop())
      this.peer.onicegatheringstatechange = null
      this.abort.abort()

      return
    }

    if (effect.type === "close.handshake.start") {
      this.closeTimer = setTimeout(() => this.dispatch({ type: "close.timeout" }), effect.ms)
      // A channel that is already closing throws; its close event is on the way, so settle now.
      void Promise.resolve()
        .then(() => this.channel.send(JSON.stringify({ type: "session.close", event_id: uuid() })))
        .catch(() => this.dispatch({ type: "channel.closed" }))

      return
    }

    if (effect.type === "close.timer.clear") return clearTimeout(this.closeTimer)

    if (effect.type === "release.peer") {
      this.channel.onmessage = null
      this.channel.onclose = null
      this.peer.onconnectionstatechange = null
      this.peer.close()
      this.dispatch({ type: "peer.released" })

      return
    }

    if (effect.type === "forward.event") return this.inputOptions.event(effect.event)

    if (effect.type === "join.resolve") return this.joined.resolve()

    if (effect.type === "join.reject") return this.joined.reject(new DictationFailure(effect.reason))

    if (effect.type === "notify.dropped") return this.inputOptions.dropped()

    this.released.resolve()
  }

  private async prepareOffer() {
    const offered = await this.inputOptions.voice.models({ signal: this.abort.signal })

    if (
      !offered.models.some(
        (model) => model.model.startsWith("gpt-realtime") && model.available && model.transports.includes("webrtc"),
      )
    )
      return this.dispatch({ type: "step.failed", step: "offer", reason: "unavailable" })

    await this.peer.setLocalDescription(await this.peer.createOffer())
    this.dispatch({ type: "offer.ready", iceComplete: this.peer.iceGatheringState === "complete" })
  }

  private async negotiate() {
    const response = await this.inputOptions.voice.session(
      {
        model: DICTATION_MODEL,
        session: DICTATION_SESSION,
        transport: { type: "webrtc", sdp: this.peer.localDescription!.sdp, dcid: 4 },
      },
      { signal: this.abort.signal },
    )

    if (response.transport.type !== "webrtc")
      return this.dispatch({ type: "step.failed", step: "negotiating", reason: "connection" })
    await this.peer.setRemoteDescription({ type: "answer", sdp: response.transport.sdp })
    this.dispatch({ type: "answer.applied" })
  }

  private async acquireMic() {
    const stream = await navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false })
      .catch(() => undefined)

    if (!stream) return this.dispatch({ type: "step.failed", step: "mic", reason: "microphone" })

    // A permission granted after End or the join timeout must not keep the microphone on.
    if (!isAcquiringMicDictationTransport(this.state)) return stream.getTracks().forEach((track) => track.stop())

    this.stream = stream
    await this.sender.replaceTrack(stream.getAudioTracks()[0])
    this.dispatch({ type: "mic.ready" })
  }
}
