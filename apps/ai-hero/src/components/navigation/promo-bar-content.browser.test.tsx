import React from 'react'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { PromoBarContent } from './promo-bar-content'
import { FEATURED_PROMO } from './promo-config'

// Opt-in, no app server, credentials or payment calls. Requires Playwright Chromium.
// AIH_BROWSER_CHECK=1 pnpm exec vitest run -c vitest.config.ts src/components/navigation/promo-bar-content.browser.test.tsx
// Uses the real app stylesheet and local DM Sans font, not approximated test CSS.
describe.skipIf(process.env.AIH_BROWSER_CHECK !== '1')(
	'promo bar browser geometry',
	() => {
		it('shows one complete line at 360px and 390px in both themes, full copy at desktop', async () => {
			const [{ chromium }, { default: postcss }, { default: tailwind }] =
				await Promise.all([
					import('@playwright/test'),
					import('postcss'),
					import('@tailwindcss/postcss'),
				])
			const from = resolve('src/styles/globals.css')
			const css = (
				await postcss([tailwind()]).process(await readFile(from, 'utf8'), {
					from,
				})
			).css
			const font = (await readFile('public/fonts/DMSans-Medium.ttf')).toString(
				'base64',
			)
			const html = renderToStaticMarkup(
				<PromoBarContent promo={FEATURED_PROMO} />,
			)
			const browser = await chromium.launch({ headless: true })
			try {
				const page = await browser.newPage()
				for (const theme of ['light', 'dark']) {
					for (const width of [360, 390, 1024]) {
						await page.setViewportSize({ width, height: 200 })
						await page.setContent(
							`<html class="${theme}"><style>${css}</style><style>@font-face{font-family:PromoDM;src:url(data:font/ttf;base64,${font});font-weight:500}body{font-family:PromoDM,sans-serif}</style><body>${html}</body></html>`,
						)
						await page.evaluate(() => document.fonts.ready)
						const geometry = await page.locator('a').evaluate((link) => {
							const visible = [...link.querySelectorAll('span')].filter(
								(span) => getComputedStyle(span).display !== 'none',
							)
							const text = visible[0]!
							const rect = text.getBoundingClientRect()
							const row = link.parentElement!.getBoundingClientRect()
							const arrow = link.querySelector('svg')!.getBoundingClientRect()
							return {
								count: visible.length,
								text: text.textContent,
								textWidth: rect.width,
								scrollWidth: text.scrollWidth,
								textHeight: rect.height,
								rowHeight: row.height,
								left: rect.left,
								right: arrow.right,
								viewport: innerWidth,
							}
						})
						expect(geometry.count).toBe(1)
						expect(geometry.text).toBe(
							width < 640
								? FEATURED_PROMO.shortMessage
								: FEATURED_PROMO.message,
						)
						expect(geometry.scrollWidth).toBeLessThanOrEqual(
							Math.ceil(geometry.textWidth),
						)
						expect(geometry.textHeight).toBeLessThan(20)
						expect(geometry.rowHeight).toBe(34)
						expect(geometry.left).toBeGreaterThanOrEqual(8)
						expect(geometry.right).toBeLessThanOrEqual(width - 8)
						console.info(`${theme} ${width}px: ${JSON.stringify(geometry)}`)
					}
				}
			} finally {
				await browser.close()
			}
		}, 30000)
	},
)
