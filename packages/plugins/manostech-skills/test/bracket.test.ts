import { describe, expect, test, afterEach } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  ArenaError,
  agentIds,
  bracketSizes,
  deal,
  decide,
  loadStrategies,
  planTotals,
  runArena,
  weightedTotal,
} from "../src/bracket.ts"

const tmpDirs: string[] = []

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop() as string
    await rm(dir, { recursive: true, force: true })
  }
})

async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "arena-test-"))
  tmpDirs.push(dir)
  return dir
}

async function readState(runDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(runDir, "arena.json"), "utf8"))
}

async function writeTask(cwd: string, task: string = "Write a haiku about rain."): Promise<string> {
  const file = path.join(cwd, "task.md")
  await writeFile(file, `${task}\n`, "utf8")
  return file
}

async function initArena(cwd: string, extra: string[] = []): Promise<{ stdout: string; runDir: string }> {
  const taskFile = await writeTask(cwd)
  const runDir = path.join(cwd, "run")
  const result = await runArena(["init", "--agents", "4", "--seed", "7", "--task-file", taskFile, "--dir", runDir, ...extra], { cwd })
  return { stdout: result.stdout, runDir }
}

// Every command after init needs --dir here: initArena uses an explicit dir,
// so there is no .arena/LATEST pointing at the run.
async function arena(cwd: string, runDir: string, argv: string[]): Promise<{ code: number; stdout: string }> {
  return runArena([...argv, "--dir", runDir], { cwd })
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await listFiles(full)))
    else files.push(full)
  }
  return files
}

async function assertNoPlaceholders(dir: string): Promise<void> {
  const prompts = (await listFiles(path.join(dir, "prompts"))).filter((f) => f.endsWith(".md"))
  expect(prompts.length).toBeGreaterThan(0)
  for (const file of prompts) {
    const body = await readFile(file, "utf8")
    expect(body).not.toContain("{{")
    expect(body).not.toContain("}}")
  }
}

function verdictFor(match: { id: string; a: string; b: string }, winner: string): string {
  const scores = (value: number) => ({ correctness: value, completeness: value, specificity: value, robustness: value, clarity: value, fatal: false })
  return JSON.stringify({
    match: match.id,
    scores: { [match.a]: scores(winner === match.a ? 8 : 6), [match.b]: scores(winner === match.b ? 8 : 6) },
    winner,
    reason: "clearer and more complete",
    survived: ["the main attack"],
    standing: { [match.a]: [], [match.b]: ["one minor gap"] },
  })
}

async function writeSpawnSolutions(runDir: string): Promise<void> {
  const state = await readState(runDir)
  const agents = state["agents"] as Record<string, { solution: string }>
  for (const aid of Object.keys(agents)) {
    await mkdir(path.dirname(agents[aid].solution), { recursive: true })
    await writeFile(agents[aid].solution, `# Solution by ${aid}\n\nRain falls soft on the roof.\n`, "utf8")
  }
}

async function playRound(cwd: string, runDir: string): Promise<void> {
  const state = await readState(runDir)
  const round = (state["rounds"] as Array<{ n: number; matches: Array<{ id: string; a: string; b: string }> }>).at(-1) as {
    n: number
    matches: Array<{ id: string; a: string; b: string }>
  }
  await arena(cwd, runDir, ["prompts", "attack"])
  for (const m of round.matches) {
    for (const attacker of [m.a, m.b]) {
      await writeFile(path.join(runDir, `r${round.n}`, `${m.id}.${attacker}.attack.md`), "ATTACK 1 [MAJOR] vague step\nWhere: the middle\nProblem: it skips the point\n", "utf8")
    }
  }
  await arena(cwd, runDir, ["prompts", "defend"])
  for (const m of round.matches) {
    for (const aid of [m.a, m.b]) {
      await writeFile(path.join(runDir, `r${round.n}`, `${m.id}.${aid}.defense.md`), "ATTACK 1: CONCEDE. Fixed below.\n", "utf8")
      await writeFile(path.join(runDir, `r${round.n}`, `${m.id}.${aid}.solution.md`), `# Revised solution by ${aid}\n\nRain falls soft on the roof, revised.\n`, "utf8")
    }
  }
  await arena(cwd, runDir, ["prompts", "judge"])
  for (const m of round.matches) {
    await writeFile(path.join(runDir, `r${round.n}`, `${m.id}.verdict.json`), verdictFor(m, m.a), "utf8")
  }
  await assertNoPlaceholders(runDir)
  const collected = await arena(cwd, runDir, ["collect"])
  expect(collected.code).toBe(0)
  expect(collected.stdout).toContain("recorded")
  const advanced = await arena(cwd, runDir, ["advance"])
  expect(advanced.code).toBe(0)
}

describe("plan", () => {
  test.each([
    [20, 5, 115, 19],
    [16, 4, 91, 16],
    [100, 7, 595, 70],
  ])("plan totals for %i agents (verified against bracket.py)", (n, rounds, calls, waves) => {
    const t = planTotals(n)
    expect(t.rounds).toBe(rounds)
    expect(t.calls).toBe(calls)
    expect(t.waves).toBe(waves)
    expect(t.agents).toBe(n)
  })

  test("plan rows for 100 agents match bracket.py", () => {
    const t = planTotals(100)
    expect(t.rows.map((r) => r.matches)).toEqual([50, 25, 12, 6, 3, 2, 1])
    expect(t.rows.map((r) => r.bye)).toEqual([0, 0, 1, 1, 1, 0, 0])
    expect(t.rows.map((r) => r.calls)).toEqual([250, 125, 60, 30, 15, 10, 5])
    expect(t.rows.map((r) => r.waves)).toEqual([25, 13, 8, 5, 3, 3, 3])
    expect(t.rows.map((r) => r.alive)).toEqual([100, 50, 25, 13, 7, 4, 2])
  })

  test("plan text output", async () => {
    const cwd = await makeTmp()
    const result = await runArena(["plan", "--agents", "16"], { cwd })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("16 agents, 4 rounds, waves of 10")
    expect(result.stdout).toContain("alive per round: 16 -> 8 -> 4 -> 2 -> 1")
    expect(result.stdout).toContain("plus 1 call for the final check when there is a rejected answer to beat")
  })

  test("plan --quick is 16 agents and --json parses", async () => {
    const cwd = await makeTmp()
    const quick = await runArena(["plan", "--quick"], { cwd })
    expect(quick.stdout).toContain("16 agents, 4 rounds")
    const json = await runArena(["plan", "--agents", "20", "--json"], { cwd })
    expect(JSON.parse(json.stdout)).toMatchObject({ agents: 20, rounds: 5, calls: 115, waves: 19 })
  })

  test("bracketSizes", () => {
    expect(bracketSizes(100)).toEqual([100, 50, 25, 13, 7, 4, 2, 1])
    expect(bracketSizes(1)).toEqual([1])
    expect(bracketSizes(3)).toEqual([3, 2, 1])
  })

  test("plan rejects bad sizing", async () => {
    const cwd = await makeTmp()
    await expect(runArena(["plan", "--agents", "0"], { cwd })).rejects.toThrow(ArenaError)
    await expect(runArena(["plan", "--quick", "--agents", "20"], { cwd })).rejects.toThrow("pass --quick or --agents, not both")
    await expect(runArena(["plan", "--wave", "0"], { cwd })).rejects.toThrow("--wave must be at least 1")
  })
})

describe("deal", () => {
  const data = loadStrategies()

  test("deterministic for a fixed seed", () => {
    expect(deal(20, 7, data)).toEqual(deal(20, 7, data))
    expect(deal(20, 7, data)).not.toEqual(deal(20, 8, data))
  })

  test("100 agents: distinct cards, balanced, no shared pair", () => {
    const dealt = deal(100, 7, data)
    expect(new Set(dealt.map((t) => t.join(","))).size).toBe(100)
    for (const dim of [0, 1, 2] as const) {
      const counts = new Map<number, number>()
      for (const t of dealt) counts.set(t[dim], (counts.get(t[dim]) ?? 0) + 1)
      const values = [...counts.values()]
      expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1)
    }
    for (const [i, j] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      const pairs = dealt.map((t) => `${t[i]},${t[j]}`)
      expect(new Set(pairs).size).toBe(100)
    }
  })

  test("200 agents (fallback path): distinct cards, balanced", () => {
    const dealt = deal(200, 7, data)
    expect(new Set(dealt.map((t) => t.join(","))).size).toBe(200)
    for (const dim of [0, 1, 2] as const) {
      const counts = new Map<number, number>()
      for (const t of dealt) counts.set(t[dim], (counts.get(t[dim]) ?? 0) + 1)
      const values = [...counts.values()]
      expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1)
    }
  })

  test("deal rejects out of range", () => {
    expect(() => deal(0, 7, data)).toThrow(ArenaError)
    expect(() => deal(2161, 7, data)).toThrow(ArenaError)
  })

  test("agentIds width grows past 999", () => {
    expect(agentIds(4)).toEqual(["a001", "a002", "a003", "a004"])
    const ids = agentIds(1000)
    expect(ids[0]).toBe("a0001")
    expect(ids.at(-1)).toBe("a1000")
  })
})

describe("init", () => {
  test("deterministic with a fixed seed, distinct cards, round 1 covers everyone", async () => {
    const cwdA = await makeTmp()
    const cwdB = await makeTmp()
    const taskA = await writeTask(cwdA)
    const taskB = await writeTask(cwdB)
    await runArena(["init", "--agents", "4", "--seed", "7", "--task-file", taskA, "--dir", path.join(cwdA, "run")], { cwd: cwdA })
    await runArena(["init", "--agents", "4", "--seed", "7", "--task-file", taskB, "--dir", path.join(cwdB, "run")], { cwd: cwdB })
    const stateA = await readState(path.join(cwdA, "run"))
    const stateB = await readState(path.join(cwdB, "run"))
    const cardsA = Object.values(stateA["agents"] as Record<string, { card: unknown }>).map((a) => JSON.stringify(a.card))
    const cardsB = Object.values(stateB["agents"] as Record<string, { card: unknown }>).map((a) => JSON.stringify(a.card))
    expect(cardsA).toEqual(cardsB)
    expect(new Set(cardsA).size).toBe(4)
    expect(stateA["rounds"]).toEqual(stateB["rounds"])
    const round = (stateA["rounds"] as Array<{ matches: Array<{ a: string; b: string }> }>)[0]
    expect(round.matches.flatMap((m) => [m.a, m.b]).sort()).toEqual(["a001", "a002", "a003", "a004"])
  })

  test("odd pool gets one bye and the rest are paired", async () => {
    const cwd = await makeTmp()
    const taskFile = await writeTask(cwd)
    await runArena(["init", "--agents", "5", "--seed", "3", "--task-file", taskFile, "--dir", path.join(cwd, "run")], { cwd })
    const state = await readState(path.join(cwd, "run"))
    const round = (state["rounds"] as Array<{ bye: string | null; matches: Array<{ a: string; b: string }> }>)[0]
    expect(round.bye).toMatch(/^a00\d$/)
    const paired = round.matches.flatMap((m) => [m.a, m.b])
    expect(paired.length).toBe(4)
    expect([...paired, round.bye].sort()).toEqual(["a001", "a002", "a003", "a004", "a005"])
    // The bye column is left-aligned (%-6s in bracket.py), not right-aligned.
    const status = await runArena(["status", "--dir", path.join(cwd, "run")], { cwd })
    expect(status.stdout).toContain(`  ${"1".padStart(5)}  ${"5".padStart(5)}  ${"2".padStart(7)}  ${(round.bye as string).padEnd(6)}  ${"0".padStart(10)}  open, 0 of 2 recorded`)
  })

  test("arena.json has the same keys as bracket.py writes", async () => {
    const cwd = await makeTmp()
    const { runDir } = await initArena(cwd)
    const state = await readState(runDir)
    expect(Object.keys(state)).toEqual(["version", "created", "seed", "agents_n", "cards_available", "wave", "dir", "has_baseline", "agents", "rounds", "champion", "final"])
    expect(state["version"]).toBe(1)
    expect(state["seed"]).toBe(7)
    expect(state["agents_n"]).toBe(4)
    expect(state["cards_available"]).toBe(2160)
    expect(state["wave"]).toBe(10)
    expect(state["has_baseline"]).toBe(false)
    expect(state["champion"]).toBeNull()
    expect(state["final"]).toBeNull()
    const agent = (state["agents"] as Record<string, Record<string, unknown>>)["a001"]
    expect(Object.keys(agent)).toEqual(["card", "solution", "alive", "eliminated_in", "eliminated_by", "byes"])
    expect(Object.keys(agent["card"] as Record<string, unknown>)).toEqual(["reasoning", "workflow", "strategy"])
    const round = (state["rounds"] as Array<Record<string, unknown>>)[0]
    expect(Object.keys(round)).toEqual(["n", "alive", "matches", "bye", "closed"])
    const match = (round["matches"] as Array<Record<string, unknown>>)[0]
    expect(Object.keys(match)).toEqual(["id", "a", "b", "winner", "loser", "reason", "survived", "scores", "source"])
  })

  test("init writes task, rubric and LATEST for the default dir", async () => {
    const cwd = await makeTmp()
    const taskFile = await writeTask(cwd, "Do the thing.")
    const result = await runArena(["init", "--agents", "4", "--seed", "7", "--task-file", taskFile], { cwd })
    expect(result.stdout).toContain("arena ready:")
    expect(result.stdout).toContain("seed 7. 4 agents, 4 distinct cards dealt from 2160, no repeats.")
    expect(result.stdout).toContain("2 rounds (4 -> 2 -> 1). 19 sub-agent calls in 7 waves of 10.")
    const latest = await readFile(path.join(cwd, ".arena", "LATEST"), "utf8")
    const runDir = latest.trim()
    expect(await readFile(path.join(runDir, "task.md"), "utf8")).toBe("Do the thing.\n")
    const rubric = await readFile(path.join(runDir, "rubric.md"), "utf8")
    expect(rubric).toContain("The arena rubric")
    const next = await runArena(["next"], { cwd })
    expect(next.stdout).toContain("NEXT: spawn. 4 of 4 job(s) to run.")
  })

  test("init rejects an empty task and a duplicate dir", async () => {
    const cwd = await makeTmp()
    await expect(runArena(["init", "--agents", "4", "--task", "   "], { cwd })).rejects.toThrow("the task is empty")
    const { runDir } = await initArena(cwd)
    expect(runDir).toBe(path.join(cwd, "run"))
    const taskFile = path.join(cwd, "task.md")
    await expect(runArena(["init", "--agents", "4", "--seed", "7", "--task-file", taskFile, "--dir", runDir], { cwd })).rejects.toThrow("already has an arena in it")
  })
})

describe("weightedTotal and decide", () => {
  test("weightedTotal follows rubric.md", () => {
    const all = { correctness: 10, completeness: 10, specificity: 10, robustness: 10, clarity: 10, fatal: false }
    expect(weightedTotal(all)).toBe(100)
    expect(weightedTotal({ ...all, correctness: 7, completeness: 7, specificity: 7, robustness: 7, clarity: 7 })).toBe(70)
    expect(weightedTotal({ ...all, correctness: 10, completeness: 0, specificity: 0, robustness: 0, clarity: 0 })).toBe(30)
    expect(weightedTotal({ correctness: 8, completeness: 8, specificity: 8, robustness: 8 })).toBeNull()
    expect(weightedTotal({ ...all, correctness: true })).toBeNull()
    expect(weightedTotal({ ...all, correctness: 11 })).toBe(100)
    expect(weightedTotal("nope")).toBeNull()
  })

  test("decide: fatal cannot beat non-fatal, scores beat the judge's pick", () => {
    const scores = (value: number, fatal: boolean) => ({ correctness: value, completeness: value, specificity: value, robustness: value, clarity: value, fatal })
    const fatal = decide({ scores: { a001: scores(9, true), a002: scores(5, false) }, winner: "a001", reason: "x" }, "a001", "a002")
    expect(fatal.winner).toBe("a002")
    expect(fatal.note).toContain("judge picked a001 but its own scores favour a002")
    const picked = decide({ scores: { a001: scores(9, false), a002: scores(5, false) }, winner: "a002", reason: "x" }, "a001", "a002")
    expect(picked.winner).toBe("a001")
    expect(picked.totals).toEqual({ a001: 90, a002: 50 })
  })

  test("decide: ties go to fewer standing attacks, then correctness, then the pick", () => {
    const scores = (correctness: number) => ({ correctness, completeness: 8, specificity: 8, robustness: 8, clarity: 8, fatal: false })
    const standing = decide(
      { scores: { a001: scores(8), a002: scores(8) }, winner: "a002", standing: { a001: [], a002: ["gap"] } },
      "a001",
      "a002",
    )
    expect(standing.winner).toBe("a001")
    const correctness = decide(
      { scores: { a001: scores(9), a002: scores(7) }, winner: "a002", standing: { a001: ["gap"], a002: ["gap"] } },
      "a001",
      "a002",
    )
    expect(correctness.winner).toBe("a001")
    const incomplete = decide({ scores: { a001: { correctness: 8 }, a002: { correctness: 6 } }, winner: "a002" }, "a001", "a002")
    expect(incomplete.winner).toBe("a002")
    expect(incomplete.note).toBe("scores incomplete, used the judge's pick")
    expect(() => decide({ scores: { a001: scores(8), a002: scores(8) }, standing: { a001: ["x"], a002: ["y"] } }, "a001", "a002")).toThrow(
      "exact tie and the judge did not pick a winner",
    )
  })
})

describe("full tournament (4 agents)", () => {
  test("spawn to winner, with every prompt rendered", async () => {
    const cwd = await makeTmp()
    const { runDir } = await initArena(cwd)
    const checkBefore = await arena(cwd, runDir, ["check", "spawn"])
    expect(checkBefore.code).toBe(1)
    expect(checkBefore.stdout).toContain("spawn: 0 of 4 job(s) done")

    const spawnPrompts = await arena(cwd, runDir, ["prompts", "spawn"])
    expect(spawnPrompts.stdout).toContain("round 0, spawn: 4 job(s), 4 still to run, 1 wave(s) of up to 10")
    await writeSpawnSolutions(runDir)
    await assertNoPlaceholders(runDir)
    const spawnPrompt = await readFile(path.join(runDir, "prompts", "r0", "a001.spawn.md"), "utf8")
    expect(spawnPrompt).toContain("Write a haiku about rain.")
    expect(spawnPrompt).toContain("Reasoning mode:")

    const checkAfter = await arena(cwd, runDir, ["check", "spawn"])
    expect(checkAfter.code).toBe(0)
    expect(checkAfter.stdout).toContain("spawn: 4 of 4 job(s) done")

    const nextAttack = await arena(cwd, runDir, ["next"])
    expect(nextAttack.stdout).toContain("round 1 of 2, 4 alive")
    expect(nextAttack.stdout).toContain("NEXT: attack. 4 of 4 job(s) to run.")

    await playRound(cwd, runDir)
    const mid = await arena(cwd, runDir, ["status"])
    expect(mid.stdout).toContain("now: 2 alive, 2 eliminated")

    await playRound(cwd, runDir)
    const done = await arena(cwd, runDir, ["next"])
    expect(done.stdout).toContain("DONE. arena winner")

    const winner = await arena(cwd, runDir, ["winner"])
    expect(winner.code).toBe(0)
    expect(winner.stdout).toContain("CHAMPION")
    expect(winner.stdout).toContain("rounds    2 played, 4 agents in, 1 left, 2 match(es) won")
    expect(winner.stdout).toContain("survived: the main attack")
    const champion = winner.stdout.match(/CHAMPION\s+(a\d+)/)?.[1] as string
    const state = await readState(runDir)
    expect(state["champion"]).toBe(champion)

    const winnerJson = JSON.parse((await arena(cwd, runDir, ["winner", "--json"])).stdout)
    expect(winnerJson.champion).toBe(champion)
    expect(winnerJson.matches_won).toBe(2)
    expect(winnerJson.attacks_survived).toEqual(["the main attack", "the main attack"])
    expect(Object.keys(winnerJson)).toEqual(["champion", "card", "card_line", "solution", "rounds", "agents", "matches_won", "path", "attacks_survived", "final"])

    const pairings = await arena(cwd, runDir, ["pairings"])
    expect(pairings.stdout).toContain(`No matches left. ${champion} is the last one standing.`)
  })

  test("record by hand, pairings and card", async () => {
    const cwd = await makeTmp()
    const { runDir } = await initArena(cwd)
    await writeSpawnSolutions(runDir)
    const pairings = await arena(cwd, runDir, ["pairings"])
    expect(pairings.stdout).toContain("round 1: 4 alive, 2 match(es), bye: none")
    const state = await readState(runDir)
    const match = (state["rounds"] as Array<{ matches: Array<{ id: string; a: string; b: string }> }>)[0].matches[0]
    const recorded = await arena(cwd, runDir, ["record", match.id, match.b, "--reason", "by hand"])
    expect(recorded.stdout).toContain(`${match.id}: ${match.b} beat ${match.a}`)
    await expect(arena(cwd, runDir, ["record", match.id, "a999"])).rejects.toThrow("no agent called")
    await expect(arena(cwd, runDir, ["record", "r9-m99", match.a])).rejects.toThrow("no match")
    const card = await arena(cwd, runDir, ["card", match.a])
    expect(card.stdout).toContain(`${match.a}  alive`)
    expect(card.stdout).toContain("solution")
    const statusJson = JSON.parse((await arena(cwd, runDir, ["status", "--json"])).stdout)
    expect(statusJson.rounds[0]).toMatchObject({ round: 1, alive: 4, matches: 2, eliminated: 1 })
  })

  test("collect reports a missing verdict and the judge is re-run", async () => {
    const cwd = await makeTmp()
    const { runDir } = await initArena(cwd)
    await writeSpawnSolutions(runDir)
    await arena(cwd, runDir, ["prompts", "attack"])
    const state = await readState(runDir)
    const round = (state["rounds"] as Array<{ n: number; matches: Array<{ id: string; a: string; b: string }> }>)[0]
    for (const m of round.matches) {
      for (const attacker of [m.a, m.b]) {
        await writeFile(path.join(runDir, `r${round.n}`, `${m.id}.${attacker}.attack.md`), "ATTACK 1 [MAJOR] x\n", "utf8")
      }
    }
    await arena(cwd, runDir, ["prompts", "defend"])
    for (const m of round.matches) {
      for (const aid of [m.a, m.b]) {
        await writeFile(path.join(runDir, `r${round.n}`, `${m.id}.${aid}.defense.md`), "ATTACK 1: CONCEDE.\n", "utf8")
        await writeFile(path.join(runDir, `r${round.n}`, `${m.id}.${aid}.solution.md`), "revised\n", "utf8")
      }
    }
    await arena(cwd, runDir, ["prompts", "judge"])
    const missing = await arena(cwd, runDir, ["collect"])
    expect(missing.code).toBe(1)
    expect(missing.stdout).toContain("missing")
    expect(missing.stdout).toContain("2 verdict(s) missing or unreadable")
    await expect(arena(cwd, runDir, ["advance"])).rejects.toThrow("unrecorded match(es)")
  })
})

describe("final check with a baseline", () => {
  test("champion is compared blind against the rejected answer", async () => {
    const cwd = await makeTmp()
    const taskFile = await writeTask(cwd)
    const baselineFile = path.join(cwd, "baseline.md")
    await writeFile(baselineFile, "The old answer the user rejected.\n", "utf8")
    const runDir = path.join(cwd, "run")
    await runArena(["init", "--agents", "4", "--seed", "7", "--task-file", taskFile, "--baseline-file", baselineFile, "--dir", runDir], { cwd })
    await writeSpawnSolutions(runDir)
    await playRound(cwd, runDir)
    await playRound(cwd, runDir)
    const next = await arena(cwd, runDir, ["next"])
    expect(next.stdout).toContain("NEXT: final. 1 of 1 job(s) to run.")
    await arena(cwd, runDir, ["prompts", "final"])
    await assertNoPlaceholders(runDir)
    const state = await readState(runDir)
    const champion = state["champion"] as string
    const x = await readFile(path.join(runDir, "final", "X.md"), "utf8")
    const y = await readFile(path.join(runDir, "final", "Y.md"), "utf8")
    const championSolution = await readFile((state["agents"] as Record<string, { solution: string }>)[champion].solution, "utf8")
    expect([x, y]).toContain(championSolution)
    expect([x, y]).toContain("The old answer the user rejected.\n")
    const final = state["final"] as { X: string; Y: string }
    const scores = (value: number) => ({ correctness: value, completeness: value, specificity: value, robustness: value, clarity: value, fatal: false })
    await writeFile(
      path.join(runDir, "final.verdict.json"),
      JSON.stringify({
        scores: { x: scores(final.X === "champion" ? 8 : 6), y: scores(final.Y === "champion" ? 8 : 6) },
        winner: final.X === "champion" ? "X" : "Y",
        reason: "the champion is better",
        fixed: ["the vague step"],
      }),
      "utf8",
    )
    const collected = await arena(cwd, runDir, ["collect"])
    expect(collected.code).toBe(0)
    expect(collected.stdout).toContain("champion is better.")
    const winner = await arena(cwd, runDir, ["winner"])
    expect(winner.stdout).toContain("vs the answer you rejected: winner 80, rejected 60, the winner beats it. the champion is better")
  })
})

describe("errors", () => {
  test("no arena, unknown command, unknown option", async () => {
    const cwd = await makeTmp()
    await expect(runArena(["next"], { cwd })).rejects.toThrow("no arena here")
    await expect(runArena(["frobnicate"], { cwd })).rejects.toThrow("unknown command")
    await expect(runArena([], { cwd })).rejects.toThrow("unknown command")
    const { runDir } = await initArena(cwd)
    expect(runDir).toBe(path.join(cwd, "run"))
    await expect(arena(cwd, runDir, ["status", "--bogus"])).rejects.toThrow("unknown option: --bogus")
    await expect(arena(cwd, runDir, ["prompts", "nope"])).rejects.toThrow("invalid choice")
    await expect(arena(cwd, runDir, ["winner"])).resolves.toMatchObject({ code: 1 })
  })
})
