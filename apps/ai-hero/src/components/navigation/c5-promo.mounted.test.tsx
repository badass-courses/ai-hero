// @vitest-environment happy-dom
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useFeaturedPromo } from './timed-promo-bar-switch'

function PromoProbe() {
	const promo = useFeaturedPromo()
	return promo ? <a href={promo.href}>{promo.message}</a> : null
}

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(async () => {
	if (root) await act(async () => root?.unmount())
	container?.remove()
	vi.useRealTimers()
})

async function mount(instant: string) {
	;(
		globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true
	vi.useFakeTimers()
	vi.setSystemTime(new Date(instant))
	container = document.createElement('div')
	document.body.appendChild(container)
	root = createRoot(container)
	await act(async () => root?.render(<PromoProbe />))
}

describe('C5 timed client chrome', () => {
	it('swaps the existing promo to C5 in a tab open across launch', async () => {
		await mount('2026-10-25T18:58:59.999Z')
		expect(container?.textContent).toBe('AI Coding Crash Course is out now.')
		await act(async () => {
			vi.advanceTimersByTime(1)
		})
		expect(container?.textContent).toBe(
			'Software Factories for Real Engineers: enrollment is open.',
		)
		expect(container?.querySelector('a')?.getAttribute('href')).toBe(
			'/s/c5-site-banner',
		)
	})

	it('restores the existing promo at the exclusive close without a reload', async () => {
		await mount('2026-11-10T07:29:59.999Z')
		expect(container?.textContent).toContain(
			'Software Factories for Real Engineers',
		)
		await act(async () => {
			vi.advanceTimersByTime(1)
		})
		expect(container?.textContent).toBe('AI Coding Crash Course is out now.')
		expect(container?.querySelector('a')?.getAttribute('href')).toBe(
			'/s/crash-course',
		)
	})
})
