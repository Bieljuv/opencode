import { expect, story } from "../../stories/playwright/story"

story("folds a long completed reply behind Read more", async ({ mount }) => {
  const timeline = await mount("assistant-text-fold--thread")
  const fold = timeline.locator(
    '[data-component="text-part"][data-timeline-part-id="msg_plan_reply:text:0"] [data-slot="assistant-text-fold"]',
  )
  const toggle = timeline.locator('[data-slot="assistant-text-fold-toggle"]')

  // Only the long plan folds; the short reply has no toggle.
  await expect(toggle).toHaveCount(1)
  await expect(toggle).toContainText("Read more")
  await expect(fold).toHaveAttribute("data-folded", "")

  const foldedBox = (await fold.boundingBox())!
  await toggle.click()
  await expect(fold).not.toHaveAttribute("data-folded", "")
  await expect(toggle).toContainText("Show less")

  const expandedBox = (await fold.boundingBox())!
  expect(expandedBox.height).toBeGreaterThan(foldedBox.height)
  await expect(fold).toContainText("próxima etapa")

  await toggle.click()
  await expect(fold).toHaveAttribute("data-folded", "")
  await expect(toggle).toContainText("Read more")
})

story("does not fold a short reply", async ({ mount }) => {
  const timeline = await mount("assistant-text-fold--thread")
  const short = timeline.locator('[data-component="text-part"][data-timeline-part-id="msg_reply_short_reply:text:0"]')

  await expect(short.locator('[data-slot="assistant-text-fold-toggle"]')).toHaveCount(0)
  await expect(short.locator('[data-slot="assistant-text-fold"]')).not.toHaveAttribute("data-folded", "")
})

story("does not fold a streaming reply, and folds it once it completes", async ({ mount }) => {
  const root = await mount("assistant-text-fold--streaming")
  const fold = root.locator('[data-slot="assistant-text-fold"]')

  await expect(root.locator('[data-slot="assistant-text-fold-toggle"]')).toHaveCount(0)
  await root.getByRole("button", { name: "Complete response" }).click()
  await expect(root.locator('[data-slot="assistant-text-fold-toggle"]')).toHaveCount(1)
  await expect(fold).toHaveAttribute("data-folded", "")
})
