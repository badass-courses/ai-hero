import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { InvoiceSettings } from '@/lib/invoice-settings'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../actions', () => ({
	saveInvoiceSettingsAction: vi.fn(),
}))

// @coursebuilder/ui ships raw .tsx; the form primitives are not under test.
vi.mock('@coursebuilder/ui', () => ({
	Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
		<button {...props} />
	),
	Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => (
		<input {...props} />
	),
	Label: (props: React.LabelHTMLAttributes<HTMLLabelElement>) => (
		<label {...props} />
	),
	Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => (
		<textarea {...props} />
	),
}))

import {
	createInvoiceSaveTracker,
	InvoiceDetailsDisplay,
	InvoiceDetailsEditor,
	resolveLegacyImport,
	type InvoiceDetailsFormValues,
	type InvoiceSaveOutcome,
	type InvoiceSaveStatus,
} from './invoice-details-editor'

const SAVED: InvoiceSettings = {
	purchaseId: 'purchase_1',
	merchantChargeId: 'mch_123',
	recipientName: 'Ada Lovelace',
	companyName: 'Analytical Engines Ltd',
	address: '1 Example Way\nLondon',
	taxId: 'GB123456789',
	notes: 'PO 4711',
	source: 'support',
	updatedByUserId: null,
	supportOperatorId: 'operator_jane',
}

function render(initialSettings: InvoiceSettings | null) {
	const markup = renderToStaticMarkup(
		<InvoiceDetailsEditor
			merchantChargeId="mch_123"
			initialSettings={initialSettings}
			defaultRecipient="Billing Name (billing@example.com)"
		>
			<div data-slot="paper">
				<InvoiceDetailsDisplay />
			</div>
		</InvoiceDetailsEditor>,
	)
	const paperStart = markup.indexOf('data-slot="paper"')
	expect(paperStart).toBeGreaterThan(-1)
	return { markup, paper: markup.slice(paperStart) }
}

describe('InvoiceDetailsEditor', () => {
	it('renders persisted recipient, company, address, tax ID, and notes on the invoice paper', () => {
		const { paper } = render(SAVED)
		expect(paper).toContain('Ada Lovelace')
		expect(paper).toContain('Analytical Engines Ltd')
		expect(paper).toContain('1 Example Way\nLondon')
		expect(paper).toContain('Tax ID: GB123456789')
		expect(paper).toContain('PO 4711')
	})

	it('pre-fills the form fields from persisted settings', () => {
		const { markup } = render(SAVED)
		expect(markup).toContain('id="invoice-company-name"')
		expect(markup).toMatch(/id="invoice-tax-id"[^>]*value="GB123456789"/)
		expect(markup).toMatch(
			/id="invoice-company-name"[^>]*value="Analytical Engines Ltd"/,
		)
		expect(markup).toMatch(/id="invoice-notes"[^>]*>PO 4711</)
	})

	it('hides the editor when printing and keeps the paper visible', () => {
		const { markup, paper } = render(SAVED)
		expect(markup).toMatch(
			/<section[^>]*id="invoice-details"[^>]*class="[^"]*print:hidden[^"]*"/,
		)
		expect(paper).not.toContain('print:hidden')
	})

	it('falls back to the billing name when nothing is saved', () => {
		const { paper } = render(null)
		expect(paper).toContain('Billing Name (billing@example.com)')
		expect(paper).not.toContain('Tax ID:')
	})
})

describe('createInvoiceSaveTracker', () => {
	const VALUES: InvoiceDetailsFormValues = {
		recipientName: 'Ada Lovelace',
		companyName: '',
		address: '',
		taxId: '',
		notes: '',
	}

	function deferred<T>() {
		let resolve!: (value: T) => void
		let reject!: (error: unknown) => void
		const promise = new Promise<T>((res, rej) => {
			resolve = res
			reject = rej
		})
		return { promise, resolve, reject }
	}

	function harness() {
		const statuses: InvoiceSaveStatus[] = []
		const setStatus = (status: InvoiceSaveStatus) => {
			statuses.push(status)
		}
		const last = () => statuses[statuses.length - 1]
		return { tracker: createInvoiceSaveTracker(), statuses, setStatus, last }
	}

	it('publishes saved when nothing changed during the save', async () => {
		const { tracker, setStatus, last } = harness()
		const save = deferred<{ state: 'saved' }>()
		const inFlight = tracker.save({
			values: VALUES,
			save: () => save.promise,
			setStatus,
		})
		expect(last()).toEqual({ state: 'saving' })
		save.resolve({ state: 'saved' })
		await inFlight
		expect(last()).toEqual({ state: 'saved' })
	})

	it('does not overwrite dirty with saved when a field was edited while the save was in flight', async () => {
		const { tracker, setStatus, last, statuses } = harness()
		const save = deferred<{ state: 'saved' }>()
		const inFlight = tracker.save({
			values: VALUES,
			save: () => save.promise,
			setStatus,
		})
		expect(last()).toEqual({ state: 'saving' })

		tracker.edit(setStatus)
		expect(last()).toEqual({ state: 'dirty' })

		save.resolve({ state: 'saved' })
		await inFlight
		expect(last()).toEqual({ state: 'dirty' })
		expect(statuses.filter((s) => s.state === 'saved')).toHaveLength(0)
	})

	it('drops a stale error too when the user kept editing', async () => {
		const { tracker, setStatus, last } = harness()
		const save = deferred<{ state: 'saved' }>()
		const inFlight = tracker.save({
			values: VALUES,
			save: () => save.promise,
			setStatus,
		})
		tracker.edit(setStatus)
		save.reject(new Error('network'))
		await inFlight
		expect(last()).toEqual({ state: 'dirty' })
	})

	it('lets only the newest of two overlapping saves publish its outcome', async () => {
		const { tracker, setStatus, last, statuses } = harness()
		const first = deferred<{ state: 'saved' }>()
		const second = deferred<InvoiceSaveOutcome>()
		const firstInFlight = tracker.save({
			values: VALUES,
			save: () => first.promise,
			setStatus,
		})
		tracker.edit(setStatus)
		const secondInFlight = tracker.save({
			values: { ...VALUES, notes: 'PO 4711' },
			save: () => second.promise,
			setStatus,
		})
		// Older save resolves after the newer one started: ignored.
		first.resolve({ state: 'saved' })
		await firstInFlight
		expect(last()).toEqual({ state: 'saving' })
		expect(statuses.filter((s) => s.state === 'saved')).toHaveLength(0)

		second.resolve({ state: 'denied', error: 'Not authorized' })
		await secondInFlight
		expect(last()).toEqual({ state: 'error', message: 'Not authorized' })
	})

	it('reports a save error when nothing changed in flight', async () => {
		const { tracker, setStatus, last } = harness()
		await tracker.save({
			values: VALUES,
			save: async () => ({
				state: 'invalid',
				error: 'Invalid invoice details',
			}),
			setStatus,
		})
		expect(last()).toEqual({
			state: 'error',
			message: 'Invalid invoice details',
		})
	})
})

describe('resolveLegacyImport', () => {
	it('imports nothing when legacy storage is empty', () => {
		expect(
			resolveLegacyImport({
				legacyName: '',
				legacyNotes: '',
				defaultRecipient: 'Billing Name',
			}),
		).toBeNull()
	})

	it('ignores a legacy name that equals the billing default', () => {
		expect(
			resolveLegacyImport({
				legacyName: ' Billing Name ',
				legacyNotes: '',
				defaultRecipient: 'Billing Name',
			}),
		).toBeNull()
	})

	it('imports a different legacy name and any notes', () => {
		expect(
			resolveLegacyImport({
				legacyName: 'Ada Lovelace',
				legacyNotes: 'PO 4711',
				defaultRecipient: 'Billing Name',
			}),
		).toEqual({ recipientName: 'Ada Lovelace', notes: 'PO 4711' })
	})

	it('imports notes alone when the name matches the default', () => {
		expect(
			resolveLegacyImport({
				legacyName: 'Billing Name',
				legacyNotes: 'PO 4711',
				defaultRecipient: 'Billing Name',
			}),
		).toEqual({ notes: 'PO 4711' })
	})
})
