import type { ModelKey } from "./selection"

type ConnectedProvider = {
  readonly id: string
  readonly models: Readonly<Record<string, { readonly id: string }>>
}

/**
 * The model a new session uses when nothing else is chosen: the server's
 * default when it names a connected model, else the first model of the
 * first connected provider. The server default is how a plugin (or config)
 * steers fresh sessions — the ManosTech gateway sets it to manostech/auto
 * while its credential is connected, so a UI session starts on the gateway
 * instead of the free tier.
 */
export function resolveFallbackModel(
  serverDefault: Pick<ModelKey, "providerID" | "modelID"> | undefined,
  connected: readonly ConnectedProvider[],
): Pick<ModelKey, "providerID" | "modelID"> | undefined {
  if (
    serverDefault &&
    connected.some(
      (provider) => provider.id === serverDefault.providerID && provider.models[serverDefault.modelID],
    )
  )
    return serverDefault

  return connected.flatMap((provider) => {
    const first = Object.values(provider.models)[0]

    return first ? [{ providerID: provider.id, modelID: first.id }] : []
  })[0]
}
