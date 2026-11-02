'use client'

import * as React from 'react'
import { TYPE } from '@/components/landing/type'

import { cn } from '@coursebuilder/ui/utils/cn'

/**
 * Which of a quiz's questions have been checked, and whether each was right,
 * so the quiz's header can answer once all of them are. Each question
 * reports itself by id.
 */
const QuizProgressContext = React.createContext<{
	total: number
	checked: ReadonlyMap<string, boolean>
	markChecked: (questionId: string, correct: boolean) => void
} | null>(null)

export function QuizProgress({
	total,
	children,
}: {
	total: number
	children: React.ReactNode
}) {
	const [checked, setChecked] = React.useState<ReadonlyMap<string, boolean>>(
		() => new Map(),
	)
	const markChecked = React.useCallback(
		(questionId: string, correct: boolean) => {
			setChecked((current) =>
				current.get(questionId) === correct
					? current
					: new Map(current).set(questionId, correct),
			)
		},
		[],
	)
	const value = React.useMemo(
		() => ({ total, checked, markChecked }),
		[total, checked, markChecked],
	)
	return (
		<QuizProgressContext.Provider value={value}>
			{children}
		</QuizProgressContext.Provider>
	)
}

/** Reports a question as checked, right or not, once it is answered. */
export function useReportChecked(
	questionId: string,
	answered: boolean,
	correct: boolean,
) {
	const markChecked = React.useContext(QuizProgressContext)?.markChecked
	React.useEffect(() => {
		if (answered) markChecked?.(questionId, correct)
	}, [answered, correct, markChecked, questionId])
}

/** The line under the heading once every question is checked, by score. */
function verdict(right: number, total: number) {
	if (right === total)
		return total === 1 ? 'Nailed it.' : `All ${total} right. Nailed it.`
	if (right === 0)
		return `0 of ${total}. Worth another pass through the lesson.`
	return `${right} of ${total} right. The explanations cover the rest.`
}

/**
 * The quiz's mark and heading. The mark sits quiet in gray until every
 * question is checked; then it answers the score: gold with one soft pulse
 * for a clean sweep, full ink for anything less.
 */
export function QuizHeader() {
	const progress = React.useContext(QuizProgressContext)
	const total = progress?.total ?? 0
	const done = total > 0 && (progress?.checked.size ?? 0) >= total
	const right = [...(progress?.checked.values() ?? [])].filter(Boolean).length
	const perfect = done && right === total
	return (
		<div className="flex items-center gap-3">
			<span
				data-done={done || undefined}
				data-perfect={perfect || undefined}
				className="bg-background dark:bg-card text-muted-foreground data-done:text-foreground data-perfect:border-primary/40 data-perfect:bg-primary/10 dark:data-perfect:bg-primary/10 data-perfect:text-primary relative flex size-10 shrink-0 items-center justify-center rounded-[9px] border transition-colors duration-500"
			>
				{perfect && (
					<span
						aria-hidden="true"
						className="border-primary/60 pointer-events-none absolute inset-0 rounded-[9px] border motion-safe:animate-[quiz-done_900ms_ease-out_forwards] motion-reduce:hidden"
					/>
				)}
				<QuizIcon className="size-5" />
			</span>
			<div>
				<h2 className={cn(TYPE.panelTitle, 'text-balance')}>
					Check your understanding
				</h2>
				<p className={cn(TYPE.metaMark, 'mt-1')} aria-live="polite">
					{done
						? verdict(right, total)
						: 'Answer each question, then check your answer.'}
				</p>
			</div>
		</div>
	)
}

/** Hugeicons' Quiz 03 (MIT): a clipboard of ticked answers. */
function QuizIcon({ className }: { className?: string }) {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.5}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			className={className}
		>
			<path d="M7.5 3.5C5.9442 3.54667 5.01661 3.71984 4.37477 4.36227C3.49609 5.24177 3.49609 6.6573 3.49609 9.48836L3.49609 15.9944C3.49609 18.8255 3.49609 20.241 4.37477 21.1205C5.25345 22 6.66767 22 9.49609 22L14.4961 22C17.3245 22 18.7387 22 19.6174 21.1205C20.4961 20.241 20.4961 18.8255 20.4961 15.9944V9.48836C20.4961 6.6573 20.4961 5.24177 19.6174 4.36228C18.9756 3.71984 18.048 3.54667 16.4922 3.5" />
			<path d="M7.49609 3.75C7.49609 2.7835 8.2796 2 9.24609 2H14.7461C15.7126 2 16.4961 2.7835 16.4961 3.75C16.4961 4.7165 15.7126 5.5 14.7461 5.5H9.24609C8.2796 5.5 7.49609 4.7165 7.49609 3.75Z" />
			<path d="M6.5 10L10.5 10" />
			<path d="M13.5 11C13.5 11 14 11 14.5 12C14.5 12 16.0882 9.5 17.5 9" />
			<path d="M6.5 16L10.5 16" />
			<path d="M13.5 17C13.5 17 14 17 14.5 18C14.5 18 16.0882 15.5 17.5 15" />
		</svg>
	)
}
