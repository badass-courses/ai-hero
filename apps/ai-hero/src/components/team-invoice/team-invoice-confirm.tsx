'use client'

import * as React from 'react'
import { WORKSHOP_CTA_BUTTON } from '@/app/(content)/workshops/_components/workshop-cta-button'
import { TYPE } from '@/components/landing/type'
import type { TeamInvoiceResult } from '@/lib/team-invoice/schema'
import { CheckIcon, XCircleIcon } from 'lucide-react'

import { Button } from '@coursebuilder/ui'
import Spinner from '@coursebuilder/ui/primitives/spinner'
import { cn } from '@coursebuilder/ui/utils/cn'

import { confirmTeamInvoiceAction } from './team-invoice-actions'
import { teamInvoiceResultMessage } from './team-invoice-form'

/** The one button that turns a confirmed order into a Stripe invoice. */
export function TeamInvoiceConfirm({ token }: { token: string }) {
	const [result, setResult] = React.useState<TeamInvoiceResult>()
	const [pending, startTransition] = React.useTransition()
	const message = result ? teamInvoiceResultMessage(result) : null

	if (message?.tone === 'success') {
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
		<div className="flex flex-col gap-4">
			<Button
				type="button"
				size="lg"
				disabled={pending}
				className={cn(WORKSHOP_CTA_BUTTON, 'w-full')}
				onClick={() =>
					startTransition(async () => {
						setResult(await confirmTeamInvoiceAction(token))
					})
				}
			>
				{pending ? (
					<>
						<Spinner className="w-4" aria-hidden="true" /> Sending...
					</>
				) : (
					'Send the invoice'
				)}
			</Button>
			{message ? (
				<p
					role="alert"
					className="bg-destructive text-destructive-foreground flex items-center gap-2 rounded-md px-5 py-3 font-medium leading-tight"
				>
					<XCircleIcon className="size-5 shrink-0" aria-hidden="true" />
					{message.text}
				</p>
			) : null}
		</div>
	)
}
