import { expect, test } from '@playwright/test'

test.use({
	viewport: { width: 375, height: 812 },
	hasTouch: true,
	isMobile: true,
})

test('mobile search focuses without triggering browser zoom', async ({ page }) => {
	await page.goto('/')
	await page.getByRole('button', { name: 'Search', exact: true }).click()

	const dialog = page.getByRole('dialog', { name: 'Search AI Hero' })
	const input = dialog.getByRole('combobox')

	await expect(dialog).toBeVisible()
	await expect(input).toBeFocused()
	expect(await input.evaluate((element) => getComputedStyle(element).fontSize)).toBe(
		'16px',
	)

	const bounds = await dialog.boundingBox()
	expect(bounds).not.toBeNull()
	expect(bounds?.x).toBeGreaterThanOrEqual(0)
	expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(375)
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375)
})
