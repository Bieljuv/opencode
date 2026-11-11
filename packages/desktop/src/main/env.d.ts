interface ImportMetaEnv {
  readonly OPENCODE_CHANNEL: string
  readonly OPENCODE_VERSION?: string
  /** Baked at build time from MANOSTECH_GOOGLE_CLIENT_ID; empty until the Client ID exists. */
  readonly MANOSTECH_GOOGLE_CLIENT_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
