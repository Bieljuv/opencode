/**
 * What the user sees for a connector or MCP server name. Internal server ids
 * can carry the upstream product name, which must never reach a user-visible
 * surface: it reads as the product's own name instead. Anything else stays
 * verbatim — renaming a connector the user configured themselves would
 * mislabel their own setup, so only the known internal name is masked.
 */
export function maskConnectorDisplayName(name: string): string {
  return name.replace(/opencode/gi, "ManosTech.AI")
}
