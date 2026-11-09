import { expect, test } from "@playwright/test"
import { openSession } from "../utils/workspace"

// Keeper for the Arena tournament (the built-in manostech-skills plugin).
// The mock server stands in for the real server here: it serves the command
// and skill the plugin registers, so these tests prove the app routes /arena
// through the slash-command path and lists the skill. The plugin's own unit
// tests prove the real registration (skill id, tool, command) and the tool
// running plan/init/next; a full tournament against the live server is not
// covered here (see the report for what is still unproven).

const ARENA_COMMAND = {
  name: "arena",
  description: "Arena: vários agentes competem pela mesma tarefa até sobrar a melhor resposta",
}

const ARENA_SKILL = {
  id: "arena",
  name: "Arena",
  path: "skill://arena/SKILL.md",
  content: "Arena tournament skill.",
}

test("/arena appears in the composer and submits as a slash command", async ({ page }) => {
  const commands: { sessionID: string; body: unknown }[] = []
  // The submit path resolves "/arena" against the server command catalog,
  // which loads asynchronously with the session. Register the wait before
  // opening the session, or the submit can land before the catalog arrives
  // and go out as a plain prompt instead.
  const commandCatalog = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/command")
  // The default provider (with a model) stays: with no provider the composer
  // has no model selection, so the submit holds forever and the command never
  // leaves the composer.
  const { editor, session } = await openSession(page, {
    name: "ArenaCommand",
    commands: [ARENA_COMMAND],
    skills: [ARENA_SKILL],
    onCommand: (input) => commands.push(input),
  })

  await editor.fill("/arena")
  const suggestion = page.getByRole("button", { name: "/arena Arena: vários agentes competem pela mesma tarefa até sobrar a melhor resposta", exact: true })
  await expect(suggestion).toBeVisible()
  await suggestion.click()
  await expect(editor).toHaveText("/arena")
  await commandCatalog
  await editor.pressSequentially(" --quick escreve um haiku")
  await page.locator('[data-action="composer-submit"]').click()

  await expect.poll(() => commands).toEqual([
    {
      sessionID: session.id,
      body: {
        name: "arena",
        text: "--quick escreve um haiku",
        files: [],
        agents: [],
        skills: [],
        delivery: "steer",
      },
    },
  ])
})

test("the Arena skill is listed in the session details", async ({ page }) => {
  await openSession(page, {
    name: "ArenaSkill",
    commands: [ARENA_COMMAND],
    skills: [ARENA_SKILL],
  })

  await page.getByRole("button", { name: "Session details", exact: true }).click()
  const summary = page.getByRole("dialog", { name: "Session details", exact: true })
  await summary.getByRole("button", { name: "Skills", exact: true }).click()
  await expect(page.getByRole("group", { name: "Skills", exact: true }).getByText("Arena", { exact: true })).toBeVisible()
})
