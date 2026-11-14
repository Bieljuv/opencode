import { expect, story } from "../../stories/playwright/story"

// The preview button in the chat composer: an eye + "Prévia" before
// "IA Automática" that toggles the side region (the review panel beside
// the chat) through the same action as the session header toggle.
const TOOLTIP = "Ver prévia — divide a tela com o navegador do projeto"

story("preview button is visible in the composer footer", async ({ mount, page }) => {
  const component = await mount("opencode-composer-flow--preview-toggle", { globals: { locale: "br" } })
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await expect(component.getByRole("button", { name: "Prévia", exact: true })).toBeVisible()
  // The "IA Automática" chip is a span, not a button: the preview button sits right before it.
  await expect(component.getByText("IA Automática")).toBeVisible()
})

story("clicking the preview button toggles its pressed state", async ({ mount, page }) => {
  const component = await mount("opencode-composer-flow--preview-toggle", { globals: { locale: "br" } })
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  const button = component.getByRole("button", { name: "Prévia", exact: true })
  await expect(button).toHaveAttribute("aria-pressed", "false")
  await button.click()
  await expect(button).toHaveAttribute("aria-pressed", "true")
  await button.click()
  await expect(button).toHaveAttribute("aria-pressed", "false")
})

story("hovering the preview button shows its tooltip", async ({ mount, page }) => {
  const component = await mount("opencode-composer-flow--preview-toggle", { globals: { locale: "br" } })
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await component.getByRole("button", { name: "Prévia", exact: true }).hover()
  await expect(page.getByText(TOOLTIP, { exact: true })).toBeVisible()
})
