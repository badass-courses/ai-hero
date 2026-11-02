#!/usr/bin/env node
// @ts-nocheck: untyped Node operator tooling for scripts/fonts; not app code.
/**
 * Before/after screenshots for the font split, from the same content.
 *
 * Swap mode (default) loads each production page three times: as served
 * (before), with only the fonts swapped for the files in src/app/fonts
 * (after), and as served again (before2, to tell live-content churn from
 * font changes). The swap rewrites the production stylesheet's `@font-face`
 * rules to the ones `next/font` generates from scripts/fonts/manifest.json,
 * points the HTML preloads at the core files, and serves those files locally.
 * The fallback faces and everything else stay as production serves them.
 *
 *   node scripts/fonts/pixel-diff.mjs --out /path/to/scratch/pixel-diff
 *
 * Deployed mode compares production with a deployment of this branch:
 *
 *   node scripts/fonts/pixel-diff.mjs --out ... --after https://<preview-host>
 *
 * Then diff the screenshots with pixel-diff.py. Neither script writes to the
 * repo; keep the screenshots out of it.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const here = dirname(fileURLToPath(import.meta.url))
const fontsDir = join(here, '..', '..', 'src', 'app', 'fonts')
const { values } = parseArgs({
	allowNegative: true,
	options: {
		base: { type: 'string', default: 'https://www.aihero.dev' },
		after: { type: 'string' },
		out: { type: 'string' },
		pages: { type: 'string' },
		sheet: { type: 'boolean', default: true },
	},
})
if (!values.out) throw new Error('--out <dir> is required (outside the repo)')
const base = values.base.replace(/\/$/, '')
const afterBase = values.after?.replace(/\/$/, '')

export const PAGES = [
	// C5 sales page: price block, testimonials, FAQ.
	'/cohorts/software-factories-for-real-engineers-xdy1m',
	// Serif testimonials and mono labels.
	'/',
	'/cohorts/claude-code-for-real-engineers-2026-04',
	// Lesson with code.
	'/workshops/ai-sdk-v6-crash-course/generating-objects-via-output~dkm2k',
	// Italic-heavy post.
	'/skills-setup-matt-pocock-skills',
	// Pages that draw an extended character: é in mono, £, °, ².
	'/workshops/ai-coding-crash-course',
	'/tips-for-ai-coding-with-ralph-wiggum',
	'/agents-with-vercel-ai-sdk',
	// Mono with tabular-nums.
	'/ai-coding-dictionary',
	'/for-your-team',
]
const pages = values.pages ? values.pages.split(',') : PAGES
const VIEWPORTS = {
	desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
	mobile: {
		viewport: { width: 390, height: 844 },
		deviceScaleFactor: 2,
		isMobile: true,
		hasTouch: true,
	},
}
const SCHEMES = ['light', 'dark']

const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'))
const FONT_PATH = '/__aih-fonts/'

/** The `@font-face` rules `next/font` generates from the manifest. */
function fontFaceCss() {
	let css = ''
	for (const [family, fam] of Object.entries(manifest.families)) {
		const weight = fam.weight.join(' ')
		for (const part of ['core', 'ext']) {
			const range = part === 'core' ? fam.coreUnicodeRange : fam.extUnicodeRange
			for (const [style, face] of Object.entries(fam.faces)) {
				css += `@font-face{unicode-range:${range};font-family:${family};src:url(${FONT_PATH}${face[part].file})format("woff2");font-display:swap;font-weight:${weight};font-style:${style}}`
			}
		}
	}
	return css
}

// Production's own faces for the three families, not their fallback faces.
const PROD_FACE = /@font-face\{font-family:(geist|geistMono|sourceSerif);src:url\([^)]*\)format\("woff2"\)[^}]*\}/g
// Production's preloaded font URLs: in the `<link>` tags, in the `Link`
// header of dynamically rendered pages, and in the `:HL` hints of every RSC
// payload (the page's own and each link prefetch), which React turns back
// into preloads.
const PROD_FONT_URL =
	/\/_next\/static\/(?:immutable\/)?media\/(dm_sans|jetbrains_mono|source_serif_4)_latin_(normal|italic)[^"\\]*\.woff2/g
const CORE_NAME = { dm_sans: 'dm-sans', jetbrains_mono: 'jetbrains-mono', source_serif_4: 'aih-serif' }

async function serveFonts(context) {
	await context.route(`**${FONT_PATH}*`, (route) => {
		const file = new URL(route.request().url()).pathname.slice(FONT_PATH.length)
		route.fulfill({
			status: 200,
			contentType: 'font/woff2',
			headers: { 'access-control-allow-origin': '*' },
			body: readFileSync(join(fontsDir, file)),
		})
	})
}

const TEXT_TYPES = new Set(['document', 'stylesheet', 'script', 'fetch', 'xhr'])

// Every capture, swapped or not and on either origin, takes its text
// responses through the same route. A routed document arrives whole instead
// of streamed, which changes how Chrome layers the page: on a code block at a
// fractional x it switches some lines from LCD to grayscale anti-aliasing.
// Routing both sides keeps that out of the diff.
async function routeText(context, origin, swap) {
	const faces = swap ? fontFaceCss() : ''
	if (swap) await serveFonts(context)
	await context.route(
		(url) => url.origin === origin && !url.pathname.startsWith(FONT_PATH),
		async (route) => {
			if (!TEXT_TYPES.has(route.request().resourceType())) return route.fallback()
			const res = await route.fetch()
			let body = await res.text()
			if (!swap) return route.fulfill({ response: res, body, headers: res.headers() })
			if (body.match(PROD_FACE)) {
				let first = true
				body = body.replace(PROD_FACE, () => (first ? ((first = false), faces) : ''))
			}
			const core = (_, font, style) => `${FONT_PATH}${CORE_NAME[font]}-core-${style}.woff2`
			body = body.replace(PROD_FONT_URL, core)
			const headers = res.headers()
			if (headers.link) headers.link = headers.link.replace(PROD_FONT_URL, core)
			route.fulfill({ response: res, body, headers })
		},
	)
}

async function capture(browser, url, vp, scheme, swap, file) {
	const context = await browser.newContext({ ...VIEWPORTS[vp], colorScheme: scheme })
	await routeText(context, new URL(url).origin, swap)
	const fonts = []
	context.on('requestfinished', async (req) => {
		if (req.resourceType() !== 'font') return
		const res = await req.response()
		const body = await res?.body().catch(() => null)
		fonts.push({ url: new URL(req.url()).pathname, bytes: body?.length ?? 0 })
	})
	const page = await context.newPage()
	await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
	await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})
	await page.evaluate(async () => {
		for (let y = 0; y < document.body.scrollHeight; y += 600) {
			window.scrollTo(0, y)
			await new Promise((r) => setTimeout(r, 80))
		}
		window.scrollTo(0, 0)
	})
	await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})
	await page.evaluate(() => document.fonts.ready)
	await page.waitForTimeout(1000)
	await page.screenshot({
		path: file,
		fullPage: true,
		animations: 'disabled',
		caret: 'hide',
		mask: [page.locator('video, iframe, canvas, mux-player')],
	})
	await page.waitForTimeout(300)
	await context.close()
	return fonts
}

const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function codepoints(unicodeRange) {
	const out = []
	for (const r of unicodeRange.split(',')) {
		const [a, b = a] = r.slice(2).split('-').map((h) => parseInt(h, 16))
		for (let c = a; c <= b; c++) out.push(c)
	}
	return out
}

/** Every character each font carries, in every style and at four weights,
 * plus accented names in running text. One line per row, never wrapped, so a
 * change stays on its own line. Before and after render the same HTML. */
function glyphSheet(swap) {
	const prodCss = readFileSync(join(values.out, 'prod-fonts.css'), 'utf8')
	const faces = swap
		? fontFaceCss() + prodCss.match(/@font-face\{font-family:\w+ Fallback;[^}]*\}/g).join('')
		: prodCss
	const ascii =
		'The quick brown fox jumps over the lazy dog. AVATAR Typography WAVE fi fl ffi -> => != === // 0123456789 $199 (C5) [x] {y} <z> @ & % # ~ “Don’t” – ‘quoted’… — · •'
	const names =
		'José García, François Müller, Zoë Ångström, Søren Kierkegaard, Ærøskøbing, Straße, Ñandú, Tèa Œuvre, «Où?» ¿Qué? ¡Olé! £100 €100 25 °C x² ½ ™ © ®'
	const stacks = {
		geist: "geist, 'geist Fallback'",
		geistMono: "geistMono, 'geistMono Fallback'",
		sourceSerif: "sourceSerif, 'sourceSerif Fallback'",
	}
	let body = ''
	const line = (label, style, text) =>
		(body += `<p data-label="${label}" style="${style}">${escape(text)}</p>`)
	for (const [family, stack] of Object.entries(stacks)) {
		const fam = manifest.families[family]
		const ext = codepoints(fam.extUnicodeRange).filter((c) => c !== 0xad)
		for (const style of ['normal', 'italic'])
			for (const weight of [400, 500, 600, 700]) {
				const css = `font-family:${stack};font-style:${style};font-weight:${weight}`
				const label = `${family} ${style} ${weight}`
				line(`${label} ascii`, css, ascii)
				line(`${label} names`, css, names)
				for (let i = 0; i < ext.length; i += 48)
					line(
						`${label} ext ${i / 48 + 1}`,
						css,
						String.fromCodePoint(...ext.slice(i, i + 48)).split('').join(' '),
					)
			}
	}
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${faces}
body{margin:16px;font-size:18px;line-height:32px}p{margin:0;white-space:nowrap;height:32px}</style></head><body>${body}</body></html>`
}

mkdirSync(values.out, { recursive: true })
const browser = await chromium.launch()
const results = {}

if (values.sheet) {
	// The production stylesheet's font rules, for the sheet's baseline.
	const html = await (await fetch(base + '/')).text()
	let prodCss = ''
	for (const [, href] of html.matchAll(/<link rel="stylesheet" href="([^"]+\.css)"/g)) {
		const css = await (await fetch(new URL(href, base))).text()
		for (const rule of css.match(/@font-face\{[^}]*\}/g) ?? [])
			prodCss += rule.replace(/url\(\.\.\/media\//g, 'url(/_next/static/immutable/media/')
	}
	writeFileSync(join(values.out, 'prod-fonts.css'), prodCss)
	for (const [label, swap] of [['before', false], ['after', true]]) {
		// Served on the production origin so its fonts load same-origin.
		const context = await browser.newContext({ viewport: { width: 1600, height: 900 } })
		await serveFonts(context)
		const page = await context.newPage()
		await page.route(`${base}/__aih-font-sheet`, (r) =>
			r.fulfill({ contentType: 'text/html', body: glyphSheet(swap) }),
		)
		await page.goto(`${base}/__aih-font-sheet`)
		await page.evaluate(() => document.fonts.ready)
		await page.waitForTimeout(500)
		const loaded = await page.evaluate(() =>
			[...document.fonts].map((f) => `${f.family} ${f.style} ${f.status}`),
		)
		console.error(`glyph sheet ${label}: ${loaded.join(', ')}`)
		// Fallback faces are `local()` system fonts and may be missing here, the
		// same way before and after.
		if (loaded.some((f) => !f.includes('Fallback') && !f.endsWith(' loaded')))
			throw new Error('glyph sheet: a face failed to load')
		mkdirSync(join(values.out, 'glyph-sheet'), { recursive: true })
		const lines = await page.evaluate(() =>
			[...document.querySelectorAll('[data-label]')].map((p) => {
				const r = p.getBoundingClientRect()
				return { label: p.dataset.label, top: r.top + scrollY, bottom: r.bottom + scrollY }
			}),
		)
		writeFileSync(join(values.out, 'glyph-sheet', 'lines.json'), JSON.stringify(lines))
		await page.screenshot({ path: join(values.out, 'glyph-sheet', `desktop-light-${label}.png`), fullPage: true })
		await context.close()
	}
}

for (const path of pages) {
	const slug = path === '/' ? 'home' : path.replace(/^\//, '').replace(/[^\w-]+/g, '_')
	const dir = join(values.out, slug)
	mkdirSync(dir, { recursive: true })
	results[path] = {}
	for (const vp of Object.keys(VIEWPORTS))
		for (const scheme of SCHEMES) {
			const key = `${vp}-${scheme}`
			const runs = afterBase
				? [['before', base, false], ['after', afterBase, false], ['before2', base, false]]
				: [['before', base, false], ['after', base, true], ['before2', base, false]]
			results[path][key] = {}
			for (const [label, origin, swap] of runs) {
				const fonts = await capture(browser, origin + path, vp, scheme, swap, join(dir, `${key}-${label}.png`))
				results[path][key][label] = fonts
			}
			const bytes = (l) => results[path][key][l].reduce((n, f) => n + f.bytes, 0)
			console.error(`${path} ${key}: font bytes before ${bytes('before')} after ${bytes('after')}`)
		}
}
await browser.close()
writeFileSync(join(values.out, 'network.json'), JSON.stringify(results, null, '\t') + '\n')
console.error(`wrote ${values.out}`)
