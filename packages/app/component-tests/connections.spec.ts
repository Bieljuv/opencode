import { expect, story } from "../../stories/playwright/story"

story("panel connects a provider with a token", async ({ mount, page }) => {
  await mount("app-connections--default", { globals: { locale: "br" } })
  await page.evaluate(() => document.fonts.ready.then(() => undefined))

  // The dialog opens on mount and renders outside the story root.
  const github = page.locator('[data-component="connection-card"][data-provider="github"]')
  await expect(github.getByText("GitHub")).toBeVisible()
  await expect(github.getByText("Não conectado")).toBeVisible()

  await github.locator('input[type="password"]').fill("token-bom")
  await github.getByRole("button", { name: "Conectar" }).click()

  await expect(github.getByText("Funcionando — conectado como usuario-teste")).toBeVisible()
  await expect(github.getByText("Conectado como usuario-teste", { exact: true })).toBeVisible()
  // The token input is gone once connected, and the token itself never appears on screen.
  await expect(github.locator('input[type="password"]')).toHaveCount(0)
  await expect(page.getByText("token-bom")).toHaveCount(0)
})

story("a rejected token shows the generic error and stays disconnected", async ({ mount, page }) => {
  await mount("app-connections--default", { globals: { locale: "br" } })
  await page.evaluate(() => document.fonts.ready.then(() => undefined))

  const github = page.locator('[data-component="connection-card"][data-provider="github"]')
  await github.locator('input[type="password"]').fill("bad-token")
  await github.getByRole("button", { name: "Conectar" }).click()

  await expect(github.getByText("Não foi possível salvar o token. Tente novamente.")).toBeVisible()
  await expect(github.getByText("Não conectado")).toBeVisible()
  await expect(github.locator('input[type="password"]')).toBeVisible()
})

story("test, permission and disconnect work on a connected provider", async ({ mount, page }) => {
  await mount("app-connections--mixed", { globals: { locale: "br" } })
  await page.evaluate(() => document.fonts.ready.then(() => undefined))

  const github = page.locator('[data-component="connection-card"][data-provider="github"]')
  await expect(github.getByText("Conectado como usuario-teste")).toBeVisible()

  await github.getByRole("button", { name: "Testar" }).click()
  await expect(github.getByText("Funcionando — conectado como usuario-teste")).toBeVisible()

  // The radio input itself is covered by its visual control, so click the
  // visible label text, which toggles the option.
  await github.getByText("Bloquear", { exact: true }).click()
  await expect(github.getByRole("radio", { name: "Bloquear" })).toBeChecked()

  await github.getByRole("button", { name: "Desconectar" }).click()
  await expect(github.getByText("Não conectado")).toBeVisible()
  await expect(github.locator('input[type="password"]')).toBeVisible()
})

story("sidebar shows the status dots and opens the panel", async ({ mount, page }) => {
  const component = await mount("app-connections-sidebar--mixed", { globals: { locale: "br" } })
  await page.evaluate(() => document.fonts.ready.then(() => undefined))

  await expect(component.getByText("Conexões")).toBeVisible()
  const github = component.locator('[data-component="connection-row"][data-provider="github"]')
  const vercel = component.locator('[data-component="connection-row"][data-provider="vercel"]')
  await expect(github.getByText("GitHub")).toBeVisible()
  await expect(github.locator("span[aria-label='Conectado']")).toHaveCount(1)
  await expect(vercel.locator("span[aria-label='Não conectado']")).toHaveCount(1)

  await vercel.click()
  await expect(page.getByText("Conecte suas contas para publicar seu projeto.")).toBeVisible()
  await expect(
    page.locator('[data-component="connection-card"][data-provider="vercel"]'),
  ).toBeVisible()
})
