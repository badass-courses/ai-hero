import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	gate: { subscriber: null as any, isResolved: false },
	ownership: {
		data: undefined as { owned: boolean } | undefined,
		status: 'pending',
	},
}))

vi.mock('@/hooks/use-cta-gate', () => ({
	useCtaGate: () => mocks.gate,
}))

vi.mock('@/trpc/react', () => ({
	api: {
		ability: {
			ownsResource: {
				useQuery: () => mocks.ownership,
			},
		},
	},
}))

import { CourseCtaClient } from './course-cta-client'

const offer = {
	kind: 'cohort-waitlist' as const,
	id: 'cohort-1',
	title: 'AI Coding',
	href: '/cohorts/ai-coding',
	label: 'Join next cohort',
	waitlist: { kind: 'cohort' as const, productName: 'AI Coding' },
}

const render = () => renderToStaticMarkup(<CourseCtaClient offer={offer} />)

describe('CourseCtaClient', () => {
	beforeEach(() => {
		mocks.gate = { subscriber: null, isResolved: false }
		mocks.ownership = { data: undefined, status: 'pending' }
	})

	it('renders nothing until reader gates resolve', () => {
		expect(render()).toBe('')
	})

	it('renders the offer after resolving an anonymous reader', () => {
		mocks.gate = { subscriber: null, isResolved: true }
		mocks.ownership = { data: { owned: false }, status: 'success' }

		expect(render()).toContain('Join next cohort')
		expect(render()).toContain('href="/cohorts/ai-coding"')
	})

	it('hides an offer the reader already owns', () => {
		mocks.gate = { subscriber: null, isResolved: true }
		mocks.ownership = { data: { owned: true }, status: 'success' }

		expect(render()).toBe('')
	})

	it('hides a waitlist the reader already joined', () => {
		mocks.gate = {
			subscriber: {
				state: 'active',
				fields: { waitlist_ai_coding: '2026-08-01' },
			},
			isResolved: true,
		}
		mocks.ownership = { data: { owned: false }, status: 'success' }

		expect(render()).toBe('')
	})
})
