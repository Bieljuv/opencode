import { expect, story } from "../../stories/playwright/story"

// The old editor's quick actions, ported into the chat composer: a ⚡
// button opens a menu above the composer with closed categories; clicking
// an action sends its prompt as a chat message.
const BLINDAR_PROMPT =
  "Revise todo o código do projeto procurando exposição de segredos e dados sensíveis (chaves de API, tokens, senhas, e-mails e telefones pessoais no código). Liste o que encontrar e corrija: mova segredos para variáveis de ambiente e remova dados pessoais do código."

const CATEGORIES = ["Auditoria", "Testes", "Desempenho", "Aparência", "Publicar"]

story("quick actions button is visible in the composer", async ({ mount, page }) => {
  const component = await mount("opencode-composer-flow--empty-draft", { globals: { locale: "br" } })
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await expect(component.getByRole("button", { name: "Ações rápidas", exact: true })).toBeVisible()
})

story("quick actions menu opens with every category closed", async ({ mount, page }) => {
  const component = await mount("opencode-composer-flow--empty-draft", { globals: { locale: "br" } })
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await component.getByRole("button", { name: "Ações rápidas", exact: true }).click()

  const menu = page.getByRole("menu")
  await expect(menu).toBeVisible()
  for (const category of CATEGORIES) {
    await expect(menu.getByRole("button", { name: category, exact: true })).toBeVisible()
  }
  await expect(menu.getByRole("menuitem", { name: "Blindar o projeto" })).toHaveCount(0)
  await expect(menu.getByRole("menuitem", { name: "Publicar o projeto" })).toHaveCount(0)
})

story("expanding a category and picking an action sends its prompt", async ({ mount, page }) => {
  const component = await mount("opencode-composer-flow--empty-draft", { globals: { locale: "br" } })
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await component.getByRole("button", { name: "Ações rápidas", exact: true }).click()

  const menu = page.getByRole("menu")
  await menu.getByRole("button", { name: "Auditoria", exact: true }).click()
  await expect(menu.getByRole("menuitem", { name: "Blindar o projeto" })).toBeVisible()
  await expect(menu.getByRole("menuitem", { name: "Auditoria de segurança" })).toBeVisible()

  await menu.getByRole("menuitem", { name: "Blindar o projeto" }).click()
  await expect(page.getByRole("menu")).toHaveCount(0)
  await expect(component.locator("output")).toContainText(`Submitted: ${BLINDAR_PROMPT}`)
})

story("the visual improvement action stays disabled until Impeccable lands", async ({ mount, page }) => {
  const component = await mount("opencode-composer-flow--empty-draft", { globals: { locale: "br" } })
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await component.getByRole("button", { name: "Ações rápidas", exact: true }).click()

  const menu = page.getByRole("menu")
  await menu.getByRole("button", { name: "Aparência", exact: true }).click()
  await expect(menu.getByRole("menuitem", { name: "Melhorar o visual" })).toBeDisabled()
  await expect(menu.getByText("Em breve", { exact: true })).toBeVisible()
})
