import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	query: {
		data: [] as Array<{ action: string; subject: string }>,
		status: 'pending',
	},
}))

vi.mock('@/trpc/react', () => ({
	api: {
		ability: {
			getCurrentAbilityRules: {
				useQuery: () => mocks.query,
			},
		},
	},
}))

import { SkillChangelogActionBar } from './skill-changelog-action-bar'

const render = () =>
	renderToStaticMarkup(
		<SkillChangelogActionBar
			entryId="entry-123"
			entrySlug="skills-release"
		/>,
	)

describe('SkillChangelogActionBar', () => {
	beforeEach(() => {
		mocks.query = { data: [], status: 'pending' }
	})

	it('renders nothing while permissions load', () => {
		expect(render()).toBe('')
	})

	it('renders nothing for a reader without edit permission', () => {
		mocks.query = { data: [], status: 'success' }

		expect(render()).toBe('')
	})

	it('links an editor to the changelog editor after hydration', () => {
		mocks.query = {
			data: [{ action: 'manage', subject: 'all' }],
			status: 'success',
		}

		expect(render()).toContain('href="/skills/skills-release/edit"')
		expect(render()).toContain('Edit')
	})
})
