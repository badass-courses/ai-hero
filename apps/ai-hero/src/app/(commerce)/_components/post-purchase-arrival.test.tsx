// @vitest-environment happy-dom
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PostPurchaseArrival } from './post-purchase-arrival'

vi.mock('./post-purchase-telemetry', () => ({
	createPurchaseWaitLogger: () => vi.fn(),
}))

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('post-purchase destination focus', () => {
	it.each(['welcome', 'login_link'] as const)(
		'focuses %s without drawing a heading outline or suppressing button focus',
		async (destination) => {
			vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
			const container = document.createElement('div')
			document.body.append(container)
			const root = createRoot(container)
			try {
				await act(async () => {
					root.render(
						<section>
							<PostPurchaseArrival destination={destination} />
							<h1>Destination heading</h1>
							<button>Continue</button>
						</section>,
					)
				})
				const heading = container.querySelector('h1')!
				expect(heading.tabIndex).toBe(-1)
				expect(document.activeElement).toBe(heading)
				expect(heading.classList.contains('outline-none')).toBe(true)
				const button = container.querySelector('button')!
				button.focus()
				expect(document.activeElement).toBe(button)
				expect(button.classList.contains('outline-none')).toBe(false)
			} finally {
				await act(async () => root.unmount())
				container.remove()
			}
		},
	)
})
