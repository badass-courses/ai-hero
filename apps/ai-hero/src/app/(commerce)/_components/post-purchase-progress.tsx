'use client'

import { TYPE } from '@/components/landing/type'
import { Check } from 'lucide-react'

import { Progress } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

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
		<ol aria-label="Purchase progress" className="grid grid-cols-3 gap-2 sm:gap-3">
			{labels.map((label, index) => {
				const done = values[index] === 100
				return (
					<li key={index} className="flex min-w-0 flex-col gap-2.5">
						<Progress
							aria-label={label}
							value={values[index]}
							className="bg-foreground/10 h-[3px] rounded-[4px] [&>div]:bg-accent-fill [&>div]:motion-reduce:transition-none"
						/>
						<span
							className={cn(
								TYPE.metaSm,
								'flex items-start gap-1.5',
								done ? 'text-foreground' : 'text-muted-foreground',
							)}
						>
							{done ? (
								<Check
									aria-hidden="true"
									strokeWidth={2.5}
									className="mt-[2px] size-3.5 shrink-0"
								/>
							) : null}
							<span className="min-w-0 text-balance">{label}</span>
						</span>
					</li>
				)
			})}
		</ol>
	)
}
