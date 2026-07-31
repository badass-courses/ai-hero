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
			const response = await resendSkillsCourseLessonOne(source)
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
				onClick={resend}
				disabled={isPending || result === 'sent'}
				className={cn(
					'bg-accent-fill text-accent-fill-foreground hover:bg-accent-fill-hover focus-visible:ring-ring inline-flex h-11 min-w-[184px] cursor-pointer items-center justify-center rounded-[9px] px-5 text-sm font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60',
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
