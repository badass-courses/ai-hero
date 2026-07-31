import { describe, expect, it } from 'vitest'

import { HUB_SIDEBAR_FALLBACK_MDX } from '../hub-sidebar-fallback'
import { buildCollapsedSidebarSections } from './sidebar-rail'

describe('buildCollapsedSidebarSections', () => {
	it('preserves the expanded sidebar section and link order', () => {
		expect(buildCollapsedSidebarSections(HUB_SIDEBAR_FALLBACK_MDX)).toEqual([
			{
				title: 'Explore',
				links: [
					{ label: 'Map', href: '/learn' },
					{ label: 'Skills', href: '/skills' },
					{ label: 'Open source', href: '/open-source' },
				],
			},
			{
				title: 'Guides',
				links: [
					{ label: 'LLM Fundamentals', href: '/llm-fundamentals' },
					{ label: 'AI Engineer Roadmap', href: '/ai-engineer-roadmap' },
					{
						label: 'AI Coding Dictionary',
						href: '/ai-coding-dictionary',
					},
				],
			},
			{
				title: "What's New",
				links: [{ label: 'All posts', href: '/posts' }],
			},
			{
				title: 'Topics',
				links: [],
				expandOnly: true,
			},
		])
	})

	it('follows CMS regrouping instead of assigning destinations itself', () => {
		const body = [
			'## Start',
			'',
			'- [Dictionary](/ai-coding-dictionary)',
			'- [Map](/learn)',
			'',
			'## Tools',
			'',
			'- [Skills](/skills)',
		].join('\n')

		expect(buildCollapsedSidebarSections(body)).toEqual([
			{
				title: 'Start',
				links: [
					{ label: 'Dictionary', href: '/ai-coding-dictionary' },
					{ label: 'Map', href: '/learn' },
				],
			},
			{
				title: 'Tools',
				links: [{ label: 'Skills', href: '/skills' }],
			},
		])
	})
})
