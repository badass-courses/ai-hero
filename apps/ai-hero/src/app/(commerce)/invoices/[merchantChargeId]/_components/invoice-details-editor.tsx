'use client'

import * as React from 'react'
import { INVOICE_DETAILS_ANCHOR } from '@/lib/invoice-paths'
import type {
	InvoiceSettings,
	SaveInvoiceSettingsResult,
} from '@/lib/invoice-settings'

import { Button, Input, Label, Textarea } from '@coursebuilder/ui'

import { saveInvoiceSettingsAction } from '../actions'

/**
 * Editable invoice details (AIH-259). Values persist on the server per
 * purchase, so they survive devices and can be prefilled by support. The
 * previous implementation kept these in browser localStorage; on first visit
 * with no server row we migrate any legacy localStorage values into the form
 * so nothing the customer typed is lost.
 */

export type InvoiceDetailsFormValues = {
	recipientName: string
	companyName: string
	address: string
	taxId: string
	notes: string
}

const LEGACY_NAME_KEY = 'invoice-name'
const LEGACY_NOTES_KEY = 'invoice-metadata'

function readLegacyLocalStorage(key: string): string {
	try {
		const raw = window.localStorage.getItem(key)
		if (!raw) return ''
		// react-use's useLocalStorage stored JSON-serialized strings.
		const parsed = JSON.parse(raw)
		return typeof parsed === 'string' ? parsed : ''
	} catch {
		return ''
	}
}

/**
 * Decide what, if anything, to import from legacy localStorage. A legacy name
 * equal to the charge's billing name adds nothing and would only flag the
 * form as dirty, so it is ignored. Returns null when there is nothing new.
 */
export function resolveLegacyImport({
	legacyName,
	legacyNotes,
	defaultRecipient,
}: {
	legacyName: string
	legacyNotes: string
	defaultRecipient: string
}): Partial<Pick<InvoiceDetailsFormValues, 'recipientName' | 'notes'>> | null {
	const name = legacyName.trim()
	const notes = legacyNotes.trim()
	const patch: Partial<
		Pick<InvoiceDetailsFormValues, 'recipientName' | 'notes'>
	> = {}
	if (name && name !== defaultRecipient.trim()) patch.recipientName = name
	if (notes) patch.notes = notes
	return Object.keys(patch).length > 0 ? patch : null
}

function settingsToForm(
	settings: Pick<
		InvoiceSettings,
		'recipientName' | 'companyName' | 'address' | 'taxId' | 'notes'
	> | null,
	fallbackRecipient: string,
): InvoiceDetailsFormValues {
	return {
		recipientName: settings?.recipientName ?? fallbackRecipient,
		companyName: settings?.companyName ?? '',
		address: settings?.address ?? '',
		taxId: settings?.taxId ?? '',
		notes: settings?.notes ?? '',
	}
}

export type InvoiceSaveStatus =
	| { state: 'idle' }
	| { state: 'dirty' }
	| { state: 'saving' }
	| { state: 'saved' }
	| { state: 'error'; message: string }

/** What a save call resolves to; the settings payload is not needed here. */
export type InvoiceSaveOutcome =
	| { state: 'saved' }
	| {
			state: Exclude<SaveInvoiceSettingsResult['state'], 'saved'>
			error: string
	  }

export type InvoiceSaveTracker = ReturnType<typeof createInvoiceSaveTracker>

/**
 * Sequences edits against in-flight saves so a stale save can never report
 * "Saved" over newer, unsaved input. Every edit and every save start bumps
 * a generation; a save only publishes its outcome if no edit or newer save
 * happened while it was in flight. Kept outside React so it can be tested
 * directly with a deferred save promise.
 */
export function createInvoiceSaveTracker() {
	let generation = 0
	return {
		/** A field changed. Any save still in flight is now stale. */
		edit(setStatus: (status: InvoiceSaveStatus) => void) {
			generation += 1
			setStatus({ state: 'dirty' })
		},
		async save({
			values,
			save,
			setStatus,
		}: {
			values: InvoiceDetailsFormValues
			save: (values: InvoiceDetailsFormValues) => Promise<InvoiceSaveOutcome>
			setStatus: (status: InvoiceSaveStatus) => void
		}) {
			generation += 1
			const token = generation
			setStatus({ state: 'saving' })
			let outcome: InvoiceSaveStatus
			try {
				const result = await save(values)
				outcome =
					result.state === 'saved'
						? { state: 'saved' }
						: { state: 'error', message: result.error }
			} catch {
				outcome = {
					state: 'error',
					message: 'Could not save invoice details. Please try again.',
				}
			}
			// An edit (or a newer save) happened while this save was in flight;
			// the form is dirty relative to what we saved, so say nothing.
			if (token !== generation) return
			setStatus(outcome)
		},
	}
}

const InvoiceDetailsContext = React.createContext<InvoiceDetailsFormValues>({
	recipientName: '',
	companyName: '',
	address: '',
	taxId: '',
	notes: '',
})

export function InvoiceDetailsEditor({
	merchantChargeId,
	initialSettings,
	defaultRecipient,
	children,
}: {
	merchantChargeId: string
	initialSettings: InvoiceSettings | null
	/** Billing name + email from the charge, used when nothing is saved yet. */
	defaultRecipient: string
	/** The invoice paper; its "Invoice For" block reads live values via context. */
	children?: React.ReactNode
}) {
	const [values, setValues] = React.useState<InvoiceDetailsFormValues>(() =>
		settingsToForm(initialSettings, defaultRecipient),
	)
	const [status, setStatus] = React.useState<InvoiceSaveStatus>({
		state: 'idle',
	})
	const tracker = React.useRef<InvoiceSaveTracker | null>(null)
	if (!tracker.current) tracker.current = createInvoiceSaveTracker()

	// One-time migration: if the server has nothing saved, pull any legacy
	// localStorage values into the form so the customer can save them durably.
	React.useEffect(() => {
		if (initialSettings) return
		const patch = resolveLegacyImport({
			legacyName: readLegacyLocalStorage(LEGACY_NAME_KEY),
			legacyNotes: readLegacyLocalStorage(LEGACY_NOTES_KEY),
			defaultRecipient,
		})
		if (!patch) return
		setValues((current) => ({ ...current, ...patch }))
		tracker.current?.edit(setStatus)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	const setField =
		(field: keyof InvoiceDetailsFormValues) =>
		(event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
			setValues((current) => ({ ...current, [field]: event.target.value }))
			tracker.current?.edit(setStatus)
		}

	async function handleSave(event: React.FormEvent) {
		event.preventDefault()
		await tracker.current?.save({
			values,
			save: (next) => saveInvoiceSettingsAction(merchantChargeId, next),
			setStatus,
		})
	}

	const fieldClassName = 'border-input bg-background text-foreground w-full'

	return (
		<InvoiceDetailsContext.Provider value={values}>
			<section
				id={INVOICE_DETAILS_ANCHOR}
				aria-label="Edit invoice details"
				className="mb-5 scroll-mt-24 rounded-md border p-5 print:hidden"
			>
				<h2 className="pb-1 text-base font-semibold">Invoice details</h2>
				<p className="text-muted-foreground pb-4 text-sm">
					Add your company details, address, or tax ID. Saved details appear on
					the printed invoice and stay saved for next time.
				</p>
				<form onSubmit={handleSave} className="flex flex-col gap-4">
					<div className="grid gap-4 sm:grid-cols-2">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="invoice-recipient-name">Name</Label>
							<Input
								id="invoice-recipient-name"
								className={fieldClassName}
								value={values.recipientName}
								onChange={setField('recipientName')}
								placeholder="Recipient name"
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="invoice-company-name">Company</Label>
							<Input
								id="invoice-company-name"
								className={fieldClassName}
								value={values.companyName}
								onChange={setField('companyName')}
								placeholder="Company name (optional)"
							/>
						</div>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="invoice-address">Address</Label>
						<Textarea
							id="invoice-address"
							className={fieldClassName}
							value={values.address}
							onChange={setField('address')}
							placeholder="Billing address (optional)"
							rows={3}
						/>
					</div>
					<div className="grid gap-4 sm:grid-cols-2">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="invoice-tax-id">Tax / VAT ID</Label>
							<Input
								id="invoice-tax-id"
								className={fieldClassName}
								value={values.taxId}
								onChange={setField('taxId')}
								placeholder="Tax or VAT ID (optional)"
							/>
						</div>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="invoice-notes">Notes</Label>
						<Textarea
							id="invoice-notes"
							className={fieldClassName}
							value={values.notes}
							onChange={setField('notes')}
							placeholder="Additional notes for the invoice (optional)"
							rows={2}
						/>
					</div>
					<div className="flex items-center gap-3">
						<Button type="submit" disabled={status.state === 'saving'}>
							{status.state === 'saving' ? 'Saving…' : 'Save details'}
						</Button>
						<span aria-live="polite" className="text-sm">
							{status.state === 'saved' && (
								<span className="text-muted-foreground">Saved</span>
							)}
							{status.state === 'dirty' && (
								<span className="text-muted-foreground">Unsaved changes</span>
							)}
							{status.state === 'error' && (
								<span className="text-destructive">{status.message}</span>
							)}
						</span>
					</div>
				</form>
			</section>
			{children}
		</InvoiceDetailsContext.Provider>
	)
}

/**
 * The "Invoice For" block on the invoice paper. Renders the live form values
 * so the paper (screen and print) always shows what will be saved/printed.
 */
export function InvoiceDetailsDisplay() {
	const values = React.useContext(InvoiceDetailsContext)
	const lines = [
		values.recipientName,
		values.companyName,
		values.address,
		values.taxId ? `Tax ID: ${values.taxId}` : '',
	].filter((line) => line.trim() !== '')

	return (
		<div className="whitespace-pre-wrap">
			{lines.length > 0 ? lines.join('\n') : null}
			{values.notes.trim() !== '' && (
				<div className="mt-3 whitespace-pre-wrap">{values.notes}</div>
			)}
		</div>
	)
}
