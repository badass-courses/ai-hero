import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { useNavLinks, type NavigationMenuData } from './use-nav-links'

vi.mock('@/trpc/react', () => ({ api: {} }))

function getNavLinks() {
	let data: NavigationMenuData | undefined
	function Probe() {
		data = useNavLinks()
		return null
	}
	renderToStaticMarkup(<Probe />)
	return data!
}

describe('cohort navigation data', () => {
	it('lists Software Factories as the only current cohort', () => {
		expect(getNavLinks().live.cohorts).toEqual([
			{
				href: '/cohorts/software-factories-for-real-engineers-xdy1m',
				image: {
					src: 'https://res.cloudinary.com/total-typescript/image/upload/v1791799196/cohorts/pbqmeemewqbfeqxomwj6.jpg',
					alt: 'Software Factories for Real Engineers',
					width: 160,
					height: 90,
				},
				title: 'Software Factories for Real Engineers',
				subtitle: 'November 9 – November 20, 2026',
			},
		])
	})

	it('puts AI Coding first in past cohorts and preserves the earlier cohorts', () => {
		const { cohorts, pastCohorts } = getNavLinks().live
		expect(pastCohorts[0]).toEqual({
			href: '/cohorts/ai-coding-for-real-engineers-m0k0w',
			image: {
				src: 'https://res.cloudinary.com/total-typescript/image/upload/v1778482299/cohorts/cohort-m0k0w/fh5sosv36pw0ogibmc0p.jpg',
				alt: 'AI Coding for Real Engineers',
				width: 160,
				height: 90,
			},
			title: 'AI Coding for Real Engineers',
			subtitle: 'June, 2026',
		})
		expect(pastCohorts.slice(1).map(({ href }) => href)).toEqual([
			'/cohorts/claude-code-for-real-engineers-2026-04',
			'/cohorts/build-your-own-ai-personal-assistant-in-typescript',
			'/cohorts/build-deepsearch-in-typescript',
		])
		const allHrefs = [...cohorts, ...pastCohorts].map(({ href }) => href)
		expect(new Set(allHrefs).size).toBe(allHrefs.length)
	})
})
