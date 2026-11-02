import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { TransferDenialNotice } from './transfer-denial-form'
import { TRANSFER_DENIAL_MESSAGES } from './transfer-lifecycle'
import { isTransferDenialResult } from './transfer-result'

describe('transfer denial notice', () => {
	it.each(Object.entries(TRANSFER_DENIAL_MESSAGES))(
		'renders the %s message inline as an alert',
		(code, message) => {
			expect(isTransferDenialResult({ ok: false, code, message })).toBe(true)
			const html = renderToStaticMarkup(<TransferDenialNotice message={message} />)
			expect(html).toContain('role="alert"')
			expect(html).toContain(message.replace(/'/g, '&#x27;'))
		},
	)

	it('renders nothing without a denial', () => {
		expect(renderToStaticMarkup(<TransferDenialNotice message={null} />)).toBe('')
	})

	it('does not mistake a successful result for a denial', () => {
		expect(isTransferDenialResult({ ok: true, transfer: {} })).toBe(false)
	})
})
