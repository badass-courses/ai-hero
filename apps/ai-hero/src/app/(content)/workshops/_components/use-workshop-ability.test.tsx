import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	queryOptions: null as any,
	queryResult: { data: [] as any[], status: 'pending' },
	sessionStatus: 'unauthenticated' as
		| 'authenticated'
		| 'loading'
		| 'unauthenticated',
}))

vi.mock('next-auth/react', () => ({
	useSession: () => ({ status: mocks.sessionStatus }),
}))

vi.mock('@/trpc/react', () => ({
	api: {
		ability: {
			getCurrentAbilityRules: {
				useQuery: (_input: unknown, options: unknown) => {
					mocks.queryOptions = options
					return mocks.queryResult
				},
			},
		},
	},
}))

vi.mock('./workshop-navigation-provider', () => ({
	useWorkshopNavigation: () => ({ id: 'workshop-1' }),
}))

import { useWorkshopAbility } from './use-workshop-ability'

function AbilityProbe() {
	const result = useWorkshopAbility()
	return (
		<div>
			{result.status}:{String(result.canViewWorkshop)}:
			{String(result.canCreate)}
		</div>
	)
}

describe('useWorkshopAbility', () => {
	beforeEach(() => {
		mocks.queryOptions = null
		mocks.queryResult = { data: [], status: 'pending' }
		mocks.sessionStatus = 'unauthenticated'
	})

	it('uses a closed ability without querying for an anonymous viewer', () => {
		const markup = renderToStaticMarkup(<AbilityProbe />)

		expect(markup).toContain('success:false:false')
		expect(mocks.queryOptions).toMatchObject({ enabled: false })
	})

	it('hydrates access rules only for an authenticated viewer', () => {
		mocks.sessionStatus = 'authenticated'
		mocks.queryResult = {
			data: [{ action: 'manage', subject: 'all' }],
			status: 'success',
		}

		const markup = renderToStaticMarkup(<AbilityProbe />)

		expect(markup).toContain('success:true:true')
		expect(mocks.queryOptions).toMatchObject({ enabled: true })
	})
})
