'use client'

import * as React from 'react'
import { WORKSHOP_CTA_BUTTON } from '@/app/(content)/workshops/_components/workshop-cta-button'
import { TYPE } from '@/components/landing/type'
import {
	PRICE_UNAVAILABLE_MESSAGE,
	TEAM_INVOICE_MAX_SEATS,
	TEAM_INVOICE_MIN_SEATS,
	teamInvoiceSchema,
	type TeamInvoiceFormInput,
	type TeamInvoiceResult,
} from '@/lib/team-invoice/schema'
import { zodResolver } from '@hookform/resolvers/zod'
import { CheckIcon, XCircleIcon } from 'lucide-react'
import { useForm } from 'react-hook-form'

import {
	Button,
	Form,
	Input,
	Label,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@coursebuilder/ui'
import Spinner from '@coursebuilder/ui/primitives/spinner'
import { cn } from '@coursebuilder/ui/utils/cn'

import { requestTeamInvoice } from './team-invoice-actions'

/**
 * What the buyer reads after a submit. The server owns the outcome; this only
 * words it. Kept apart from the form so the copy is testable on its own.
 */
export function teamInvoiceResultMessage(result: TeamInvoiceResult): {
	tone: 'success' | 'error'
	text: string
} {
	switch (result.kind) {
		case 'confirm-sent':
			return {
				tone: 'success',
				text: `Check ${result.email}. We sent a link to confirm the order, and the invoice goes out once you click it. The link works for 30 minutes.`,
			}
		case 'expired':
			return {
				tone: 'error',
				text: 'This link has expired or was already used. Start again from the team page.',
			}
		case 'sent':
			return {
				tone: 'success',
				text: `Invoice sent to ${result.email}. Once it is paid, you assign seats from your account.`,
			}
		case 'requested':
			return {
				tone: 'success',
				text:
					result.when === 'seats-open'
						? `Got it. We will send the invoice to ${result.email} as soon as seats open.`
						: `Got it. We will send the invoice to ${result.email} within a working day.`,
			}
		case 'price-unavailable':
			return { tone: 'error', text: PRICE_UNAVAILABLE_MESSAGE }
		case 'contact-us':
			return {
				tone: 'error',
				text: `More than ${TEAM_INVOICE_MAX_SEATS} seats? Contact us below for a quote.`,
			}
		case 'not-on-sale':
			return {
				tone: 'error',
				text: 'Seats are not on sale right now. Contact us below.',
			}
		case 'rate-limited':
			return {
				tone: 'error',
				text: 'Too many invoice requests today. Contact us below.',
			}
		case 'invalid':
			return { tone: 'error', text: result.message }
		case 'error':
			return {
				tone: 'error',
				text: 'Could not send the invoice. Try again, or contact us below.',
			}
	}
}

const FIELD = 'space-y-2'

/**
 * "Pay by invoice" for a team: billing details and a seat count, nothing about
 * price. The billing email gets a link to confirm; on confirm the server
 * prices the order from the team rules and Stripe sends the invoice. In `request` mode (seats not on sale yet, or invoicing not switched
 * on for this product) the same details go to support instead.
 */
export function TeamInvoiceForm({
	productId,
	location,
	mode = 'invoice',
	defaultSeats = 5,
}: {
	productId: string
	location: string
	mode?: 'invoice' | 'request'
	defaultSeats?: number
}) {
	const id = React.useId()
	const field = (name: string) => `${id}-${name}`
	const [result, setResult] = React.useState<TeamInvoiceResult>()

	const form = useForm<TeamInvoiceFormInput>({
		resolver: zodResolver(teamInvoiceSchema),
		defaultValues: {
			productId,
			companyName: '',
			billingEmail: '',
			seats: defaultSeats,
			address: {
				line1: '',
				line2: '',
				city: '',
				state: '',
				postalCode: '',
				country: '',
			},
			taxId: '',
			poNumber: '',
			terms: 'due_on_receipt',
			website: '',
			timestamp: new Date().toISOString(),
		},
	})

	const onSubmit = async (values: TeamInvoiceFormInput) => {
		setResult(undefined)
		const next = await requestTeamInvoice({ ...values, location })
		setResult(next)
	}

	const errors = form.formState.errors
	const firstError =
		errors.companyName?.message ??
		errors.billingEmail?.message ??
		errors.seats?.message ??
		errors.address?.message ??
		errors.address?.country?.message ??
		errors.taxId?.message ??
		errors.poNumber?.message
	const message = result ? teamInvoiceResultMessage(result) : null
	const done =
		result?.kind === 'confirm-sent' ||
		result?.kind === 'sent' ||
		result?.kind === 'requested'

	if (done && message) {
		return (
			<p
				role="status"
				aria-live="polite"
				className={cn(
					TYPE.meta,
					'bg-card flex items-start gap-2 rounded-[9px] border px-5 py-4 font-semibold',
				)}
			>
				<CheckIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
				{message.text}
			</p>
		)
	}

	return (
		<Form {...form}>
			<form
				onSubmit={form.handleSubmit(onSubmit)}
				className="flex flex-col space-y-5"
				aria-label={mode === 'invoice' ? 'Pay by invoice' : 'Request an invoice'}
			>
				<input type="hidden" {...form.register('timestamp')} />
				<input type="hidden" {...form.register('productId')} />

				{/* Honeypot: off-screen, out of the tab order. */}
				<div className="absolute left-[-9999px] top-[-9999px] h-0 w-0 opacity-0">
					<Label htmlFor={field('website')}>Website</Label>
					<Input
						{...form.register('website')}
						id={field('website')}
						type="text"
						tabIndex={-1}
						autoComplete="off"
					/>
				</div>

				<div className="grid gap-5 md:grid-cols-2">
					<div className={FIELD}>
						<Label htmlFor={field('company')}>Company name</Label>
						<Input
							{...form.register('companyName')}
							id={field('company')}
							autoComplete="organization"
						/>
					</div>
					<div className={FIELD}>
						<Label htmlFor={field('email')}>Billing email</Label>
						<Input
							{...form.register('billingEmail')}
							id={field('email')}
							type="email"
							autoComplete="email"
						/>
					</div>
					<div className={FIELD}>
						<Label htmlFor={field('seats')}>Seats</Label>
						<Input
							{...form.register('seats')}
							id={field('seats')}
							type="number"
							inputMode="numeric"
							min={TEAM_INVOICE_MIN_SEATS}
							max={TEAM_INVOICE_MAX_SEATS}
						/>
					</div>
					<div className={FIELD}>
						<Label htmlFor={field('terms')}>Payment terms</Label>
						<Select
							onValueChange={(value) =>
								form.setValue('terms', value as TeamInvoiceFormInput['terms'])
							}
							value={form.watch('terms')}
						>
							<SelectTrigger id={field('terms')}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="due_on_receipt">Due on receipt</SelectItem>
								<SelectItem value="net_30">Net 30</SelectItem>
							</SelectContent>
						</Select>
					</div>
				</div>

				<fieldset className="grid gap-5 md:grid-cols-2">
					<legend className={cn(TYPE.groupLabel, 'mb-4')}>
						Billing address (optional)
					</legend>
					<div className={cn(FIELD, 'md:col-span-2')}>
						<Label htmlFor={field('line1')}>Address</Label>
						<Input
							{...form.register('address.line1')}
							id={field('line1')}
							autoComplete="address-line1"
						/>
					</div>
					<div className={cn(FIELD, 'md:col-span-2')}>
						<Label htmlFor={field('line2')}>Address line 2</Label>
						<Input
							{...form.register('address.line2')}
							id={field('line2')}
							autoComplete="address-line2"
						/>
					</div>
					<div className={FIELD}>
						<Label htmlFor={field('city')}>City</Label>
						<Input
							{...form.register('address.city')}
							id={field('city')}
							autoComplete="address-level2"
						/>
					</div>
					<div className={FIELD}>
						<Label htmlFor={field('state')}>State or region</Label>
						<Input
							{...form.register('address.state')}
							id={field('state')}
							autoComplete="address-level1"
						/>
					</div>
					<div className={FIELD}>
						<Label htmlFor={field('postal')}>Postal code</Label>
						<Input
							{...form.register('address.postalCode')}
							id={field('postal')}
							autoComplete="postal-code"
						/>
					</div>
					<div className={FIELD}>
						<Label htmlFor={field('country')}>Country code</Label>
						<Input
							{...form.register('address.country')}
							id={field('country')}
							placeholder="US"
							maxLength={2}
							autoComplete="country"
						/>
					</div>
				</fieldset>

				<div className="grid gap-5 md:grid-cols-2">
					<div className={FIELD}>
						<Label htmlFor={field('tax')}>Tax ID (optional)</Label>
						<Input {...form.register('taxId')} id={field('tax')} />
					</div>
					<div className={FIELD}>
						<Label htmlFor={field('po')}>PO number (optional)</Label>
						<Input {...form.register('poNumber')} id={field('po')} />
					</div>
				</div>

				<Button
					type="submit"
					size="lg"
					disabled={form.formState.isSubmitting}
					className={cn(WORKSHOP_CTA_BUTTON, 'w-full')}
				>
					{form.formState.isSubmitting ? (
						<>
							<Spinner className="w-4" aria-hidden="true" /> Sending...
						</>
					) : mode === 'invoice' ? (
						'Email me a link to confirm'
					) : (
						'Request an invoice'
					)}
				</Button>

				{(firstError || message) && (
					<p
						role="alert"
						className="bg-destructive text-destructive-foreground flex items-center gap-2 rounded-md px-5 py-3 font-medium leading-tight"
					>
						<XCircleIcon className="size-5 shrink-0" aria-hidden="true" />
						{firstError ?? message?.text}
					</p>
				)}
			</form>
		</Form>
	)
}
