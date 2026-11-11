/**
 * ManosTech: a exportação de logs a partir da tela de login. Uma transição
 * pura e pequena: o botão chama a mesma exportação que o menu e a página de
 * erro já usam (`platform.exportDebugLogs`), sem exigir sessão — quem está
 * travado no login também precisa mandar os logs. O driver (gate.tsx) roda
 * o efeito e devolve o resultado como evento.
 */

export type ExportLogsState = "idle" | "exporting" | "exported" | "failed"

export type ExportLogsEvent =
  | { readonly type: "export.requested"; readonly available: boolean }
  | { readonly type: "export.succeeded" }
  | { readonly type: "export.failed" }

export type ExportLogsEffect = { readonly type: "do-export" }

export type ExportLogsTransition = {
  readonly state: ExportLogsState
  readonly effects: readonly ExportLogsEffect[]
}

export function transitionExportLogs(state: ExportLogsState, event: ExportLogsEvent): ExportLogsTransition {
  if (event.type === "export.requested") {
    // Um segundo clique enquanto exporta, ou sem exportador, não faz nada:
    // a exportação em andamento já escreve o mesmo zip.
    if (state === "exporting" || !event.available) return { state, effects: [] }

    return { state: "exporting", effects: [{ type: "do-export" }] }
  }

  // Um resultado que chega atrasado (o usuário já exportou de novo) não
  // muda o estado: só vale o da exportação em andamento.
  if (state !== "exporting") return { state, effects: [] }

  if (event.type === "export.succeeded") return { state: "exported", effects: [] }

  return { state: "failed", effects: [] }
}
