import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { safeOgImageUrl } from './og-image-url'

describe('safeOgImageUrl', () => {
	it.each([
		'https://res.cloudinary.com/total-typescript/image/upload/v1/a.png',
		'https://image.mux.com/abc/thumbnail.png?time=0&width=1200',
	])('keeps an allowed https image: %s', (url) => {
		expect(safeOgImageUrl(url)).toBe(url)
	})

	it.each([
		'http://res.cloudinary.com/a.png',
		'https://169.254.169.254/latest/meta-data/',
		'https://example.com/a.png',
		'https://res.cloudinary.com.evil.test/a.png',
		'https://user:pw@res.cloudinary.com/a.png',
		'https://res.cloudinary.com:8443/a.png',
		'file:///etc/passwd',
		'',
		null,
		42,
	])('refuses %s', (value) => {
		expect(safeOgImageUrl(value)).toBeNull()
	})

	it('the OG route takes no ?image= parameter and filters stored images', () => {
		const source = readFileSync(
			join(__dirname, '..', 'app/api/og/route.tsx'),
			'utf8',
		)
		expect(source).not.toMatch(/searchParams\.(get|has)\('image'\)/)
		expect(source.match(/safeOgImageUrl\(/g)?.length).toBeGreaterThanOrEqual(3)
	})
})
