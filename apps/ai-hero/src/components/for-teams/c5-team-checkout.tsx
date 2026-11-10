'use client'

import * as React from 'react'
import { TYPE } from '@/components/landing/type'
import { WORKSHOP_CTA_BUTTON } from '@/app/(content)/workshops/_components/workshop-cta-button'

import { buildStripeCheckoutPath } from '@coursebuilder/commerce/build-stripe-checkout-path'
import { cn } from '@coursebuilder/ui/utils/cn'

export function c5TeamCheckoutPath(quantity: number, cancelUrl: string) {
	if (!Number.isInteger(quantity) || quantity < 2 || quantity > 100) {
		throw new RangeError('Choose between 2 and 100 team seats')
	}
	return buildStripeCheckoutPath({
		productId: 'product-s00zs',
		quantity,
		bulk: true,
		cancelUrl,
	})
}

/** Uses the same POST and checkout-path builder as the product buy form. */
export function C5TeamCheckout({ cancelUrl }: { cancelUrl: string }) {
	const id = React.useId()
	const [seats, setSeats] = React.useState('5')
	const quantity = Number(seats)
	const valid = Number.isInteger(quantity) && quantity >= 2 && quantity <= 100

	return (
		<form
			action={c5TeamCheckoutPath(valid ? quantity : 5, cancelUrl)}
			method="POST"
			className="mt-6 flex flex-wrap items-end gap-3"
		>
			<div className="flex flex-col gap-2">
				<label htmlFor={id} className={cn(TYPE.meta, 'font-medium')}>
					Seats
				</label>
				<input
					id={id}
					name="seats"
					type="number"
					min={2}
					max={100}
					step={1}
					required
					value={seats}
					onChange={(event) => setSeats(event.target.value)}
					className={cn(
						TYPE.meta,
						'border-input bg-background focus-visible:ring-ring h-12 w-28 rounded-[9px] border px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
					)}
				/>
			</div>
			<button
				type="submit"
				disabled={!valid}
				className={cn(
					WORKSHOP_CTA_BUTTON,
					'h-[50px] disabled:cursor-not-allowed disabled:opacity-50',
				)}
			>
				Buy seats
			</button>
		</form>
	)
}
