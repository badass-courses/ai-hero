'use client'

import * as React from 'react'
import { useMachine } from '@xstate/react'
import { createInvoiceShareMachine } from '@/lib/invoice-share-machine'
import { Button } from '@coursebuilder/ui'
import {
	copyInvoiceShareLinkAction,
	rotateInvoiceShareLinkAction,
} from '../actions'

export function InvoiceShareControls({
	merchantChargeId,
}: {
	merchantChargeId: string
}) {
	const machine = React.useMemo(
		() =>
			createInvoiceShareMachine({
				mint: () => copyInvoiceShareLinkAction(merchantChargeId),
				rotate: () => rotateInvoiceShareLinkAction(merchantChargeId),
				copy: (path) =>
					navigator.clipboard.writeText(
						new URL(path, window.location.origin).href,
					),
			}),
		[merchantChargeId],
	)
	const [state, send] = useMachine(machine)
	const busy = state.matches('working')
	return (
		<div className="flex flex-wrap items-center gap-2 print:hidden">
			<Button
				type="button"
				variant="secondary"
				disabled={busy}
				onClick={() => send({ type: 'COPY' })}
			>
				Copy share link
			</Button>
			<Button
				type="button"
				variant="secondary"
				disabled={busy}
				onClick={() => send({ type: 'ROTATE' })}
			>
				Rotate link
			</Button>
			<span aria-live="polite" className="text-sm">
				{state.context.message}
			</span>
		</div>
	)
}
