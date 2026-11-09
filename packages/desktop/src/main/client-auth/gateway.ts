import { SidecarCredentials } from "../service/sidecar-credentials"

/**
 * ManosTech gateway, lado do processo principal. O main é o único que vê
 * a chave API do cliente: ele a guarda, a entrega ao servidor (sidecar)
 * como credencial da integração `manostech` e a usa para consultar o uso
 * diário no painel. O renderer nunca recebe a chave — só um booleano
 * (gateway ativo) e o uso já agregado (percentual + reset).
 *
 * Ativação (tudo tem que valer): a flag `manostech-gateway` ligada no
 * servidor, a chave API guardada e a URL do gateway reportada pelo painel.
 * O main não lê a flag — ela vive no servidor — então `connected` é o
 * proxy observável: o sidecar só aceita a credencial quando a flag ligou
 * o plugin e a integração existe. Sem conexão, o gateway fica inativo e
 * o app não muda nada. Fail-open sempre: falha aqui nunca mostra erro.
 */

/** A ativação do gateway, como função pura: flag × chave × URL. */
export function isGatewayActive(input: {
  readonly connected: boolean
  readonly apiKey: string | undefined
  readonly gatewayUrl: string | undefined
}): boolean {
  return input.connected && input.apiKey !== undefined && input.gatewayUrl !== undefined
}

/** Precedência da baseURL: URL do painel > env > default do pacote. */
export function resolveGatewayBaseUrl(input: {
  readonly panelUrl: string | undefined
  readonly env: Record<string, string | undefined>
  readonly fallback: string
}): string {
  return input.panelUrl ?? input.env.MANOSTECH_GATEWAY_URL ?? input.fallback
}

/** O dia atual em America/Sao_Paulo, `AAAA-MM-DD` — o aviso dos 85% vale um dia. */
export function todayInSaoPaulo(nowMs: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowMs))
}

async function sidecarClient() {
  const sidecar = SidecarCredentials.get()

  if (!sidecar) return undefined

  const { OpenCode } = await import("@opencode/client/promise")
  const authorization = SidecarCredentials.authorization(sidecar, sidecar.url)

  return OpenCode.make({
    baseUrl: sidecar.url,
    ...(authorization ? { headers: { Authorization: authorization } } : {}),
  })
}

/**
 * Conecta a chave do cliente como credencial da integração `manostech` no
 * servidor, com a URL do gateway como resposta do formulário (o plugin a
 * lê como metadado da credencial e aplica como baseURL do provedor). Sem
 * reiniciar o servidor e sem tocar no opencode.json do usuário.
 */
export async function connectGatewayCredential(apiKey: string, gatewayUrl: string): Promise<boolean> {
  try {
    const client = await sidecarClient()

    if (!client) return false

    await client.integration.connect.key({
      integrationID: "manostech",
      key: apiKey,
      answer: { gatewayUrl },
    })

    return true
  } catch {
    return false
  }
}

/** Remove a credencial do gateway no servidor (logout): sem ela, o provedor some do pool. */
export async function disconnectGatewayCredential(): Promise<void> {
  try {
    const client = await sidecarClient()

    if (!client) return

    const integration = (await client.integration.get({ integrationID: "manostech" })).data

    for (const connection of integration.connections ?? []) {
      if (connection.type !== "credential") continue

      await client.credential.remove({ credentialID: connection.id }).catch(() => undefined)
    }
  } catch {
    // Sair é local: o servidor só é avisado quando alcança.
  }
}
