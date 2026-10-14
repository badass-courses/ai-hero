'use client'

import * as React from 'react'
import { TYPE } from '@/components/landing/type'

import { Progress } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

import { CHECK_PATH } from './post-purchase-icon'
import styles from './post-purchase-motion.module.css'

/**
 * `opening` is the hand-over: the purchase has landed and the page that knows
 * whether this buyer is signed in is loading. It claims payment and access,
 * and leaves the last step to that page.
 */
export type PurchaseStep =
	| 'processing'
	| 'slow'
	| 'opening'
	| 'ready'
	| 'email'
	| 'failed'

/**
 * Three steps, taken one at a time. The step being worked on turns an arc and
 * runs a light along its bar; a finished step fills its bar and draws its
 * tick, in order, so a purchase that lands mid-wait reads as the steps
 * completing rather than the screen being swapped.
 */
export function PostPurchaseProgress({
	step,
	paymentConfirmed = false,
}: {
	step: PurchaseStep
	paymentConfirmed?: boolean
}) {
	const accessReady = step === 'opening' || step === 'ready' || step === 'email'
	const paid = paymentConfirmed || accessReady
	const working = step === 'processing' || step === 'slow' || step === 'opening'
	const labels = [
		paid ? 'Payment confirmed' : 'Confirming payment',
		step === 'failed'
			? 'Needs a hand'
			: accessReady
				? 'Access set up'
				: 'Setting up access',
		step === 'email'
			? 'Check your email'
			: step === 'opening'
				? 'Getting ready'
				: 'Ready',
	]
	const values = [
		paid ? 100 : 50,
		accessReady ? 100 : paid && step !== 'failed' ? 50 : 0,
		step === 'ready' ? 100 : 0,
	]
	// While opening, the last step turns without filling: the email screen
	// leaves it empty, and a bar should never empty in front of the buyer.
	const active = step === 'opening' ? 2 : working ? values.indexOf(50) : -1
	// A label that changes in place slides in; one that was there on the first
	// paint does not.
	const [firstLabels] = React.useState(labels)
	return (
		<ol aria-label="Purchase progress" className="grid grid-cols-3 gap-2 sm:gap-3">
			{labels.map((label, index) => {
				const state =
					values[index] === 100
						? 'done'
						: index === active
							? 'active'
							: 'waiting'
				return (
					<li
						key={index}
						data-state={state}
						style={{ '--delay': `${index * 80}ms` } as React.CSSProperties}
						className="flex min-w-0 flex-col gap-2.5"
					>
						<Progress
							aria-label={label}
							value={values[index]}
							style={{ '--fill': `${values[index]}%` } as React.CSSProperties}
							className={cn(
								'bg-foreground/10 h-[3px] rounded-[4px] [&>div]:bg-accent-fill [&>div]:motion-reduce:transition-none',
								styles.bar,
							)}
						/>
						<span
							className={cn(
								TYPE.metaSm,
								'flex items-start gap-1.5 transition-colors duration-500 motion-reduce:transition-none',
								state === 'waiting' ? 'text-muted-foreground' : 'text-foreground',
							)}
						>
							<StepMark />
							<span
								key={label}
								className={cn(
									'min-w-0 text-balance',
									label !== firstLabels[index] && styles.swap,
								)}
							>
								{label}
							</span>
						</span>
					</li>
				)
			})}
		</ol>
	)
}

/** Ring, arc and tick in one mark; the step's `data-state` picks which shows. */
function StepMark() {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={styles.stepIcon}
		>
			<circle cx="12" cy="12" r="9" strokeWidth={2.25} className={styles.ring} />
			<circle
				cx="12"
				cy="12"
				r="9"
				strokeWidth={2.25}
				pathLength={1}
				strokeDasharray="0.28 1"
				className={styles.arc}
			/>
			<path
				d={CHECK_PATH}
				strokeWidth={2.75}
				pathLength={1}
				className={styles.check}
			/>
		</svg>
	)
}
