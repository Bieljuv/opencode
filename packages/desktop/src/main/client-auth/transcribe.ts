import { Option, Schema } from "effect"

/**
 * ManosTech: transcrição de áudio no gateway do painel. O processo principal é o único
 * que vê a chave API do cliente, então é ele quem posta a fatia no gateway — o renderer
 * grava o áudio e entrega a fatia por IPC, sem nunca receber a chave.
 *
 * O gateway serve a API OpenAI-compatível em /v1 e escolhe o modelo de transcrição — o
 * app nunca nomeia modelo ou provedor. Erros viram só a tag: o detalhe fica no log do
 * main, nunca numa mensagem para o usuário.
 */

const TRANSCRIBE_TIMEOUT_MS = 30_000
const MAX_AUDIO_B64 = 5_000_000 // ~3,7 MB por fatia (fatia de 4 s tem ~40 KB) — igual ao Forge

/** O resultado de uma transcrição: o texto, ou o motivo da falha. */
export type TranscribeAudioResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: "unavailable" | "failed" }

const TranscriptionResponse = Schema.Struct({ text: Schema.String })

/** data:audio/<tipo>;base64,... -> { mimeType, data } (null se inválido) */
export function parseAudioDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const m = /^data:(audio\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec((dataUrl || "").trim())

  if (!m) return null

  return { mimeType: m[1], data: m[2] }
}

/**
 * Transcreve uma fatia de áudio no gateway (POST /v1/audio/transcriptions, multipart,
 * Bearer = chave API do cliente). Devolve '' quando a fatia não tem fala.
 */
export async function transcribeSlice(input: {
  apiKey: string | undefined
  gatewayUrl: string
  audioDataUrl: string
}): Promise<TranscribeAudioResult> {
  if (!input.apiKey) return { ok: false, error: "unavailable" }

  const parsed = parseAudioDataUrl(input.audioDataUrl)

  if (!parsed || parsed.data.length > MAX_AUDIO_B64) return { ok: false, error: "failed" }

  const extension = parsed.mimeType.split("/")[1] ?? "webm"
  const form = new FormData()
  form.append(
    "file",
    new Blob([Buffer.from(parsed.data, "base64")], { type: parsed.mimeType }),
    `audio.${extension}`,
  )
  form.append("language", "pt")

  let response: Response

  try {
    response = await fetch(`${input.gatewayUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${input.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    })
  } catch (error) {
    console.warn("[manostech] transcribe slice failed", error)

    return { ok: false, error: "failed" }
  }

  if (!response.ok) {
    console.warn("[manostech] transcribe slice failed", response.status)

    return { ok: false, error: "failed" }
  }

  const json: unknown = await response.json().catch(() => undefined)
  const decoded = Schema.decodeUnknownOption(TranscriptionResponse)(json)

  if (Option.isNone(decoded)) return { ok: false, error: "failed" }

  return { ok: true, text: decoded.value.text.trim() }
}
