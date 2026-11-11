import { expect, story } from "../../stories/playwright/story"

story("locks the composer while the plan is blocked", async ({ mount, page }) => {
  const component = await mount("opencode-composer-flow--plan-blocked", {
    globals: { locale: "br" },
  })
  await page.evaluate(() => document.fonts.ready.then(() => undefined))

  // The composer shows only the generic message plus the release time —
  // never a model, provider, tier, quota, limit or routing detail.
  const notice = component.getByText(/Tente novamente mais tarde\./)
  await expect(notice).toBeVisible()
  await expect(notice).toContainText("00:00")

  // The input is not editable and the send button is disabled, so no
  // new message can go out while the block lasts.
  const input = component.locator('[data-component="composer"] [contenteditable]')
  await expect(input).toHaveAttribute("contenteditable", "false")
  await expect(component.locator('[data-action="composer-submit"]')).toBeDisabled()
})
