import {
	expect,
	test,
	type APIRequestContext,
	type Page,
	type TestInfo,
} from '@playwright/test'

const EXCLUDED_DISCOVERY_PATHS = ['/login', '/thanks', '/team']

function getBaseUrl(testInfo: TestInfo) {
	return (
		process.env['PLAYWRIGHT_BASE_URL'] ||
		process.env['AI_HERO_E2E_BASE_URL'] ||
		(typeof testInfo.project.use.baseURL === 'string'
			? testInfo.project.use.baseURL
			: undefined) ||
		'http://127.0.0.1:3000'
	)
}

function toAbsoluteUrl(testInfo: TestInfo, path: string) {
	return new URL(path, getBaseUrl(testInfo)).toString()
}

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function getJsonLdEntries(page: Page) {
	return page
		.locator('script[type="application/ld+json"]')
		.evaluateAll((nodes) =>
			nodes.flatMap((node) => {
				const text = node.textContent?.trim()
				if (!text) return []

				try {
					const parsed = JSON.parse(text)
					return Array.isArray(parsed) ? parsed : [parsed]
				} catch {
					return []
				}
			}),
		)
}

async function getRepresentativeProductPath(
	request: APIRequestContext,
	testInfo: TestInfo,
) {
	const productsIndex = await request.get(toAbsoluteUrl(testInfo, '/products'))

	expect(productsIndex.ok()).toBeTruthy()

	const html = await productsIndex.text()
	const productLinkMatch = html.match(
		/href="(\/products\/(?!new(?:[/"?#]|$))[^"#?]+)"/,
	)

	const productPath = productLinkMatch?.[1]
	expect(productPath).toBeTruthy()

	if (!productPath) {
		throw new Error('Unable to find a representative public product path.')
	}

	return productPath
}

test('discovery surfaces stay public and hide excluded paths', async ({
	request,
}, testInfo) => {
	const apiResponse = await request.get(toAbsoluteUrl(testInfo, '/api'))
	expect(apiResponse.ok()).toBeTruthy()
	expect(apiResponse.headers()['content-type']).toContain('application/json')

	const apiPayload = await apiResponse.json()
	expect(apiPayload.discovery).toEqual(
		expect.objectContaining({
			api: '/api',
			sitemapMarkdown: '/sitemap.md',
			llms: '/llms.txt',
		}),
	)

	const llmsResponse = await request.get(toAbsoluteUrl(testInfo, '/llms.txt'))
	expect(llmsResponse.ok()).toBeTruthy()
	expect(llmsResponse.headers()['content-type']).toContain('text/plain')
	const llmsBody = await llmsResponse.text()

	const sitemapMarkdownResponse = await request.get(
		toAbsoluteUrl(testInfo, '/sitemap.md'),
	)
	expect(sitemapMarkdownResponse.ok()).toBeTruthy()
	expect(sitemapMarkdownResponse.headers()['content-type']).toContain(
		'text/markdown',
	)
	const sitemapMarkdownBody = await sitemapMarkdownResponse.text()

	for (const excludedPath of EXCLUDED_DISCOVERY_PATHS) {
		expect(JSON.stringify(apiPayload)).not.toContain(excludedPath)
		expect(llmsBody).not.toContain(excludedPath)
		expect(sitemapMarkdownBody).not.toContain(excludedPath)
	}

	const robotsResponse = await request.get(
		toAbsoluteUrl(testInfo, '/robots.txt'),
	)
	expect(robotsResponse.ok()).toBeTruthy()
	const robotsBody = await robotsResponse.text()

	expect(robotsBody).toMatch(/User-agent: \*/i)
	expect(robotsBody).toMatch(/User-agent: GPTBot/i)
	expect(robotsBody).toMatch(/User-agent: ClaudeBot/i)
	expect(robotsBody).toMatch(/Disallow: \/login/i)
	expect(robotsBody).toMatch(/Sitemap: .*\/sitemap\.xml/i)
	expect(robotsBody).toMatch(/Sitemap: .*\/sitemap\.md/i)
})

test('home and FAQ pages expose discovery affordances and site-wide schema', async ({
	page,
}, testInfo) => {
	await page.goto(toAbsoluteUrl(testInfo, '/'))

	await expect(
		page.getByRole('heading', {
			level: 1,
			name: /changing faster than you can imagine/i,
		}),
	).toBeVisible()
	await expect(page.getByRole('link', { name: /browse all/i })).toBeVisible()
	await expect(page.getByRole('button', { name: /^learn/i })).toBeVisible()

	await page.goto(toAbsoluteUrl(testInfo, '/faq'))

	await expect(
		page.getByRole('heading', {
			level: 1,
			name: /faq|frequently asked questions/i,
		}),
	).toBeVisible()

	const faqQuestionButton = page.locator('main').getByRole('button').first()
	await expect(faqQuestionButton).toBeVisible()

	const questionLabel = (await faqQuestionButton.textContent())?.trim()
	if (questionLabel) {
		await expect(
			page.locator('main').getByRole('button', {
				name: new RegExp(escapeRegExp(questionLabel), 'i'),
			}),
		).toBeVisible()
	}

	const jsonLdEntries = await getJsonLdEntries(page)
	const jsonLdTypes = jsonLdEntries.map((entry) => entry['@type'])

	expect(jsonLdTypes).toEqual(
		expect.arrayContaining(['Organization', 'WebSite', 'FAQPage']),
	)
})

test('representative public product pages expose primary UI and schema', async ({
	page,
	request,
}, testInfo) => {
	const productPath = await getRepresentativeProductPath(request, testInfo)
	await page.goto(toAbsoluteUrl(testInfo, productPath), {
		waitUntil: 'domcontentloaded',
	})

	const primaryProductButton = page
		.locator('article')
		.getByRole('button', {
			name: /enroll|buy now|register now|get access|get your ticket/i,
		})
		.first()
	await expect(primaryProductButton).toBeVisible()

	const productButtonName = (await primaryProductButton.textContent())?.trim()
	if (productButtonName) {
		await expect(
			page.locator('article').getByRole('button', {
				name: new RegExp(escapeRegExp(productButtonName), 'i'),
			}),
		).toBeVisible()
	}

	const productJsonLdEntries = await getJsonLdEntries(page)
	const productSchema = productJsonLdEntries.find(
		(entry) => entry['@type'] === 'Product',
	)

	expect(productSchema).toBeTruthy()
	expect(productSchema?.offers).toEqual(
		expect.objectContaining({
			'@type': 'Offer',
			priceCurrency: 'USD',
		}),
	)
})
