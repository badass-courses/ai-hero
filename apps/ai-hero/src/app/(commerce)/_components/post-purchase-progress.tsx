'use client'

import { TYPE } from '@/components/landing/type'
import { Progress } from '@coursebuilder/ui'

export type PurchaseStep = 'processing' | 'slow' | 'ready' | 'email' | 'failed'

export function PostPurchaseProgress({
	step,
	paymentConfirmed = false,
}: {
	step: PurchaseStep
	paymentConfirmed?: boolean
}) {
	const accessReady = step === 'ready' || step === 'email'
	const labels = [
		paymentConfirmed || accessReady
			? 'Payment confirmed'
			: 'Confirming payment',
		step === 'failed'
			? 'Needs a hand'
			: accessReady
				? 'Access set up'
				: 'Setting up access',
		step === 'email' ? 'Check your email' : 'Ready',
	]
	const values = [
		paymentConfirmed || accessReady ? 100 : 50,
		accessReady ? 100 : step === 'failed' ? 0 : 50,
		step === 'ready' ? 100 : 0,
	]
	return (
		<ol aria-label="Purchase progress" className="grid grid-cols-3 gap-3">
			{labels.map((label, index) => (
				<li key={index} className={`${TYPE.metaSm} flex flex-col gap-3`}>
					<Progress
						aria-label={label}
						value={values[index]}
						className="h-1 rounded-sm bg-muted [&>div]:bg-accent-fill [&>div]:motion-reduce:transition-none"
					/>
					<span>
						{values[index] === 100 ? '✓ ' : ''}
						{label}
					</span>
				</li>
			))}
		</ol>
	)
}
