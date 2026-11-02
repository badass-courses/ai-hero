import * as React from 'react'
import { render } from '@react-email/render'
import { describe, expect, it } from 'vitest'

import BasicEmail from '../basic-email'

describe('BasicEmail', () => {
	it('renders transactional mail with no unsubscribe link by default', async () => {
		const html = await render(<BasicEmail body="Welcome aboard." />)

		expect(html).toContain('Welcome aboard.')
		expect(html).not.toMatch(/unsubscribe/i)
		expect(html).not.toContain('pm:unsubscribe')
	})

	it('renders the caller unsubscribe link on broadcasts', async () => {
		const html = await render(
			<BasicEmail
				body="News."
				messageType="broadcast"
				unsubscribeLinkUrl="https://www.aihero.dev/unsubscribed?preference=newsletter"
			/>,
		)

		expect(html).toContain(
			'href="https://www.aihero.dev/unsubscribed?preference=newsletter"',
		)
		expect(html).not.toContain('pm:unsubscribe')
	})

	it('omits the unsubscribe row on a broadcast without a link', async () => {
		const html = await render(
			<BasicEmail body="News." messageType="broadcast" />,
		)

		expect(html).not.toMatch(/>unsubscribe</i)
	})
})
