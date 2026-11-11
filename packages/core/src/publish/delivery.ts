export * as PublishDelivery from "./delivery.js"

/**
 * What kind of thing the project is, so the publish flow never downgrades a
 * system into a demo (REGRA DE OURO do Editor). Detection reads only file
 * names and package.json — never the user's words — and any single system
 * signal wins over everything else.
 */
export type DeliveryType = "sistema" | "site" | "demo"

export interface ProjectFile {
  readonly path: string
  readonly content?: string
}

// A dependency that means the project has a backend, a database, or accounts.
const SYSTEM_DEPENDENCIES = [
  "supabase",
  "@supabase/supabase-js",
  "prisma",
  "@prisma/client",
  "drizzle-orm",
  "kysely",
  "typeorm",
  "sequelize",
  "mongoose",
  "pg",
  "postgres",
  "mysql2",
  "better-sqlite3",
  "sqlite3",
  "next-auth",
  "@auth/core",
  "lucia",
  "clerk",
  "@clerk/nextjs",
  "express",
  "fastify",
  "hono",
  "@hono/node-server",
  "@trpc/server",
  "stripe",
  "mercadopago",
  "socket.io",
  "graphql",
  "apollo-server",
]

// A path that means the project ships a database with its code.
const SYSTEM_PATHS = ["supabase/", "prisma/", "drizzle/", "migrations/", "db/", "server/", "api/"]

const SYSTEM_FILES = ["supabase/config.toml", "schema.prisma", "drizzle.config.ts", "drizzle.config.js"]

function packageJson(files: readonly ProjectFile[]): Record<string, unknown> | undefined {
  const entry = files.find((file) => file.path === "package.json")
  if (!entry?.content) return undefined
  try {
    const parsed: unknown = JSON.parse(entry.content)
    if (!parsed || typeof parsed !== "object") return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

function dependencyNames(pkg: Record<string, unknown>): string[] {
  const names: string[] = []
  for (const key of ["dependencies", "devDependencies"]) {
    const section = pkg[key]
    if (!section || typeof section !== "object") continue
    names.push(...Object.keys(section as Record<string, unknown>))
  }
  return names
}

function hasSystemSignal(files: readonly ProjectFile[]): boolean {
  if (files.some((file) => SYSTEM_FILES.includes(file.path))) return true
  if (files.some((file) => SYSTEM_PATHS.some((prefix) => file.path.startsWith(prefix)))) return true
  if (files.some((file) => file.path.endsWith(".sql"))) return true
  const pkg = packageJson(files)
  if (pkg && dependencyNames(pkg).some((name) => SYSTEM_DEPENDENCIES.includes(name))) return true
  return false
}

/**
 * Identify the delivery type from the project files. A system signal anywhere
 * makes it a system; a web entry point without one makes it a site; anything
 * else is a demo. The order is the rule: never reclassify a system down.
 */
export function detectDelivery(files: readonly ProjectFile[]): DeliveryType {
  if (hasSystemSignal(files)) return "sistema"
  const hasEntry =
    files.some((file) => file.path === "package.json") ||
    files.some((file) => file.path === "index.html") ||
    files.some((file) => file.path.startsWith("src/"))
  return hasEntry ? "site" : "demo"
}
