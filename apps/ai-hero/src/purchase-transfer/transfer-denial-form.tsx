'use client'

import * as React from 'react'

import * as PurchaseTransfer from '@coursebuilder/commerce-next/post-purchase/purchase-transfer'

import { isTransferDenialResult } from './transfer-result'

const DenialContext = React.createContext<string | null>(null)

/** The refusal, shown inline where the transfer form lives. */
export function TransferDenialNotice({
	message,
	className,
}: {
	message: string | null
	className?: string
}) {
	if (!message) return null
	return (
		<p role="alert" className={className ?? 'text-destructive text-sm'}>
			{message}
		</p>
	)
}

export function TransferDenialMessage({ className }: { className?: string }) {
	return (
		<TransferDenialNotice
			message={React.useContext(DenialContext)}
			className={className}
		/>
	)
}

/**
 * The kit's `Root`, with `initiatePurchaseTransfer` wrapped so an expected
 * denial (returned as `{ ok: false, message }`) is kept in state and shown by
 * `TransferDenialMessage` instead of vanishing. Place the message as a child
 * of this root.
 */
export function TransferDenialRoot({
	initiatePurchaseTransfer,
	children,
	...props
}: React.ComponentProps<typeof PurchaseTransfer.Root>) {
	const [message, setMessage] = React.useState<string | null>(null)

	const initiate = React.useCallback<typeof initiatePurchaseTransfer>(
		async (input) => {
			setMessage(null)
			const result = await initiatePurchaseTransfer(input)
			if (isTransferDenialResult(result)) setMessage(result.message)
			return result
		},
		[initiatePurchaseTransfer],
	)

	return (
		<DenialContext.Provider value={message}>
			<PurchaseTransfer.Root {...props} initiatePurchaseTransfer={initiate}>
				{children}
			</PurchaseTransfer.Root>
		</DenialContext.Provider>
	)
}
