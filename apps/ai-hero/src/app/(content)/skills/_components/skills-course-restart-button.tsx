'use client'

import * as React from 'react'
import Spinner from '@/components/spinner'

import { cn } from '@coursebuilder/utils/cn'

import { resendSkillsCourseLessonOne } from './skills-course-restart-actions'

export function SkillsCourseRestartButton({
	source,
	className,
}: {
	source: string
	className?: string
}) {
	const [isPending, startTransition] = React.useTransition()
	const [result, setResult] = React.useState<'sent' | 'error' | null>(null)

	const resend = () => {
		setResult(null)
		startTransition(async () => {
			const response = await resendSkillsCourseLessonOne()
			if (response.success) {
				setResult('sent')
			} else if (response.reason === 'confirmation-required') {
				window.location.assign(response.confirmationUrl)
			} else {
				setResult('error')
			}
		})
	}

	return (
		<div className="flex flex-col items-start gap-2.5">
			<button
				type="button"
				data-recovery-surface={source}
				onClick={resend}
				disabled={isPending || result === 'sent'}
				className={cn(
					'border-primary text-primary hover:bg-primary/10 focus-visible:ring-ring inline-flex h-11 min-w-[184px] cursor-pointer items-center justify-center rounded-[9px] border bg-transparent px-5 text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60',
					className,
				)}
			>
				{isPending ? (
					<Spinner className="size-4" />
				) : result === 'sent' ? (
					'Lesson one sent'
				) : (
					'Send lesson one again'
				)}
			</button>
			{result === 'sent' ? (
				<p className="text-primary text-sm font-medium" role="status">
					Lesson one is on its way again.
				</p>
			) : result === 'error' ? (
				<p className="text-destructive text-sm" role="alert">
					We could not resend lesson one. Please try again.
				</p>
			) : null}
		</div>
	)
}

/** Compact completed-state bar shared by course CTA placements. */
export function SkillsCourseRecoveryBar({
	source,
	justEnrolled = false,
	className,
}: {
	source: string
	justEnrolled?: boolean
	className?: string
}) {
	return (
		<aside
			aria-label="AI Skills for Real Engineers course recovery"
			className={cn(
				'border-border bg-muted/40 flex w-full flex-col items-start gap-3 rounded-lg border px-4 py-3 sm:flex-row sm:items-center sm:justify-between',
				className,
			)}
		>
			<p className="text-foreground/80 text-sm leading-relaxed">
				{justEnrolled ? 'You’re' : 'Already'} enrolled in{' '}
				<strong className="text-foreground font-semibold">
					AI Skills for Real Engineers
				</strong>
				{justEnrolled ? '.' : '?'}
			</p>
			<SkillsCourseRestartButton
				source={source}
				className="h-9 min-w-0 shrink-0 rounded-md px-3 text-xs"
			/>
		</aside>
	)
}
