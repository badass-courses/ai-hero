// @vitest-environment happy-dom
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./team-inquiry-actions', () => ({ sendTeamInquiry: vi.fn() }))
import { TeamInquiryForm } from './team-inquiry-form'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let root: ReturnType<typeof createRoot> | undefined
let container: HTMLDivElement
async function render(source?: string) {
	container = document.createElement('div')
	document.body.appendChild(container)
	root = createRoot(container)
	await act(async () =>
		root!.render(
			<TeamInquiryForm location="/training-partners" source={source} />,
		),
	)
}
async function choose(selector: string, value?: string) {
	const input = container.querySelector(selector) as HTMLInputElement
	await act(async () => {
		if (value !== undefined) {
			input.value = value
			input.dispatchEvent(new Event('change', { bubbles: true }))
		} else input.click()
	})
}
afterEach(async () => {
	await act(async () => root?.unmount())
	container?.remove()
})

describe('training request form visibility', () => {
	it('shows live fields, toggles location and preference, and hides live fields for self-paced', async () => {
		await render('training-partners')
		expect(container.querySelector('#engineersToTrain')).toBeNull()
		await choose('input[value="live"]')
		for (const id of ['engineersToTrain', 'format', 'timing'])
			expect(
				container.querySelector<HTMLSelectElement>(`#${id}`)?.required,
			).toBe(true)
		expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(5)
		expect(container.querySelector('#trainingCountry')).toBeNull()
		await choose('#trainingLocation', 'elsewhere')
		expect(
			container.querySelector<HTMLSelectElement>('#trainingCountry')?.required,
		).toBe(true)
		await choose('#partnerPreference', 'specific')
		expect(
			container.querySelector<HTMLInputElement>('#specificPartner')?.maxLength,
		).toBe(120)
		await choose('input[value="self-paced"]')
		for (const id of [
			'engineersToTrain',
			'format',
			'timing',
			'partnerPreference',
			'specificPartner',
		])
			expect(container.querySelector(`#${id}`)).toBeNull()
		expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
	})
	it.each([undefined, 'for-teams-page', 'workshop'])(
		'does not add fields for existing caller %s',
		async (source) => {
			await render(source)
			for (const name of [
				'country',
				'trainingLocation',
				'trainingType',
				'topics',
				'timing',
				'partnerPreference',
			])
				expect(container.querySelector(`[name="${name}"]`)).toBeNull()
			expect(container.textContent).toContain('Get team pricing')
		},
	)
})
