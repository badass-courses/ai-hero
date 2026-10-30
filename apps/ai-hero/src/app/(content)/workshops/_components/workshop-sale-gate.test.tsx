import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

const ability = vi.hoisted(() => ({ status: 'success', canViewWorkshop: false }))
vi.mock('./use-workshop-ability', () => ({ useWorkshopAbility: () => ability }))

import { WorkshopSaleGate } from './workshop-sale-gate'

const render = () => renderToStaticMarkup(<WorkshopSaleGate>Join the cohort</WorkshopSaleGate>)

describe('WorkshopSaleGate', () => {
	it('shows sales copy to a viewer who cannot open the workshop', () => {
		Object.assign(ability, { status: 'success', canViewWorkshop: false })
		expect(render()).toBe('Join the cohort')
	})
	it('hides it from an owner or admin who can', () => {
		Object.assign(ability, { status: 'success', canViewWorkshop: true })
		expect(render()).toBe('')
	})
	it('shows nothing until the ability has loaded, so owners never see a flash', () => {
		Object.assign(ability, { status: 'pending', canViewWorkshop: false })
		expect(render()).toBe('')
	})
})
