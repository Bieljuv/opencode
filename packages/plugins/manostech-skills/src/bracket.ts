/**
 * bracket.ts: the tournament state machine behind /arena, in TypeScript.
 *
 * A port of the Arena skill's bracket.py (Python 3.8+, standard library only).
 * The whole arena lives in one JSON file (arena.json), so the orchestrator never
 * loses track of who is alive, who fought whom and what happens next, even if its
 * own context gets compacted halfway through a 100-agent run.
 *
 *     runArena(["plan", "--agents", "100"], { cwd })   // rounds, calls, waves. Writes nothing.
 *     runArena(["init", "--agents", "100", "--seed", "7", "--task-file", "task.md"], { cwd })
 *     runArena(["next"], { cwd })                      // what to do now, and the exact command for it
 *     runArena(["prompts", "spawn"], { cwd })          // write the sub-agent briefs, list the jobs left
 *     runArena(["check", "spawn"], { cwd })            // which outputs are still missing
 *     runArena(["pairings"], { cwd })                  // this round's matches, including the bye
 *     runArena(["collect"], { cwd })                   // read every judge verdict and record the winners
 *     runArena(["record", "r1-m01", "a003", "--reason", "..."], { cwd })
 *     runArena(["advance"], { cwd })                   // close the round, eliminate the losers, pair the survivors
 *     runArena(["status"], { cwd })                    // alive and eliminated, per round
 *     runArena(["winner"], { cwd })                    // the survivor, what it beat, the attacks it survived
 *     runArena(["card", "a003"], { cwd })              // one competitor's strategy card
 *
 * Phases, in order: spawn, then per round attack, defend, judge; then final (only when
 * there is a rejected answer to beat). Every command takes --dir; without it, the run
 * named in .arena/LATEST is used.
 *
 * SEEDS ARE NOT COMPATIBLE WITH THE PYTHON VERSION. Python seeds its Mersenne Twister
 * from the seed string; this port seeds a mulberry32 PRNG from a FNV-1a hash of the
 * same label ("arena-deal:<seed>", "arena-pair:<seed>:<round>", "arena-final:<seed>").
 * A seed is reproducible inside this TypeScript version (same seed + same
 * strategies.json = same cards and pairings), but it deals different cards than
 * Python would for the same seed. Every guarantee of the Python dealer is kept:
 * no card is dealt twice, every reasoning mode, workflow and strategy is dealt as
 * evenly as possible, and while the pool is small enough no two agents share a
 * reasoning mode and a workflow, a reasoning mode and a strategy, or a workflow
 * and a strategy.
 *
 * Other deliberate divergences from bracket.py, all forced by the new runtime:
 * - The printed command hints say `arena <command>` instead of
 *   `python3 "<path to bracket.py>" <command>`: there is no Python and no CLI
 *   script in the packaged server; the `arena` tool is what runs these commands.
 * - arena.json is written with JSON.stringify instead of Python's json.dump, so
 *   non-ASCII text stays UTF-8 instead of \uXXXX escapes. The parsed JSON is
 *   identical; only the bytes differ.
 * - Python's round(x, 2) is round-half-even; weightedTotal reproduces that.
 * - A corrupt arena.json raises ArenaError here instead of Python's raw JSON error.
 * - `plan` validates --wave >= 1; Python divides by zero there instead.
 */
import { randomInt } from "node:crypto"
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import skillMd from "../skills/arena/SKILL.md" with { type: "text" }
import strategiesJson from "../skills/arena/strategies.json" with { type: "json" }
import rubricMd from "../skills/arena/rubric.md" with { type: "text" }

export class ArenaError extends Error {}

const DEFAULT_AGENTS = 20 // the editor's default: simple tasks run fewer, complex ones more
const QUICK_AGENTS = 16
const DEFAULT_WAVE = 10 // the agent runs at most 10 sub-agents at once by default
const ROOT = ".arena"
const LATEST = "LATEST"
const STATE_FILE = "arena.json"
const PHASES = ["spawn", "attack", "defend", "judge", "final"] as const
const TEMPLATES = ["competitor", "attacker", "defender", "judge", "final"] as const
const CALLS_PER_MATCH = 5 // 2 attacks, 2 defenses, 1 judge

// Mirrors the table in rubric.md.
const WEIGHTS: Array<readonly [string, number]> = [
  ["correctness", 30],
  ["completeness", 25],
  ["specificity", 15],
  ["robustness", 20],
  ["clarity", 10],
]

export type Phase = (typeof PHASES)[number]
export type TemplateName = (typeof TEMPLATES)[number]

export interface CardPart {
  id: string
  name: string
  how: string
}

export interface Card {
  reasoning: CardPart
  workflow: CardPart
  strategy: CardPart
}

export interface StrategyData {
  reasoning: CardPart[]
  workflows: CardPart[]
  strategies: CardPart[]
}

export interface AgentState {
  card: Card
  solution: string
  alive: boolean
  eliminated_in: number | null
  eliminated_by: string | null
  byes: number
}

export interface Match {
  id: string
  a: string
  b: string
  winner: string | null
  loser: string | null
  reason: string | null
  survived: string[]
  scores: Record<string, number | null> | null
  source: string | null
}

export interface RoundState {
  n: number
  alive: string[]
  matches: Match[]
  bye: string | null
  closed: boolean
}

export interface FinalResult {
  better: string
  champion_total: number | null
  baseline_total: number | null
  reason: string
  fixed: string[]
}

export interface FinalState {
  X: string
  Y: string
  result: FinalResult | null
}

export interface ArenaState {
  version: number
  created: string
  seed: number
  agents_n: number
  cards_available: number
  wave: number
  dir: string
  has_baseline: boolean
  agents: Record<string, AgentState>
  rounds: RoundState[]
  champion: string | null
  final: FinalState | null
}

export interface Job {
  id: string
  kind: TemplateName
  round: number | null
  agent?: string
  opponent?: string
  match?: string
  a?: string
  b?: string
  outputs: string[]
  prompt: string
}

export interface CollectEntry {
  id: string
  status: "recorded" | "missing" | "unreadable"
  note: string
}

export interface DecideResult {
  winner: string
  totals: Record<string, number | null>
  note: string
}

export interface PlanRow {
  round: number
  alive: number
  matches: number
  bye: number
  calls: number
  waves: number
}

export interface PlanTotals {
  agents: number
  rounds: number
  calls: number
  waves: number
  rows: PlanRow[]
}

// ---------------------------------------------------------------- helpers

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i)
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}

function pad(value: string | number, width: number): string {
  return String(value).padStart(width)
}

function padEnd(value: string, width: number): string {
  return value.padEnd(width)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function twoDigits(n: number): string {
  return String(n).padStart(2, "0")
}

function formatTimestamp(date: Date): string {
  return `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())} ${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}:${twoDigits(date.getSeconds())}`
}

function formatRunTimestamp(date: Date): string {
  return `${date.getFullYear()}${twoDigits(date.getMonth() + 1)}${twoDigits(date.getDate())}-${twoDigits(date.getHours())}${twoDigits(date.getMinutes())}${twoDigits(date.getSeconds())}`
}

/** Python "%g": up to 6 significant digits, no trailing zeros. */
function fmtG(x: number): string {
  if (x === 0) return "0"
  return String(Number(x.toPrecision(6)))
}

function fmtScore(x: number | null | undefined): string {
  return x === null || x === undefined ? "?" : fmtG(x)
}

/** Round-half-even to 2 decimals, like Python's round(x, 2). */
function round2(x: number): number {
  const scaled = x * 100
  const floor = Math.floor(scaled)
  const diff = scaled - floor
  if (diff > 0.5) return (floor + 1) / 100
  if (diff < 0.5) return floor / 100
  return (floor % 2 === 0 ? floor : floor + 1) / 100
}

async function hasOutput(file: string): Promise<boolean> {
  return stat(file).then(
    (s) => s.size > 0,
    () => false,
  )
}

async function readText(file: string): Promise<string> {
  return readFile(file, "utf8").catch((error: unknown) => {
    throw new ArenaError(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`)
  })
}

// ---------------------------------------------------------------- the PRNG

/** FNV-1a, 32-bit. Turns a seed label into a mulberry32 seed. */
function hashSeed(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Small fast seeded PRNG (mulberry32). Deterministic per label, not Python's random. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function seededRandom(label: string): () => number {
  return mulberry32(hashSeed(label))
}

function shuffle<T>(items: T[], rand: () => number): T[] {
  const arr = [...items]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const tmp = arr[i]
    arr[i] = arr[j]
    arr[j] = tmp
  }
  return arr
}

// ---------------------------------------------------------------- the cards

export function loadStrategies(): StrategyData {
  const data: unknown = strategiesJson
  if (!isRecord(data)) throw new ArenaError("strategies.json is not a JSON object")
  const lists = (["reasoning", "workflows", "strategies"] as const).map((key) => {
    const items: unknown = data[key]
    if (!Array.isArray(items) || items.length === 0) {
      throw new ArenaError(`strategies.json has no '${key}' entries`)
    }
    const ids = items.map((item) => {
      if (!isRecord(item)) throw new ArenaError(`strategies.json entry in '${key}' is not an object`)
      return item["id"]
    })
    if (new Set(ids).size !== ids.length) {
      throw new ArenaError(`strategies.json has a duplicate id in '${key}'`)
    }
    return items.map((item) => {
      if (!isRecord(item) || typeof item["name"] !== "string" || !item["name"] || typeof item["how"] !== "string" || !item["how"]) {
        throw new ArenaError(`strategies.json entry '${String(item["id"])}' needs a name and a how`)
      }
      return { id: String(item["id"]), name: item["name"], how: item["how"] }
    })
  })
  return { reasoning: lists[0], workflows: lists[1], strategies: lists[2] }
}

export function comboCount(data: StrategyData): number {
  return data.reasoning.length * data.workflows.length * data.strategies.length
}

function edgeColour(edges: Array<readonly [number, number]>, k: number): number[] {
  const colour: number[] = Array(edges.length).fill(-1)
  const at: Array<Map<number, Map<number, number>>> = [new Map(), new Map()]

  const slot = (side: number, node: number): Map<number, number> => {
    const existing = at[side].get(node)
    if (existing) return existing
    const created = new Map<number, number>()
    at[side].set(node, created)
    return created
  }
  const put = (e: number, c: number): void => {
    const edge = edges[e]
    colour[e] = c
    slot(0, edge[0]).set(c, e)
    slot(1, edge[1]).set(c, e)
  }
  const take = (e: number): void => {
    const edge = edges[e]
    slot(0, edge[0]).delete(colour[e])
    slot(1, edge[1]).delete(colour[e])
  }
  // Alternating path starting at node on side, alternating colours first/other.
  const walk = (side: number, node: number, first: number, other: number): number[] => {
    const path: number[] = []
    let s = side
    let n = node
    let c = first
    while (true) {
      const e = slot(s, n).get(c)
      if (e === undefined || path.includes(e)) return path
      path.push(e)
      n = edges[e][1 - s]
      s = 1 - s
      c = c === first ? other : first
    }
  }
  const swap = (path: number[], a: number, b: number): void => {
    const next = new Map(path.map((e) => [e, colour[e] === a ? b : a] as const))
    for (const e of path) take(e)
    for (const e of path) put(e, next.get(e) ?? a)
  }

  edges.forEach((edge, e) => {
    const freeU = range(k).filter((c) => !slot(0, edge[0]).has(c))
    const freeV = new Set(range(k).filter((c) => !slot(1, edge[1]).has(c)))
    const found = freeU.find((c) => freeV.has(c))
    if (found !== undefined) {
      put(e, found)
      return
    }
    const a = freeU[0]
    const b = Math.min(...freeV)
    swap(walk(1, edge[1], a, b), a, b)
    put(e, a)
  })

  while (true) {
    const count = Array(k).fill(0)
    for (const c of colour) count[c] += 1
    const hi = range(k).reduce((best, c) => (count[c] > count[best] || (count[c] === count[best] && c < best) ? c : best), 0)
    const lo = range(k).reduce((best, c) => (count[c] < count[best] || (count[c] === count[best] && c < best) ? c : best), 0)
    if (count[hi] - count[lo] <= 1) return colour
    let swapped = false
    for (let side = 0; side < 2 && !swapped; side++) {
      for (const node of [...at[side].keys()].sort((a, b) => a - b)) {
        const s = at[side].get(node)
        if (s && s.has(hi) && !s.has(lo)) {
          const path = walk(side, node, hi, lo)
          if (path.filter((e) => colour[e] === hi).length > path.filter((e) => colour[e] === lo).length) {
            swap(path, hi, lo)
            swapped = true
            break
          }
        }
      }
    }
    if (!swapped) throw new ArenaError("could not balance the strategy cards")
  }
}

export function deal(n: number, seed: number, data: StrategyData): Array<[number, number, number]> {
  const R = data.reasoning.length
  const W = data.workflows.length
  const S = data.strategies.length
  const total = R * W * S
  if (n < 1 || n > total) throw new ArenaError(`can deal between 1 and ${total} cards, not ${n}`)
  const rand = seededRandom(`arena-deal:${seed}`)
  const pr = shuffle(range(R), rand)
  const pw = shuffle(range(W), rand)
  const ps = shuffle(range(S), rand)
  const lcm = (R * W) / gcd(R, W)
  const cells: Array<[number, number]> = range(n).map((i) => [i % R, (i + Math.floor(i / lcm)) % W])
  const degR = Math.max(...range(R).map((x) => cells.filter(([r]) => r === x).length))
  const degW = Math.max(...range(W).map((x) => cells.filter(([, w]) => w === x).length))
  let triples: Array<[number, number, number]>
  if (degR <= S && degW <= S) {
    const order = shuffle(range(n), rand)
    const colours = edgeColour(order.map((i) => cells[i]), S)
    const strategyOf = new Map(order.map((id, j) => [id, colours[j]] as const))
    triples = cells.map(([r, w], i) => [r, w, strategyOf.get(i) ?? 0])
  } else {
    // Past that size a repeat pair is unavoidable. Stay balanced and never repeat a card.
    const count = Array(S).fill(0)
    const pairsRs = new Map<string, number>()
    const pairsWs = new Map<string, number>()
    const used = new Set<string>()
    triples = cells.map(([r, w]) => {
      const low = Math.min(...count)
      const keyOf = (c: number): number[] => [count[c] - low, pairsRs.get(`${r},${c}`) ?? 0, pairsWs.get(`${w},${c}`) ?? 0, c]
      const best = range(S)
        .filter((c) => !used.has(`${r},${w},${c}`))
        .reduce((bestC, c) => {
          const key = keyOf(c)
          const bestKey = keyOf(bestC)
          const smaller = key.findIndex((v, i) => v !== bestKey[i])
          return smaller !== -1 && key[smaller] < bestKey[smaller] ? c : bestC
        })
      used.add(`${r},${w},${best}`)
      count[best] += 1
      pairsRs.set(`${r},${best}`, (pairsRs.get(`${r},${best}`) ?? 0) + 1)
      pairsWs.set(`${w},${best}`, (pairsWs.get(`${w},${best}`) ?? 0) + 1)
      return [r, w, best]
    })
  }
  const dealt: Array<[number, number, number]> = triples.map(([r, w, s]) => [pr[r], pw[w], ps[s]])
  return shuffle(dealt, rand)
}

export function agentIds(n: number): string[] {
  const width = Math.max(3, String(n).length)
  return range(n).map((i) => `a${String(i + 1).padStart(width, "0")}`)
}

export function bracketSizes(n: number): number[] {
  const sizes = [n]
  while (sizes[sizes.length - 1] > 1) {
    sizes.push(Math.floor((sizes[sizes.length - 1] + 1) / 2))
  }
  return sizes
}

// ---------------------------------------------------------------- paths

export function spawnOut(d: string, aid: string): string {
  return path.join(d, "r0", `${aid}.md`)
}

export function attackOut(d: string, rnd: number, mid: string, attacker: string): string {
  return path.join(d, `r${rnd}`, `${mid}.${attacker}.attack.md`)
}

export function defenseOut(d: string, rnd: number, mid: string, aid: string): string {
  return path.join(d, `r${rnd}`, `${mid}.${aid}.defense.md`)
}

export function revisedOut(d: string, rnd: number, mid: string, aid: string): string {
  return path.join(d, `r${rnd}`, `${mid}.${aid}.solution.md`)
}

export function verdictOut(d: string, rnd: number, mid: string): string {
  return path.join(d, `r${rnd}`, `${mid}.verdict.json`)
}

export function finalOut(d: string): string {
  return path.join(d, "final.verdict.json")
}

export function promptPath(d: string, rnd: number | null, jobId: string): string {
  const sub = rnd === null ? "final" : `r${rnd}`
  return path.join(d, "prompts", sub, `${jobId}.md`)
}

// ---------------------------------------------------------------- the bracket

export function newState(
  n: number,
  seed: number,
  data: StrategyData,
  runDir: string,
  wave: number = DEFAULT_WAVE,
  hasBaseline: boolean = false,
): ArenaState {
  const dir = path.resolve(runDir)
  const ids = agentIds(n)
  const dealt = deal(n, seed, data)
  const agents: Record<string, AgentState> = {}
  ids.forEach((aid, i) => {
    const triple = dealt[i]
    agents[aid] = {
      card: {
        reasoning: { ...data.reasoning[triple[0]] },
        workflow: { ...data.workflows[triple[1]] },
        strategy: { ...data.strategies[triple[2]] },
      },
      solution: spawnOut(dir, aid),
      alive: true,
      eliminated_in: null,
      eliminated_by: null,
      byes: 0,
    }
  })
  const state: ArenaState = {
    version: 1,
    created: formatTimestamp(new Date()),
    seed,
    agents_n: n,
    cards_available: comboCount(data),
    wave,
    dir,
    has_baseline: hasBaseline,
    agents,
    rounds: [],
    champion: null,
    final: null,
  }
  openRound(state, ids)
  return state
}

export function pairRound(state: ArenaState, rnd: number, alive: string[]): { matches: Match[]; bye: string | null } {
  const agents = state.agents
  const rand = seededRandom(`arena-pair:${state.seed}:${rnd}`)
  const pool = shuffle([...alive].sort(), rand)
  let bye: string | null = null
  if (pool.length % 2 === 1) {
    const fewest = Math.min(...pool.map((a) => agents[a].byes))
    const byeIndex = pool.findIndex((a) => agents[a].byes === fewest)
    bye = pool.splice(byeIndex, 1)[0]
  }
  const width = Math.max(2, String(Math.floor(pool.length / 2)).length)
  const matches: Match[] = []
  while (pool.length > 0) {
    let a = pool.shift() as string
    const mode = agents[a].card.reasoning.id
    const j = pool.findIndex((b) => agents[b].card.reasoning.id !== mode)
    let b = pool.splice(j === -1 ? 0 : j, 1)[0]
    if (rand() < 0.5) {
      const tmp = a
      a = b
      b = tmp
    }
    matches.push({
      id: `r${rnd}-m${String(matches.length + 1).padStart(width, "0")}`,
      a,
      b,
      winner: null,
      loser: null,
      reason: null,
      survived: [],
      scores: null,
      source: null,
    })
  }
  return { matches, bye }
}

export function openRound(state: ArenaState, alive: string[]): RoundState | null {
  const sorted = [...alive].sort()
  if (sorted.length === 1) {
    state.champion = sorted[0]
    if (state.has_baseline && !state.final) {
      const rand = seededRandom(`arena-final:${state.seed}`)
      const x = rand() < 0.5 ? "champion" : "baseline"
      state.final = { X: x, Y: x === "champion" ? "baseline" : "champion", result: null }
    }
    return null
  }
  const rnd = state.rounds.length + 1
  const { matches, bye } = pairRound(state, rnd, sorted)
  const rd: RoundState = { n: rnd, alive: sorted, matches, bye, closed: false }
  state.rounds.push(rd)
  return rd
}

export function currentRound(state: ArenaState): RoundState | null {
  if (state.champion || state.rounds.length === 0) return null
  const rd = state.rounds[state.rounds.length - 1]
  return rd.closed ? null : rd
}

export function normAgent(state: ArenaState, raw: string): string {
  const cleaned = String(raw).trim().toLowerCase()
  if (cleaned in state.agents) return cleaned
  const digits = cleaned.replace(/^a+/, "")
  if (/^\d+$/.test(digits)) {
    const found = Object.keys(state.agents).find((aid) => Number(aid.slice(1)) === Number(digits))
    if (found) return found
  }
  throw new ArenaError(`no agent called '${raw}'`)
}

export function findMatch(state: ArenaState, mid: string): { round: RoundState; match: Match } {
  const rd = currentRound(state)
  if (rd === null) {
    throw new ArenaError(`no round is open${state.champion ? " (the arena has a champion)" : ""}`)
  }
  const raw = String(mid).trim().toLowerCase()
  const exact = rd.matches.find((m) => m.id === raw)
  if (exact) return { round: rd, match: exact }
  const tail = raw.split("-m").pop()?.replace(/^m+/, "") ?? ""
  if (/^\d+$/.test(tail)) {
    const byNumber = rd.matches.find((m) => Number(m.id.split("-m").pop()) === Number(tail))
    if (byNumber) return { round: rd, match: byNumber }
  }
  throw new ArenaError(`no match '${mid}' in round ${rd.n} (run pairings)`)
}

export function record(
  state: ArenaState,
  mid: string,
  winner: string,
  reason?: string | null,
  survived?: string[] | null,
  scores?: Record<string, number | null> | null,
  source: string = "manual",
): { match: Match; previous: string | null } {
  const { match } = findMatch(state, mid)
  const winnerId = normAgent(state, winner)
  if (winnerId !== match.a && winnerId !== match.b) {
    throw new ArenaError(`${winnerId} is not in ${match.id} (${match.a} vs ${match.b})`)
  }
  const previous = match.winner
  match.winner = winnerId
  match.loser = winnerId === match.a ? match.b : match.a
  match.reason = reason || null
  match.survived = [...(survived ?? [])]
  match.scores = scores ?? null
  match.source = source
  return { match, previous }
}

export async function advance(state: ArenaState): Promise<string[]> {
  const rd = currentRound(state)
  if (rd === null) {
    throw new ArenaError(`no round is open${state.champion ? " (the arena has a champion)" : ""}`)
  }
  const unrecorded = rd.matches.filter((m) => !m.winner).map((m) => m.id)
  if (unrecorded.length > 0) {
    throw new ArenaError(`round ${rd.n} has ${unrecorded.length} unrecorded match(es): ${unrecorded.join(", ")}`)
  }
  const survivors: string[] = []
  for (const m of rd.matches) {
    const loser = state.agents[m.loser as string]
    loser.alive = false
    loser.eliminated_in = rd.n
    loser.eliminated_by = m.winner
    for (const aid of [m.a, m.b]) {
      const rev = revisedOut(state.dir, rd.n, m.id, aid)
      if (await hasOutput(rev)) state.agents[aid].solution = rev
    }
    survivors.push(m.winner as string)
  }
  if (rd.bye) {
    state.agents[rd.bye].byes += 1
    survivors.push(rd.bye)
  }
  rd.closed = true
  openRound(state, survivors)
  return survivors
}

export function roundsPlayed(state: ArenaState): number {
  return state.rounds.filter((rd) => rd.closed).length
}

export function aliveIds(state: ArenaState): string[] {
  return Object.keys(state.agents)
    .filter((a) => state.agents[a].alive)
    .sort()
}

// ---------------------------------------------------------------- verdicts

export function weightedTotal(scores: unknown): number | null {
  if (!isRecord(scores)) return null
  let total = 0
  for (const [key, weight] of WEIGHTS) {
    const v = scores[key]
    if (typeof v === "boolean") return null
    const num = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN
    if (Number.isNaN(num)) return null
    total += Math.max(0, Math.min(10, num)) * weight
  }
  return round2(total / 10)
}

function truthy(v: unknown): boolean {
  if (typeof v === "string") return ["true", "yes", "1"].includes(v.trim().toLowerCase())
  return Boolean(v)
}

export function extractJson(text: string): unknown {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    // fall through to the brace search below
  }
  const i = trimmed.indexOf("{")
  const j = trimmed.lastIndexOf("}")
  if (i !== -1 && j > i) {
    try {
      return JSON.parse(trimmed.slice(i, j + 1))
    } catch {
      return null
    }
  }
  return null
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function decide(verdict: unknown, a: string, b: string): DecideResult {
  if (!isRecord(verdict)) throw new ArenaError("verdict is not a JSON object")
  const rawScores = verdict["scores"]
  const scores: Record<string, unknown> = {}
  if (isRecord(rawScores)) {
    for (const [k, v] of Object.entries(rawScores)) scores[k.trim().toLowerCase()] = v
  }
  const sa = scores[a]
  const sb = scores[b]
  const pickRaw = String(verdict["winner"] ?? "").trim().toLowerCase()
  const inA = new RegExp(`\\b${escapeRegExp(a)}\\b`).test(pickRaw)
  const inB = new RegExp(`\\b${escapeRegExp(b)}\\b`).test(pickRaw)
  const pick = inA && !inB ? a : inB && !inA ? b : null
  const ta = weightedTotal(sa)
  const tb = weightedTotal(sb)
  const totals: Record<string, number | null> = { [a]: ta, [b]: tb }
  if (ta === null || tb === null) {
    if (pick) return { winner: pick, totals, note: "scores incomplete, used the judge's pick" }
    throw new ArenaError("verdict has neither complete scores nor a clear winner")
  }
  const fa = isRecord(sa) ? truthy(sa["fatal"]) : false
  const fb = isRecord(sb) ? truthy(sb["fatal"]) : false
  let winner: string
  if (fa !== fb) {
    winner = fa ? b : a
  } else if (ta !== tb) {
    winner = ta > tb ? a : b
  } else {
    const standingRaw = verdict["standing"]
    const standing: Record<string, unknown> = {}
    if (isRecord(standingRaw)) {
      for (const [k, v] of Object.entries(standingRaw)) standing[k.trim().toLowerCase()] = v
    }
    const standingA = standing[a]
    const standingB = standing[b]
    const na = Array.isArray(standingA) ? standingA.length : null
    const nb = Array.isArray(standingB) ? standingB.length : null
    const ca = isRecord(sa) ? Number(sa["correctness"] ?? 0) : 0
    const cb = isRecord(sb) ? Number(sb["correctness"] ?? 0) : 0
    if (na !== null && nb !== null && na !== nb) {
      winner = na < nb ? a : b
    } else if (ca !== cb) {
      winner = ca > cb ? a : b
    } else if (pick) {
      winner = pick
    } else {
      throw new ArenaError("exact tie and the judge did not pick a winner")
    }
  }
  const note = pick && pick !== winner ? `judge picked ${pick} but its own scores favour ${winner}, so the scores win` : ""
  return { winner, totals, note }
}

export async function collect(state: ArenaState): Promise<CollectEntry[]> {
  const d = state.dir
  const results: CollectEntry[] = []
  if (state.champion) {
    const fin = state.final
    if (!fin || fin.result) return results
    const file = finalOut(d)
    if (!(await hasOutput(file))) return [{ id: "final", status: "missing", note: "" }]
    const v = extractJson(await readText(file))
    try {
      const { winner, totals, note } = decide(v, "x", "y")
      const better = winner === "x" ? fin.X : fin.Y
      fin.result = {
        better,
        champion_total: totals[fin.X === "champion" ? "x" : "y"],
        baseline_total: totals[fin.X === "baseline" ? "x" : "y"],
        reason: String((isRecord(v) ? v["reason"] : "") ?? "").slice(0, 400),
        fixed:
          isRecord(v) && Array.isArray(v["fixed"]) ? v["fixed"].slice(0, 10).map((x) => String(x)) : [],
      }
      return [{ id: "final", status: "recorded", note: `${better} is better. ${note}`.trim() }]
    } catch (error) {
      if (!(error instanceof ArenaError)) throw error
      await rename(file, `${file}.unreadable`)
      return [{ id: "final", status: "unreadable", note: error.message }]
    }
  }
  const rd = currentRound(state)
  if (rd === null) return results
  for (const m of rd.matches) {
    if (m.winner) continue
    const file = verdictOut(d, rd.n, m.id)
    if (!(await hasOutput(file))) {
      results.push({ id: m.id, status: "missing", note: "" })
      continue
    }
    const v = extractJson(await readText(file))
    try {
      const { winner, totals, note } = decide(v, m.a, m.b)
      const survived = isRecord(v) && Array.isArray(v["survived"]) ? v["survived"].slice(0, 10).map((x) => String(x)) : []
      record(state, m.id, winner, isRecord(v) ? String(v["reason"] ?? "").slice(0, 400) : "", survived, totals, "judge")
      const loser = m.loser as string
      const line = `${winner} beat ${loser}, ${fmtScore(totals[winner])} to ${fmtScore(totals[loser])}`
      results.push({ id: m.id, status: "recorded", note: note ? `${line}. ${note}` : line })
    } catch (error) {
      if (!(error instanceof ArenaError)) throw error
      await rename(file, `${file}.unreadable`)
      results.push({ id: m.id, status: "unreadable", note: error.message })
    }
  }
  return results
}

// ---------------------------------------------------------------- jobs and prompts

export function phaseJobs(state: ArenaState, phase: Phase): Job[] {
  if (!PHASES.includes(phase)) throw new ArenaError(`unknown phase '${phase}' (one of: ${PHASES.join(", ")})`)
  const d = state.dir
  const jobs: Array<Omit<Job, "prompt">> = []
  if (phase === "spawn") {
    for (const aid of Object.keys(state.agents).sort()) {
      jobs.push({ id: `${aid}.spawn`, kind: "competitor", round: 0, agent: aid, outputs: [spawnOut(d, aid)] })
    }
  } else if (phase === "final") {
    const fin = state.final
    if (state.champion && fin && !fin.result) {
      jobs.push({ id: "final.judge", kind: "final", round: null, outputs: [finalOut(d)] })
    }
  } else {
    const rd = currentRound(state)
    if (rd === null) return []
    const n = rd.n
    for (const m of rd.matches) {
      if (m.winner) continue
      const a = m.a
      const b = m.b
      if (phase === "attack") {
        for (const [me, opp] of [
          [a, b],
          [b, a],
        ] as const) {
          jobs.push({
            id: `${m.id}.${me}.attack`,
            kind: "attacker",
            round: n,
            agent: me,
            opponent: opp,
            match: m.id,
            outputs: [attackOut(d, n, m.id, me)],
          })
        }
      } else if (phase === "defend") {
        for (const [me, opp] of [
          [a, b],
          [b, a],
        ] as const) {
          jobs.push({
            id: `${m.id}.${me}.defend`,
            kind: "defender",
            round: n,
            agent: me,
            opponent: opp,
            match: m.id,
            outputs: [defenseOut(d, n, m.id, me), revisedOut(d, n, m.id, me)],
          })
        }
      } else {
        jobs.push({
          id: `${m.id}.judge`,
          kind: "judge",
          round: n,
          match: m.id,
          a,
          b,
          outputs: [verdictOut(d, n, m.id)],
        })
      }
    }
  }
  return jobs.map((j) => ({ ...j, prompt: promptPath(d, j.round, j.id) }))
}

export async function missingJobs(jobs: Job[]): Promise<Job[]> {
  const checks = await Promise.all(
    jobs.map(async (j) => ({ job: j, missing: (await Promise.all(j.outputs.map((p) => hasOutput(p)))).some((ok) => !ok) })),
  )
  return checks.filter((c) => c.missing).map((c) => c.job)
}

const TEMPLATE_RE = /<!-- template:([a-z]+) -->\s*```text\n([\s\S]*?)\n```\s*<!-- \/template:\1 -->/g
const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g

export function loadTemplates(): Record<TemplateName, string> {
  const found: Partial<Record<string, string>> = {}
  for (const m of skillMd.matchAll(TEMPLATE_RE)) {
    found[m[1]] = m[2]
  }
  const missing = TEMPLATES.filter((t) => !(t in found))
  if (missing.length > 0) throw new ArenaError(`SKILL.md is missing prompt templates: ${missing.join(", ")}`)
  return found as Record<TemplateName, string>
}

export function fill(template: string, values: Record<string, string | number>): string {
  const wanted = new Set([...template.matchAll(PLACEHOLDER_RE)].map((m) => m[1]))
  const missing = [...wanted].filter((w) => !(w in values)).sort()
  if (missing.length > 0) throw new ArenaError(`no value for placeholder(s): ${missing.join(", ")}`)
  return template.replace(PLACEHOLDER_RE, (_, name: string) => String(values[name]))
}

async function readTask(state: ArenaState): Promise<string> {
  return (await readText(path.join(state.dir, "task.md"))).replace(/\n+$/, "")
}

function cardValues(card: Card): Record<string, string> {
  return {
    reasoning_name: card.reasoning.name,
    reasoning_how: card.reasoning.how,
    workflow_name: card.workflow.name,
    workflow_how: card.workflow.how,
    strategy_name: card.strategy.name,
    strategy_how: card.strategy.how,
  }
}

export function renderJob(state: ArenaState, job: Job, templates: Record<TemplateName, string>, task: string): string {
  const d = state.dir
  const agents = state.agents
  const v: Record<string, string | number> = { task, arena_dir: d, rubric: path.join(d, "rubric.md"), n: state.agents_n }
  const kind = job.kind
  if (kind === "competitor") {
    const aid = job.agent as string
    Object.assign(v, cardValues(agents[aid].card))
    v["baseline_note"] = state.has_baseline
      ? `The user already got an answer to this task and was NOT satisfied with it. It is at ${path.join(d, "baseline.md")}. Read it first and work out exactly why it fell short. Then beat it. Do not just polish it: the winner of this arena is compared with that answer at the end.`
      : "There is no earlier answer to beat. Start from the task."
    v["agent"] = aid
    v["out"] = job.outputs[0]
  } else if (kind === "attacker") {
    const me = job.agent as string
    const opp = job.opponent as string
    Object.assign(v, cardValues(agents[me].card))
    v["agent"] = me
    v["target"] = opp
    v["match"] = job.match as string
    v["round"] = job.round as number
    v["own_solution"] = agents[me].solution
    v["target_solution"] = agents[opp].solution
    v["out"] = job.outputs[0]
  } else if (kind === "defender") {
    const me = job.agent as string
    const opp = job.opponent as string
    Object.assign(v, cardValues(agents[me].card))
    v["agent"] = me
    v["attacker"] = opp
    v["match"] = job.match as string
    v["round"] = job.round as number
    v["own_solution"] = agents[me].solution
    v["attacks"] = attackOut(d, job.round as number, job.match as string, opp)
    v["defense_out"] = job.outputs[0]
    v["solution_out"] = job.outputs[1]
  } else if (kind === "judge") {
    const n = job.round as number
    const mid = job.match as string
    const a = job.a as string
    const b = job.b as string
    v["match"] = mid
    v["round"] = n
    v["first"] = a
    v["second"] = b
    v["first_solution"] = revisedOut(d, n, mid, a)
    v["second_solution"] = revisedOut(d, n, mid, b)
    v["first_attacks"] = attackOut(d, n, mid, b)
    v["second_attacks"] = attackOut(d, n, mid, a)
    v["first_defense"] = defenseOut(d, n, mid, a)
    v["second_defense"] = defenseOut(d, n, mid, b)
    v["out"] = job.outputs[0]
  } else {
    v["rounds"] = roundsPlayed(state)
    v["x_solution"] = path.join(d, "final", "X.md")
    v["y_solution"] = path.join(d, "final", "Y.md")
    v["out"] = job.outputs[0]
  }
  return fill(templates[kind], v)
}

export async function writePrompts(state: ArenaState, phase: Phase): Promise<Job[]> {
  const jobs = phaseJobs(state, phase)
  if (jobs.length === 0) return jobs
  const templates = loadTemplates()
  const task = await readTask(state)
  for (const j of jobs) {
    for (const p of [...j.outputs, j.prompt]) await mkdir(path.dirname(p), { recursive: true })
    const body = renderJob(state, j, templates, task)
    await writeFile(j.prompt, `${body}\n`, "utf8")
  }
  if (phase === "spawn") {
    for (const aid of Object.keys(state.agents)) {
      await mkdir(path.join(state.dir, "scratch", aid), { recursive: true })
    }
  }
  if (phase === "final") {
    const fin = state.final as FinalState
    const sources: Record<string, string> = {
      champion: state.agents[state.champion as string].solution,
      baseline: path.join(state.dir, "baseline.md"),
    }
    await mkdir(path.join(state.dir, "final"), { recursive: true })
    for (const label of ["X", "Y"] as const) {
      const content = await readText(sources[fin[label]])
      await writeFile(path.join(state.dir, "final", `${label}.md`), content, "utf8")
    }
  }
  return jobs
}

export async function nextAction(state: ArenaState): Promise<{ phase: string; left: Job[]; jobs: Job[] }> {
  const spawn = phaseJobs(state, "spawn")
  const left = await missingJobs(spawn)
  if (left.length > 0) return { phase: "spawn", left, jobs: spawn }
  if (state.champion) {
    const fin = state.final
    if (fin && !fin.result) {
      const jobs = phaseJobs(state, "final")
      const missing = await missingJobs(jobs)
      return missing.length > 0 ? { phase: "final", left: missing, jobs } : { phase: "collect", left: [], jobs }
    }
    return { phase: "done", left: [], jobs: [] }
  }
  for (const phase of ["attack", "defend", "judge"] as const) {
    const jobs = phaseJobs(state, phase)
    const missing = await missingJobs(jobs)
    if (missing.length > 0) return { phase, left: missing, jobs }
  }
  const rd = currentRound(state)
  if (rd === null) throw new ArenaError("no round is open")
  if (rd.matches.some((m) => !m.winner)) return { phase: "collect", left: [], jobs: [] }
  return { phase: "advance", left: [], jobs: [] }
}

// ---------------------------------------------------------------- plan

export function planRows(n: number, wave: number = DEFAULT_WAVE): PlanRow[] {
  return bracketSizes(n)
    .slice(0, -1)
    .map((alive, index) => {
      const m = Math.floor(alive / 2)
      const waves = 2 * Math.ceil((2 * m) / wave) + Math.ceil(m / wave)
      return { round: index + 1, alive, matches: m, bye: alive % 2, calls: CALLS_PER_MATCH * m, waves }
    })
}

export function planTotals(n: number, wave: number = DEFAULT_WAVE): PlanTotals {
  const rows = planRows(n, wave)
  const calls = n + rows.reduce((sum, r) => sum + r.calls, 0)
  const waves = Math.ceil(n / wave) + rows.reduce((sum, r) => sum + r.waves, 0)
  return { agents: n, rounds: rows.length, calls, waves, rows }
}

// ---------------------------------------------------------------- state io

async function runDirFrom(cwd: string, dirFlag?: string): Promise<string> {
  if (dirFlag) return path.resolve(cwd, dirFlag)
  const latest = path.join(cwd, ROOT, LATEST)
  const content = await readFile(latest, "utf8").catch(() => {
    throw new ArenaError("no arena here. Run init first, or pass --dir")
  })
  return content.trim()
}

export async function loadState(cwd: string, dirFlag?: string): Promise<ArenaState> {
  const d = await runDirFrom(cwd, dirFlag)
  const file = path.join(d, STATE_FILE)
  const text = await readFile(file, "utf8").catch(() => {
    throw new ArenaError(`no ${STATE_FILE} in ${d}`)
  })
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ArenaError(`${STATE_FILE} in ${d} is not valid JSON`)
  }
  if (!isRecord(parsed) || !isRecord(parsed["agents"]) || !Array.isArray(parsed["rounds"]) || typeof parsed["dir"] !== "string") {
    throw new ArenaError(`${STATE_FILE} in ${d} is missing the arena state`)
  }
  return parsed as unknown as ArenaState
}

export async function saveState(state: ArenaState): Promise<void> {
  const file = path.join(state.dir, STATE_FILE)
  const tmp = `${file}.tmp`
  await writeFile(tmp, `${JSON.stringify(state, null, 1)}\n`, "utf8")
  await rename(tmp, file)
}

function cmd(...parts: string[]): string {
  return `arena ${parts.join(" ")}`
}

function cardLine(card: Card): string {
  return `${card.reasoning.name} + ${card.workflow.name} + ${card.strategy.name}`
}

// ---------------------------------------------------------------- commands

export interface ArenaResult {
  code: number
  stdout: string
}

export interface WinnerPathEntry {
  round: number
  bye: boolean
  beat?: string
  match?: string
  score?: number | null
  opponent_score?: number | null
  reason?: string | null
  survived?: string[]
}

export interface WinnerReport {
  champion: string
  card: Card
  card_line: string
  solution: string
  rounds: number
  agents: number
  matches_won: number
  path: WinnerPathEntry[]
  attacks_survived: string[]
  final: FinalResult | null
}

export interface StatusRow {
  round: number
  alive: number
  matches: number
  bye: string | null
  eliminated: number
  state: string
}

export function statusRows(state: ArenaState): StatusRow[] {
  return state.rounds.map((rd) => {
    const recorded = rd.matches.filter((m) => m.winner).length
    return {
      round: rd.n,
      alive: rd.alive.length,
      matches: rd.matches.length,
      bye: rd.bye,
      eliminated: recorded,
      state: rd.closed ? "closed" : `open, ${recorded} of ${rd.matches.length} recorded`,
    }
  })
}

export function winnerReport(state: ArenaState): WinnerReport | null {
  const champ = state.champion
  if (!champ) return null
  const agent = state.agents[champ]
  const pathItems: WinnerPathEntry[] = []
  const survived: string[] = []
  for (const rd of state.rounds) {
    if (rd.bye === champ) pathItems.push({ round: rd.n, bye: true })
    for (const m of rd.matches) {
      if (champ === m.a || champ === m.b) {
        const opp = m.a === champ ? m.b : m.a
        const sc = m.scores ?? {}
        pathItems.push({
          round: rd.n,
          bye: false,
          beat: opp,
          match: m.id,
          score: sc[champ] ?? null,
          opponent_score: sc[opp] ?? null,
          reason: m.reason,
          survived: m.survived ?? [],
        })
        survived.push(...(m.survived ?? []))
      }
    }
  }
  return {
    champion: champ,
    card: agent.card,
    card_line: cardLine(agent.card),
    solution: agent.solution,
    rounds: roundsPlayed(state),
    agents: state.agents_n,
    matches_won: pathItems.filter((p) => !p.bye).length,
    path: pathItems,
    attacks_survived: survived,
    final: state.final?.result ?? null,
  }
}

interface ParsedArgs {
  positional: string[]
  get: (name: string) => string | undefined
  has: (name: string) => boolean
  getAll: (name: string) => string[]
}

type FlagKind = "value" | "bool" | "multi"

interface CommandSpec {
  flags: Record<string, FlagKind>
  positionals: number
}

function parseArgs(tokens: string[], spec: CommandSpec, command: string): ParsedArgs {
  const positional: string[] = []
  const values = new Map<string, string>()
  const multis = new Map<string, string[]>()
  const bools = new Set<string>()
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === "--") {
      positional.push(...tokens.slice(i + 1))
      break
    }
    if (token.startsWith("--")) {
      const eq = token.indexOf("=")
      const name = eq === -1 ? token.slice(2) : token.slice(2, eq)
      const inline = eq === -1 ? undefined : token.slice(eq + 1)
      const kind = spec.flags[name]
      if (!kind) throw new ArenaError(`unknown option: --${name}`)
      if (kind === "bool") {
        if (inline !== undefined) throw new ArenaError(`--${name} takes no value`)
        bools.add(name)
      } else {
        const value = inline ?? tokens[++i]
        if (value === undefined) throw new ArenaError(`--${name} needs a value`)
        if (kind === "multi") {
          const list = multis.get(name) ?? []
          list.push(value)
          multis.set(name, list)
        } else {
          values.set(name, value)
        }
      }
    } else {
      positional.push(token)
    }
  }
  if (positional.length !== spec.positionals) {
    throw new ArenaError(`${command} expects ${spec.positionals} argument(s), got ${positional.length}`)
  }
  return {
    positional,
    get: (name) => values.get(name),
    has: (name) => bools.has(name),
    getAll: (name) => multis.get(name) ?? [],
  }
}

function parseIntArg(value: string, flag: string): number {
  if (!/^[+-]?\d+$/.test(value.trim())) throw new ArenaError(`--${flag} must be an integer, not '${value}'`)
  return Number(value)
}

function agentsArg(args: ParsedArgs): number {
  const agents = args.get("agents")
  if (args.has("quick") && agents !== undefined) throw new ArenaError("pass --quick or --agents, not both")
  if (args.has("quick")) return QUICK_AGENTS
  return agents === undefined ? DEFAULT_AGENTS : parseIntArg(agents, "agents")
}

function waveArg(args: ParsedArgs): number {
  const wave = args.get("wave")
  const value = wave === undefined ? DEFAULT_WAVE : parseIntArg(wave, "wave")
  if (value < 1) throw new ArenaError("--wave must be at least 1")
  return value
}

function out(lines: string[], code: number = 0): ArenaResult {
  return { code, stdout: `${lines.join("\n")}\n` }
}

function cmdPlan(args: ParsedArgs): ArenaResult {
  const n = agentsArg(args)
  if (n < 1) throw new ArenaError("--agents must be at least 1")
  const wave = waveArg(args)
  const t = planTotals(n, wave)
  if (args.has("json")) return { code: 0, stdout: `${JSON.stringify(t, null, 1)}\n` }
  const lines = [
    `${n} agents, ${t.rounds} rounds, waves of ${wave}`,
    "",
    "  round  alive  matches  bye  sub-agent calls  waves",
    `  spawn  ${pad(n, 5)}  ${pad("-", 7)}  ${pad("-", 3)}  ${pad(n, 15)}  ${pad(Math.ceil(n / wave), 5)}`,
    ...t.rows.map(
      (r) =>
        `  ${pad(r.round, 5)}  ${pad(r.alive, 5)}  ${pad(r.matches, 7)}  ${pad(r.bye ? "yes" : "-", 3)}  ${pad(r.calls, 15)}  ${pad(r.waves, 5)}`,
    ),
    `  total${" ".repeat(21)}${pad(t.calls, 15)}  ${pad(t.waves, 5)}`,
    "",
    `  alive per round: ${bracketSizes(n).join(" -> ")}`,
    "  plus 1 call for the final check when there is a rejected answer to beat",
  ]
  return out(lines)
}

async function cmdInit(cwd: string, args: ParsedArgs): Promise<ArenaResult> {
  const n = agentsArg(args)
  const wave = waveArg(args)
  const data = loadStrategies()
  if (n < 1 || n > comboCount(data)) {
    throw new ArenaError(`--agents must be between 1 and ${comboCount(data)} (the number of distinct cards)`)
  }
  let task: string
  if (args.get("task-file") !== undefined) {
    task = await readText(path.resolve(cwd, args.get("task-file") as string))
  } else {
    task = args.get("task") ?? ""
  }
  task = task.trim()
  if (!task) throw new ArenaError("the task is empty. Pass --task-file or --task")
  let baseline: string | null = null
  if (args.get("baseline-file") !== undefined) {
    baseline = (await readText(path.resolve(cwd, args.get("baseline-file") as string))).trim()
    if (!baseline) throw new ArenaError("the baseline file is empty")
  }
  const seed = args.get("seed") !== undefined ? parseIntArg(args.get("seed") as string, "seed") : randomInt(1, 1000000)
  const defaultDir = args.get("dir") === undefined
  const d = path.resolve(cwd, args.get("dir") ?? path.join(ROOT, `run-${formatRunTimestamp(new Date())}-s${seed}`))
  if (await stat(path.join(d, STATE_FILE)).then(
    () => true,
    () => false,
  )) {
    throw new ArenaError(`${d} already has an arena in it. Pick another --dir`)
  }
  await mkdir(d, { recursive: true })
  await writeFile(path.join(d, "task.md"), `${task}\n`, "utf8")
  if (baseline) await writeFile(path.join(d, "baseline.md"), `${baseline}\n`, "utf8")
  // The run gets its own copy of the rubric: frozen for this run, and inside the
  // working directory, so judges can read it without a permission prompt each.
  await writeFile(path.join(d, "rubric.md"), rubricMd, "utf8")
  const state = newState(n, seed, data, d, wave, Boolean(baseline))
  await saveState(state)
  if (defaultDir) {
    await mkdir(path.join(cwd, ROOT), { recursive: true })
    await writeFile(path.join(cwd, ROOT, LATEST), `${d}\n`, "utf8")
  }
  const t = planTotals(n, wave)
  return out([
    `arena ready: ${d}`,
    `seed ${seed}. ${n} agents, ${n} distinct cards dealt from ${comboCount(data)}, no repeats.`,
    `${t.rounds} rounds (${bracketSizes(n).join(" -> ")}). ${t.calls + (baseline ? 1 : 0)} sub-agent calls in ${t.waves + (baseline ? 1 : 0)} waves of ${wave}${baseline ? ", including the final check" : ""}.`,
    `next: ${cmd("next")}`,
  ])
}

async function cmdNext(cwd: string, args: ParsedArgs): Promise<ArenaResult> {
  const state = await loadState(cwd, args.get("dir"))
  const { phase, left, jobs } = await nextAction(state)
  const rd = currentRound(state)
  const totalRounds = bracketSizes(state.agents_n).length - 1
  const lines: string[] = []
  if (phase === "spawn") {
    lines.push(`spawn: ${state.agents_n} competitors, then ${totalRounds} round(s)`)
  } else if (rd) {
    lines.push(`round ${rd.n} of ${totalRounds}, ${rd.alive.length} alive`)
  } else if (state.champion) {
    lines.push(`champion: ${state.champion} after ${roundsPlayed(state)} round(s)`)
  }
  if ((PHASES as readonly string[]).includes(phase)) {
    lines.push(`NEXT: ${phase}. ${left.length} of ${jobs.length} job(s) to run.`)
    lines.push(`  1. ${cmd("prompts", phase)}`)
    lines.push(`  2. launch the jobs it lists, one wave of ${state.wave} at a time`)
    lines.push(`  3. ${cmd("next")}`)
  } else if (phase === "collect") {
    lines.push("NEXT: collect. Every verdict for this step is on disk.")
    lines.push(`  ${cmd("collect")}`)
  } else if (phase === "advance") {
    lines.push(`NEXT: advance. Every match in round ${rd?.n} has a winner.`)
    lines.push(`  ${cmd("advance")}`)
  } else {
    lines.push(`DONE. ${cmd("winner")}`)
  }
  return out(lines)
}

function requirePhase(args: ParsedArgs): Phase {
  const phase = args.positional[0]
  if (!(PHASES as readonly string[]).includes(phase)) {
    throw new ArenaError(`invalid choice: '${phase}' (choose from ${PHASES.join(", ")})`)
  }
  return phase as Phase
}

async function cmdPrompts(cwd: string, args: ParsedArgs): Promise<ArenaResult> {
  const state = await loadState(cwd, args.get("dir"))
  const phase = requirePhase(args)
  const jobs = await writePrompts(state, phase)
  if (jobs.length === 0) return out([`nothing to run for ${phase} right now. ${cmd("next")}`])
  const left = await missingJobs(jobs)
  const w = state.wave
  const rd = currentRound(state)
  const where = phase === "spawn" ? "round 0" : phase === "final" ? "final" : `round ${rd?.n}`
  const waves: Job[][] = []
  for (let i = 0; i < left.length; i += w) waves.push(left.slice(i, i + w))
  const lines = [`${where}, ${phase}: ${jobs.length} job(s), ${left.length} still to run, ${waves.length} wave(s) of up to ${w}`]
  waves.forEach((wave, k) => {
    lines.push(`wave ${k + 1}`)
    for (const j of wave) lines.push(`  ${padEnd(j.id, 26)} ${j.prompt}`)
  })
  if (left.length > 0) {
    lines.push("")
    lines.push('Each job is one subagent tool call: description "arena <job id>",')
    lines.push('prompt "Read <prompt path> and follow it exactly. It is your whole brief."')
    lines.push("A wave is one message with all of its Agent calls. Let it finish before the next wave.")
  }
  lines.push(`then: ${cmd("next")}`)
  return out(lines)
}

async function cmdCheck(cwd: string, args: ParsedArgs): Promise<ArenaResult> {
  const state = await loadState(cwd, args.get("dir"))
  const phase = requirePhase(args)
  const jobs = phaseJobs(state, phase)
  const left = await missingJobs(jobs)
  const lines = [`${phase}: ${jobs.length - left.length} of ${jobs.length} job(s) done`]
  for (const j of left) {
    const gone: string[] = []
    for (const p of j.outputs) {
      if (!(await hasOutput(p))) gone.push(p)
    }
    lines.push(`  missing ${padEnd(j.id, 26)} ${gone.join(", ")}`)
  }
  return out(lines, left.length > 0 ? 1 : 0)
}

async function cmdPairings(cwd: string, args: ParsedArgs): Promise<ArenaResult> {
  const state = await loadState(cwd, args.get("dir"))
  const rd = currentRound(state)
  if (rd === null) {
    if (state.champion) return out([`No matches left. ${state.champion} is the last one standing.`])
    throw new ArenaError("no round is open")
  }
  if (args.has("json")) return { code: 0, stdout: `${JSON.stringify(rd, null, 1)}\n` }
  const lines = [`round ${rd.n}: ${rd.alive.length} alive, ${rd.matches.length} match(es), bye: ${rd.bye ?? "none"}`]
  for (const m of rd.matches) {
    const ra = state.agents[m.a].card.reasoning.name
    const rb = state.agents[m.b].card.reasoning.name
    const res = m.winner ? `winner ${m.winner}` : "open"
    lines.push(`  ${m.id}  ${m.a} vs ${m.b}  (${ra} vs ${rb})  ${res}`)
  }
  if (rd.bye) lines.push(`  bye     ${rd.bye} goes through without a match`)
  return out(lines)
}

async function cmdRecord(cwd: string, args: ParsedArgs): Promise<ArenaResult> {
  const state = await loadState(cwd, args.get("dir"))
  const { match, previous } = record(
    state,
    args.positional[0],
    args.positional[1],
    args.get("reason") ?? null,
    args.getAll("survived"),
    null,
    "manual",
  )
  await saveState(state)
  const extra = previous && previous !== match.winner ? ` (was ${previous})` : ""
  return out([`${match.id}: ${match.winner} beat ${match.loser}${extra}`])
}

async function cmdCollect(cwd: string, args: ParsedArgs): Promise<ArenaResult> {
  const state = await loadState(cwd, args.get("dir"))
  const results = await collect(state)
  await saveState(state)
  if (results.length === 0) return out([`nothing to collect. ${cmd("next")}`])
  const bad = results.filter((r) => r.status !== "recorded").length
  const lines = results.map((r) => `  ${padEnd(r.id, 10)} ${padEnd(r.status, 10)} ${r.note}`)
  const rd = currentRound(state)
  if (rd) {
    const done = rd.matches.filter((m) => m.winner).length
    lines.push(`round ${rd.n}: ${done} of ${rd.matches.length} match(es) recorded`)
  }
  if (bad > 0) {
    lines.push(`${bad} verdict(s) missing or unreadable. Re-run those judges: ${cmd("next")}`)
    return out(lines, 1)
  }
  lines.push(`then: ${cmd("next")}`)
  return out(lines)
}

async function cmdAdvance(cwd: string, args: ParsedArgs): Promise<ArenaResult> {
  const state = await loadState(cwd, args.get("dir"))
  const rd = currentRound(state)
  if (rd === null) throw new ArenaError(`no round is open${state.champion ? " (the arena has a champion)" : ""}`)
  const closing = rd.n
  const matchCount = rd.matches.length
  const survivors = await advance(state)
  await saveState(state)
  const lines = [`round ${closing} closed: ${survivors.length} through, ${matchCount} eliminated`]
  if (state.champion) {
    lines.push(`CHAMPION: ${state.champion}. ${cmd("next")}`)
  } else {
    const nr = state.rounds[state.rounds.length - 1]
    lines.push(`round ${nr.n} open: ${nr.matches.length} match(es)${nr.bye ? `, bye ${nr.bye}` : ""}. ${cmd("next")}`)
  }
  return out(lines)
}

async function cmdStatus(cwd: string, args: ParsedArgs): Promise<ArenaResult> {
  const state = await loadState(cwd, args.get("dir"))
  const rows = statusRows(state)
  const alive = aliveIds(state)
  if (args.has("json")) {
    return {
      code: 0,
      stdout: `${JSON.stringify(
        {
          dir: state.dir,
          seed: state.seed,
          agents: state.agents_n,
          alive: alive.length,
          eliminated: state.agents_n - alive.length,
          champion: state.champion,
          rounds: rows,
        },
        null,
        1,
      )}\n`,
    }
  }
  const lines = [
    `arena ${state.dir}`,
    `seed ${state.seed}, ${state.agents_n} agents, waves of ${state.wave}, ${state.cards_available} distinct cards available`,
    "  round  alive  matches  bye     eliminated  state",
    ...rows.map(
      (r) => `  ${pad(r.round, 5)}  ${pad(r.alive, 5)}  ${pad(r.matches, 7)}  ${padEnd(r.bye ?? "-", 6)}  ${pad(r.eliminated, 10)}  ${r.state}`,
    ),
    `now: ${alive.length} alive, ${state.agents_n - alive.length} eliminated${state.champion ? `, champion ${state.champion}` : ""}`,
  ]
  return out(lines)
}

async function cmdWinner(cwd: string, args: ParsedArgs): Promise<ArenaResult> {
  const state = await loadState(cwd, args.get("dir"))
  const rep = winnerReport(state)
  if (rep === null) {
    const rd = currentRound(state)
    return out([`no winner yet: round ${rd ? rd.n : "?"}, ${aliveIds(state).length} alive. ${cmd("next")}`], 1)
  }
  if (args.has("json")) return { code: 0, stdout: `${JSON.stringify(rep, null, 1)}\n` }
  const lines = [
    `CHAMPION  ${rep.champion}`,
    `card      ${rep.card_line}`,
    `solution  ${rep.solution}`,
    `rounds    ${rep.rounds} played, ${rep.agents} agents in, 1 left, ${rep.matches_won} match(es) won`,
  ]
  for (const p of rep.path) {
    if (p.bye) {
      lines.push(`  round ${p.round}  bye`)
    } else {
      lines.push(`  round ${p.round}  beat ${p.beat}, ${fmtScore(p.score)} to ${fmtScore(p.opponent_score)}. ${p.reason ?? ""}`)
      for (const s of p.survived ?? []) lines.push(`           survived: ${s}`)
    }
  }
  const fin = rep.final
  if (fin) {
    const verdict = fin.better === "champion" ? "the winner beats it" : "the answer you rejected scored higher. Say so"
    lines.push(
      `vs the answer you rejected: winner ${fmtScore(fin.champion_total)}, rejected ${fmtScore(fin.baseline_total)}, ${verdict}. ${fin.reason}`,
    )
  }
  return out(lines)
}

async function cmdCard(cwd: string, args: ParsedArgs): Promise<ArenaResult> {
  const state = await loadState(cwd, args.get("dir"))
  const aid = normAgent(state, args.positional[0])
  const a = state.agents[aid]
  const c = a.card
  const lines = [`${aid}  ${a.alive ? "alive" : `eliminated in round ${a.eliminated_in} by ${a.eliminated_by}`}`]
  for (const part of ["reasoning", "workflow", "strategy"] as const) {
    lines.push(`  ${padEnd(part, 9)} ${c[part].name}. ${c[part].how}`)
  }
  lines.push(`  solution  ${a.solution}`)
  return out(lines)
}

// ---------------------------------------------------------------- entry point

const SPECS: Record<string, CommandSpec> = {
  plan: { flags: { agents: "value", quick: "bool", wave: "value", json: "bool" }, positionals: 0 },
  init: {
    flags: { dir: "value", agents: "value", quick: "bool", seed: "value", "task-file": "value", task: "value", "baseline-file": "value", wave: "value" },
    positionals: 0,
  },
  next: { flags: { dir: "value" }, positionals: 0 },
  prompts: { flags: { dir: "value" }, positionals: 1 },
  check: { flags: { dir: "value" }, positionals: 1 },
  pairings: { flags: { dir: "value", json: "bool" }, positionals: 0 },
  record: { flags: { dir: "value", reason: "value", survived: "multi" }, positionals: 2 },
  collect: { flags: { dir: "value" }, positionals: 0 },
  advance: { flags: { dir: "value" }, positionals: 0 },
  status: { flags: { dir: "value", json: "bool" }, positionals: 0 },
  winner: { flags: { dir: "value", json: "bool" }, positionals: 0 },
  card: { flags: { dir: "value" }, positionals: 1 },
}

export async function runArena(argv: string[], options: { cwd: string }): Promise<ArenaResult> {
  const [command, ...rest] = argv
  const spec = command ? SPECS[command] : undefined
  if (!spec || !command) {
    throw new ArenaError(`unknown command: '${command ?? ""}' (one of: ${Object.keys(SPECS).join(", ")})`)
  }
  const args = parseArgs(rest, spec, command)
  switch (command) {
    case "plan":
      return cmdPlan(args)
    case "init":
      return cmdInit(options.cwd, args)
    case "next":
      return cmdNext(options.cwd, args)
    case "prompts":
      return cmdPrompts(options.cwd, args)
    case "check":
      return cmdCheck(options.cwd, args)
    case "pairings":
      return cmdPairings(options.cwd, args)
    case "record":
      return cmdRecord(options.cwd, args)
    case "collect":
      return cmdCollect(options.cwd, args)
    case "advance":
      return cmdAdvance(options.cwd, args)
    case "status":
      return cmdStatus(options.cwd, args)
    case "winner":
      return cmdWinner(options.cwd, args)
    case "card":
      return cmdCard(options.cwd, args)
    default:
      throw new ArenaError(`unknown command: '${command}'`)
  }
}
