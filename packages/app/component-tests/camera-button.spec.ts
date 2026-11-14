import { expect, story } from "../../stories/playwright/story"

// The camera button in the chat composer: a camera + "Print" next to "Prévia" that captures the preview and attaches
// the shot to the draft. Disabled while the preview is closed, with a tooltip that says why.

const TOOLTIP = "Tirar print da prévia e anexar na conversa"

const UNAVAILABLE = "Abra a prévia do projeto para tirar um print"

story("camera button is visible next to the preview button", async ({ mount, page }) => {
  const component = await mount("opencode-composer-flow--camera-capture", { globals: { locale: "br" } })
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await expect(component.getByRole("button", { name: "Print", exact: true })).toBeVisible()
  await expect(component.getByRole("button", { name: "Prévia", exact: true })).toBeVisible()
})

story("camera button is disabled while the preview is closed and enabled once it opens", async ({ mount, page }) => {
  const component = await mount("opencode-composer-flow--camera-capture", { globals: { locale: "br" } })
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  const button = component.getByRole("button", { name: "Print", exact: true })
  await expect(button).toBeDisabled()
  await component.getByRole("button", { name: "Prévia", exact: true }).click()
  await expect(button).toBeEnabled()
  await component.getByRole("button", { name: "Prévia", exact: true }).click()
  await expect(button).toBeDisabled()
})

story("hovering the enabled camera button shows its tooltip", async ({ mount, page }) => {
  const component = await mount("opencode-composer-flow--camera-capture", { globals: { locale: "br" } })
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await component.getByRole("button", { name: "Prévia", exact: true }).click()
  const button = component.getByRole("button", { name: "Print", exact: true })
  await button.hover()
  await expect(page.getByText(TOOLTIP, { exact: true })).toBeVisible()
})

story("hovering the disabled camera button explains why it cannot capture", async ({ mount, page }) => {
  const component = await mount("opencode-composer-flow--camera-capture", { globals: { locale: "br" } })
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  const button = component.getByRole("button", { name: "Print", exact: true })
  await expect(button).toBeDisabled()
  await button.hover()
  await expect(page.getByText(UNAVAILABLE, { exact: true })).toBeVisible()
})
