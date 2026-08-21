import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MuxPlayerProvider } from '@/hooks/use-mux-player'
import { describe, expect, it } from 'vitest'

import { LowResolutionToggle } from './low-resolution-toggle'

describe('LowResolutionToggle', () => {
	it('renders the buried 480p opt-in', () => {
		const markup = renderToStaticMarkup(
			<MuxPlayerProvider>
				<LowResolutionToggle />
			</MuxPlayerProvider>,
		)

		expect(markup).toContain('Allow 480p')
	})
})
