import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
	isWithheldFromPublicRoute,
	publicRouteRobots,
} from './public-content-visibility'

describe('public post and workshop routes (sec-041)', () => {
	it.each([
		[{ state: 'archived', visibility: 'public' }],
		[{ state: 'archived', visibility: 'unlisted' }],
		[{ state: 'draft', visibility: 'private' }],
		[{ state: 'archived', visibility: 'private' }],
	])('withholds %o', (fields) => {
		expect(isWithheldFromPublicRoute(fields)).toBe(true)
	})

	it.each([
		[{ state: 'published', visibility: 'public' }],
		[{ state: 'published', visibility: 'unlisted' }],
		// Unlisted drafts are cohort content and pre-launch pages people reach by link.
		[{ state: 'draft', visibility: 'unlisted' }],
		[{ state: 'draft', visibility: 'public' }],
	])('still serves %o', (fields) => {
		expect(isWithheldFromPublicRoute(fields)).toBe(false)
	})

	it('indexes only published resources', () => {
		expect(publicRouteRobots({ state: 'published' })).toBeUndefined()
		expect(publicRouteRobots({ state: 'draft' })).toEqual({
			index: false,
			follow: false,
		})
		expect(publicRouteRobots(undefined)).toEqual({
			index: false,
			follow: false,
		})
	})

	it.each(['[post]/page.tsx', 'workshops/[module]/page.tsx'])(
		'%s 404s withheld resources and marks drafts noindex',
		(file) => {
			const source = readFileSync(
				join(__dirname, '..', 'app/(content)', file),
				'utf8',
			)
			expect(source.match(/isWithheldFromPublicRoute\(/g)?.length).toBe(2)
			expect(source).toMatch(/robots: publicRouteRobots\(/)
		},
	)
})
