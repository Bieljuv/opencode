/**
 * Conexões da conta do cliente (GitHub, Vercel, Supabase) para publicar o
 * projeto dele. Os nomes são os dos serviços — aparecem na tela por ordem
 * do Gabriel (2026-11-12): são as contas do cliente, não do aplicativo.
 * O token nunca chega aqui: o painel pede e o processo principal valida
 * e guarda; o que a tela conhece é só o estado.
 */

export const CONNECTION_PROVIDERS = ["github", "vercel", "supabase"] as const

export type ConnectionProvider = (typeof CONNECTION_PROVIDERS)[number]

export type ConnectionPermission = "allow" | "ask" | "block"

export interface ConnectionStatus {
  readonly provider: ConnectionProvider
  readonly connected: boolean
  readonly login?: string
  readonly permission: ConnectionPermission
}

export function connectionDisplayName(provider: ConnectionProvider): string {
  if (provider === "github") return "GitHub"
  if (provider === "vercel") return "Vercel"
  return "Supabase"
}
