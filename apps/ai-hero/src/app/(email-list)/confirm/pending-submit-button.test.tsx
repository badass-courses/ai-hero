// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import { PendingSubmitButton } from './pending-submit-button'
;(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLElement | undefined

afterEach(() => {
	act(() => root?.unmount())
	host?.remove()
})

function mount() {
	host = document.createElement('div')
	document.body.append(host)
	root = createRoot(host)
	act(() =>
		root!.render(
			<form action="/confirm/submit" method="post">
				<input name="t" type="hidden" value="tok" />
				<PendingSubmitButton label="Confirm" pendingLabel="Confirming…" />
			</form>,
		),
	)
	const form = host.querySelector('form')!
	const button = host.querySelector('button')!
	return { form, button }
}

describe('PendingSubmitButton: one tap, one confirm', () => {
	it('starts enabled with its label', () => {
		const { button } = mount()
		expect(button.disabled).toBe(false)
		expect(button.textContent).toBe('Confirm')
		expect(button.type).toBe('submit')
	})

	it('disables and says so once the form submits', () => {
		const { form, button } = mount()
		act(() => {
			form.dispatchEvent(new Event('submit', { cancelable: true }))
		})
		expect(button.disabled).toBe(true)
		expect(button.textContent).toBe('Confirming…')
		expect(button.getAttribute('aria-busy')).toBe('true')
	})

	it('re-enables when the page comes back from the back-forward cache', () => {
		const { form, button } = mount()
		act(() => {
			form.dispatchEvent(new Event('submit', { cancelable: true }))
		})
		act(() => {
			const event = new Event('pageshow') as Event & { persisted: boolean }
			Object.defineProperty(event, 'persisted', { value: true })
			window.dispatchEvent(event)
		})
		expect(button.disabled).toBe(false)
		expect(button.textContent).toBe('Confirm')
	})
})
