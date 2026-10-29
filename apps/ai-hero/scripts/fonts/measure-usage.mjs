#!/usr/bin/env node
// @ts-nocheck: untyped Node operator tooling for scripts/fonts; not app code.
/**
 * Crawls rendered pages and records what the site's web fonts actually draw:
 * every character per font face, the weights and styles each face is asked
 * for, the OpenType features CSS turns on, and the CSS side effects that make
 * the browser draw characters the content never contains (`hyphens: auto`,
 * `text-overflow: ellipsis`, `text-transform`, `::before`/`::after` content,
 * list markers).
 *
 * Content comes from the database and course sync, so this reads rendered
 * pages, not source files. Run it against production, read-only:
 *
 *   node scripts/fonts/measure-usage.mjs https://www.aihero.dev
 *
 * Writes scripts/fonts/usage.json, which `subset.py` reads. See README.md.
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const here = dirname(fileURLToPath(import.meta.url))
const base = (process.argv[2] ?? 'https://www.aihero.dev').replace(/\/$/, '')
const out = process.argv[3] ?? join(here, 'usage.json')
const concurrency = Number(process.env.FONT_CRAWL_CONCURRENCY ?? 3)

// Routes the sitemap leaves out but buyers and learners see.
const EXTRA_ROUTES = [
	'/',
	'/cohorts/software-factories-for-real-engineers-xdy1m',
	'/cohorts/claude-code-for-real-engineers-2026-04',
	'/cohorts/ai-coding-for-real-engineers-m0k0w',
	'/for-your-team',
	'/workshops/ai-coding-crash-course',
	'/workshops/ai-sdk-v6-crash-course',
	'/courses',
	'/ai-coding-dictionary',
	'/skills',
	'/faq',
	'/principles',
	'/privacy',
	'/login',
	'/sandcastle',
]

// The `next/font` family names in `src/app/fonts/fonts.ts`, keyed by the
// first family in a computed `font-family` stack.
const FACES = { geist: 'sans', geistMono: 'mono', sourceSerif: 'serif' }

async function sitemapRoutes() {
	const res = await fetch(`${base}/sitemap.xml`)
	if (!res.ok) throw new Error(`sitemap.xml: HTTP ${res.status}`)
	const xml = await res.text()
	return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
		(m) => new URL(m[1]).pathname,
	)
}

/** Runs in the page. Returns this page's raw usage. */
function collect(FACES) {
	const usage = {}
	const misc = {
		hyphensAuto: 0,
		textOverflowEllipsis: 0,
		langs: {},
		cjk: '',
		otherFamilies: {},
	}
	const add = (face, style, weight, text, features) => {
		const key = `${face}|${style}`
		const u = (usage[key] ??= { chars: {}, weights: {}, features: {} })
		for (const ch of text) u.chars[ch] = (u.chars[ch] ?? 0) + 1
		u.weights[weight] = (u.weights[weight] ?? 0) + text.length
		for (const f of features) u.features[f] = (u.features[f] ?? 0) + 1
	}
	const firstFamily = (stack) =>
		stack.split(',')[0].trim().replace(/^["']|["']$/g, '')
	const featuresOf = (cs) => {
		const f = []
		const check = (name, value, normal) => {
			if (value && value !== normal) f.push(`${name}:${value}`)
		}
		check('font-feature-settings', cs.fontFeatureSettings, 'normal')
		check('font-variant-numeric', cs.fontVariantNumeric, 'normal')
		check('font-variant-ligatures', cs.fontVariantLigatures, 'normal')
		check('font-variant-caps', cs.fontVariantCaps, 'normal')
		check('font-variant-position', cs.fontVariantPosition, 'normal')
		check('font-variant-east-asian', cs.fontVariantEastAsian, 'normal')
		check('font-variant-alternates', cs.fontVariantAlternates, 'normal')
		check('font-kerning', cs.fontKerning, 'auto')
		check('font-variation-settings', cs.fontVariationSettings, 'normal')
		check('font-optical-sizing', cs.fontOpticalSizing, 'auto')
		check('font-synthesis', cs.fontSynthesis, 'weight style small-caps')
		check('font-stretch', cs.fontStretch, '100%')
		return f
	}
	const transform = (text, tt) =>
		tt === 'uppercase' || tt === 'capitalize'
			? text + text.toUpperCase()
			: tt === 'lowercase'
				? text + text.toLowerCase()
				: text
	const record = (cs, text) => {
		if (!text) return
		const cjk = text.match(/[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]/gu)
		if (cjk) misc.cjk += cjk.join('')
		const fam = firstFamily(cs.fontFamily)
		const face = FACES[fam]
		if (!face) {
			misc.otherFamilies[fam] = (misc.otherFamilies[fam] ?? 0) + text.length
			return
		}
		text = transform(text, cs.textTransform)
		if (cs.hyphens === 'auto') {
			misc.hyphensAuto++
			// Chrome draws an automatic hyphen as U+2010 when the face has it.
			text += '\u2010-'
		}
		if (cs.textOverflow === 'ellipsis') {
			misc.textOverflowEllipsis++
			text += '\u2026'
		}
		add(face, cs.fontStyle, cs.fontWeight, text, featuresOf(cs))
	}

	const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		const el = n.parentElement
		if (!el || el.closest('script,style,noscript,template')) continue
		const text = n.nodeValue.replace(/[\t\n ]+/g, ' ')
		record(getComputedStyle(el), text.trim() ? text : ' ')
	}
	for (const el of document.body.querySelectorAll('*')) {
		const lang = el.getAttribute('lang')
		if (lang) misc.langs[lang] = (misc.langs[lang] ?? 0) + 1
		for (const pseudo of ['::before', '::after']) {
			const cs = getComputedStyle(el, pseudo)
			const c = cs.content
			if (!c || c === 'none' || c === 'normal') continue
			const strings = [...c.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) =>
				m[1].replace(/\\(.)/g, '$1'),
			)
			if (/open-quote|close-quote/.test(c)) strings.push('\u201C\u201D\u2018\u2019')
			if (/counter/.test(c)) strings.push('0123456789.')
			record(cs, strings.join(''))
		}
		if (getComputedStyle(el).display === 'list-item') {
			const cs = getComputedStyle(el, '::marker')
			const type = cs.listStyleType
			if (type && type !== 'none' && !/disc|circle|square|disclosure/.test(type))
				record(cs, '0123456789. ')
		}
		if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
			record(getComputedStyle(el), (el.placeholder ?? '') + (el.value ?? ''))
		}
	}
	return { usage, misc }
}

async function crawl(page, path) {
	const res = await page.goto(base + path, {
		waitUntil: 'domcontentloaded',
		timeout: 60_000,
	})
	await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
	// Lazy sections render on scroll.
	await page.evaluate(async () => {
		for (let y = 0; y < document.body.scrollHeight; y += 800) {
			window.scrollTo(0, y)
			await new Promise((r) => setTimeout(r, 60))
		}
		window.scrollTo(0, 0)
	})
	await page.waitForTimeout(500)
	const data = await page.evaluate(collect, FACES)
	return {
		status: res?.status() ?? 0,
		finalPath: new URL(page.url()).pathname,
		...data,
	}
}

const routes = [...new Set([...EXTRA_ROUTES, ...(await sitemapRoutes())])]
console.error(`crawling ${routes.length} routes on ${base}`)
const browser = await chromium.launch()
const results = {}
const queue = [...routes]
await Promise.all(
	Array.from({ length: concurrency }, async () => {
		const context = await browser.newContext({
			viewport: { width: 1440, height: 900 },
		})
		const page = await context.newPage()
		for (let path = queue.shift(); path; path = queue.shift()) {
			try {
				results[path] = await crawl(page, path)
				console.error(`${results[path].status} ${path}`)
			} catch (e) {
				results[path] = { error: String(e) }
				console.error(`ERR ${path} ${e}`)
			}
		}
		await context.close()
	}),
)
await browser.close()

// Aggregate per face and style: the characters, and how many pages use each.
const faces = {}
const pages = {}
for (const [path, r] of Object.entries(results)) {
	if (!r.usage) {
		pages[path] = { error: r.error }
		continue
	}
	pages[path] = { status: r.status, finalPath: r.finalPath, misc: r.misc, faces: {} }
	for (const [key, u] of Object.entries(r.usage)) {
		const f = (faces[key] ??= { pages: {}, weights: {}, features: {} })
		for (const ch of Object.keys(u.chars)) {
			const cp = ch.codePointAt(0)
			f.pages[cp] = (f.pages[cp] ?? 0) + 1
		}
		for (const [w, n] of Object.entries(u.weights))
			f.weights[w] = (f.weights[w] ?? 0) + n
		for (const [x, n] of Object.entries(u.features))
			f.features[x] = (f.features[x] ?? 0) + n
		// Per page, only what falls outside ASCII: enough to see which pages
		// need an extended file.
		pages[path].faces[key] = Object.keys(u.chars)
			.map((c) => c.codePointAt(0))
			.filter((c) => c > 0x7e)
			.sort((a, b) => a - b)
	}
}
const pageCount = Object.values(pages).filter((p) => !p.error).length
writeFileSync(
	out,
	JSON.stringify(
		{
			measuredAt: new Date().toISOString(),
			base,
			pageCount,
			faces: Object.fromEntries(
				Object.entries(faces).map(([key, f]) => [
					key,
					{
						codepoints: Object.keys(f.pages).map(Number).sort((a, b) => a - b),
						pagesPerCodepoint: f.pages,
						weights: f.weights,
						features: f.features,
					},
				]),
			),
			pages,
		},
		null,
		'\t',
	) + '\n',
)
console.error(`wrote ${out}: ${pageCount} pages`)
