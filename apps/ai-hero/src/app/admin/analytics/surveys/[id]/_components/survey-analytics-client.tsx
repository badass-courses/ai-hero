'use client'

import { useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { format } from 'date-fns'
import {
	BarChart3Icon,
	ClipboardListIcon,
	DownloadIcon,
	UsersIcon,
} from 'lucide-react'

import {
	Badge,
	Button,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@coursebuilder/ui'

interface SurveyAnalyticsClientProps {
	range: string
	summary: {
		totalResponses: number
		uniqueRespondents: number
		questionCount: number
	}
	responsesByDay: { date: string; responses: number }[]
	questionBreakdown: {
		questionId: string
		question: string
		type: string | null
		responses: number
		answerDistribution: { answer: string; count: number }[]
	}[]
	responses: {
		responseId: string
		question: string
		questionType: string | null
		answer: string
		userEmail: string | null
		emailListSubscriberId: string | null
		createdAt: string
	}[]
}

const RANGES = ['24h', '7d', '30d', '90d', 'all'] as const

export function SurveyAnalyticsClient({
	range,
	summary,
	responsesByDay,
	questionBreakdown,
	responses,
}: SurveyAnalyticsClientProps) {
	const router = useRouter()
	const searchParams = useSearchParams()

	const setRange = useCallback(
		(newRange: string) => {
			const params = new URLSearchParams(searchParams.toString())
			params.set('range', newRange)
			router.push(`?${params.toString()}`)
		},
		[router, searchParams],
	)

	const downloadCsv = useCallback(() => {
		const escape = (v: string) => {
			const s = String(v || '')
			if (s.includes(',') || s.includes('"') || s.includes('\n')) {
				return `"${s.replace(/"/g, '""')}"`
			}
			return s
		}

		const headers = [
			'Answer',
			'Question',
			'Type',
			'User Email',
			'Subscriber ID',
			'Date',
		]
		const rows = responses.map((r) =>
			[
				escape(r.answer),
				escape(r.question),
				escape(r.questionType ?? ''),
				escape(r.userEmail ?? ''),
				escape(r.emailListSubscriberId ?? ''),
				escape(
					r.createdAt ? format(new Date(r.createdAt), 'yyyy-MM-dd HH:mm') : '',
				),
			].join(','),
		)

		const csv = [headers.join(','), ...rows].join('\n')
		const blob = new Blob([csv], { type: 'text/csv' })
		const url = URL.createObjectURL(blob)
		const a = document.createElement('a')
		a.href = url
		a.download = `survey-responses-${range}.csv`
		a.click()
		URL.revokeObjectURL(url)
	}, [responses, range])

	return (
		<div className="flex flex-col gap-5">
			{/* Range selector */}
			<div className="flex items-center justify-between">
				<div className="border-border/40 bg-muted/20 inline-flex items-center gap-0.5 rounded-lg border p-0.5">
					{RANGES.map((r) => (
						<button
							key={r}
							onClick={() => setRange(r)}
							className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
								range === r
									? 'bg-foreground text-background shadow-sm'
									: 'text-muted-foreground hover:text-foreground'
							}`}
						>
							{r === 'all' ? 'All' : r}
						</button>
					))}
				</div>
				<Button variant="outline" size="sm" onClick={downloadCsv}>
					<DownloadIcon className="mr-1.5 size-3.5" />
					Export CSV
				</Button>
			</div>

			{/* Summary stats */}
			<div className="grid grid-cols-3 gap-3">
				<Card>
					<CardContent className="p-4">
						<div className="flex items-center gap-2">
							<BarChart3Icon className="text-muted-foreground size-4" />
							<span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wider">
								Responses
							</span>
						</div>
						<p className="mt-1 text-2xl font-bold tabular-nums">
							{summary.totalResponses.toLocaleString()}
						</p>
					</CardContent>
				</Card>
				<Card>
					<CardContent className="p-4">
						<div className="flex items-center gap-2">
							<UsersIcon className="text-muted-foreground size-4" />
							<span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wider">
								Respondents
							</span>
						</div>
						<p className="mt-1 text-2xl font-bold tabular-nums">
							{summary.uniqueRespondents.toLocaleString()}
						</p>
					</CardContent>
				</Card>
				<Card>
					<CardContent className="p-4">
						<div className="flex items-center gap-2">
							<ClipboardListIcon className="text-muted-foreground size-4" />
							<span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wider">
								Questions
							</span>
						</div>
						<p className="mt-1 text-2xl font-bold tabular-nums">
							{summary.questionCount}
						</p>
					</CardContent>
				</Card>
			</div>

			{/* Responses by day */}
			{responsesByDay.length > 0 && (
				<Card>
					<CardHeader className="pb-3">
						<CardTitle className="text-sm font-semibold">
							Responses by Day
						</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="flex h-32 items-end gap-[2px]">
							{responsesByDay.map((d) => {
								const max = Math.max(...responsesByDay.map((r) => r.responses))
								const pct = max > 0 ? (d.responses / max) * 100 : 0
								return (
									<div
										key={d.date}
										className="group relative flex-1"
										title={`${d.date}: ${d.responses}`}
									>
										<div
											className="bg-primary/20 hover:bg-primary/40 w-full min-w-[3px] rounded-t transition-colors"
											style={{ height: `${Math.max(pct, 2)}%` }}
										/>
									</div>
								)
							})}
						</div>
						<div className="text-muted-foreground mt-2 flex justify-between text-[10px]">
							<span>{responsesByDay[0]?.date}</span>
							<span>{responsesByDay[responsesByDay.length - 1]?.date}</span>
						</div>
					</CardContent>
				</Card>
			)}

			{/* Question breakdown */}
			{questionBreakdown.length > 0 && (
				<Card>
					<CardHeader className="pb-3">
						<CardTitle className="text-sm font-semibold">
							Question Breakdown
						</CardTitle>
						<CardDescription className="text-[11px]">
							Answer distribution per question
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-6">
						{questionBreakdown.map((q) => {
							const total = q.answerDistribution.reduce(
								(s, a) => s + a.count,
								0,
							)
							return (
								<div key={q.questionId}>
									<div className="mb-2.5 flex items-start justify-between gap-2">
										<div className="min-w-0">
											<p className="text-foreground text-[13px] font-medium leading-snug">
												{q.question}
											</p>
											{q.type && (
												<Badge variant="outline" className="mt-1 text-[10px]">
													{q.type}
												</Badge>
											)}
										</div>
										<span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
											{total.toLocaleString()} responses
										</span>
									</div>
									<div className="space-y-1.5">
										{q.answerDistribution.slice(0, 8).map((a) => {
											const pct = total > 0 ? (a.count / total) * 100 : 0
											return (
												<div
													key={a.answer}
													className="flex items-center gap-2.5"
												>
													<span
														className="text-muted-foreground w-[140px] shrink-0 truncate text-right text-[12px]"
														title={a.answer}
													>
														{a.answer}
													</span>
													<div className="bg-muted/50 relative h-5 flex-1 overflow-hidden rounded">
														<div
															className="absolute inset-y-0 left-0 rounded bg-indigo-500/20 transition-all"
															style={{ width: `${Math.max(pct, 1)}%` }}
														/>
														<div className="relative flex h-full items-center px-2">
															<span className="text-foreground/70 text-[11px] tabular-nums">
																{pct.toFixed(0)}%
															</span>
														</div>
													</div>
													<span className="text-muted-foreground w-10 shrink-0 text-right text-[11px] tabular-nums">
														{a.count.toLocaleString()}
													</span>
												</div>
											)
										})}
										{q.answerDistribution.length > 8 && (
											<p className="text-muted-foreground/60 pl-[152px] text-[11px]">
												+{q.answerDistribution.length - 8} more answers
											</p>
										)}
									</div>
								</div>
							)
						})}
					</CardContent>
				</Card>
			)}

			{/* Responses table */}
			<Card>
				<CardHeader className="flex flex-row items-center justify-between pb-3">
					<div>
						<CardTitle className="text-sm font-semibold">
							Individual Responses
						</CardTitle>
						<CardDescription className="text-[11px]">
							{responses.length.toLocaleString()} responses shown
						</CardDescription>
					</div>
				</CardHeader>
				<CardContent>
					<div className="max-h-[600px] overflow-auto">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead className="min-w-[250px]">Answer</TableHead>
									<TableHead className="min-w-[200px]">Question</TableHead>
									<TableHead>Type</TableHead>
									<TableHead className="min-w-[180px]">User</TableHead>
									<TableHead className="min-w-[140px]">Date</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{responses.map((r) => (
									<TableRow key={r.responseId}>
										<TableCell className="max-w-[400px]">
											<p className="line-clamp-3 text-sm">{r.answer}</p>
										</TableCell>
										<TableCell className="max-w-[300px]">
											<p className="line-clamp-2 text-sm">{r.question}</p>
										</TableCell>
										<TableCell>
											{r.questionType && (
												<Badge variant="outline" className="text-[10px]">
													{r.questionType}
												</Badge>
											)}
										</TableCell>
										<TableCell className="text-muted-foreground text-sm">
											{r.userEmail || r.emailListSubscriberId || '—'}
										</TableCell>
										<TableCell className="text-muted-foreground whitespace-nowrap text-sm">
											{r.createdAt
												? format(new Date(r.createdAt), 'MM/dd/yy HH:mm')
												: '—'}
										</TableCell>
									</TableRow>
								))}
								{responses.length === 0 && (
									<TableRow>
										<TableCell
											colSpan={5}
											className="text-muted-foreground py-8 text-center"
										>
											No responses in this time range.
										</TableCell>
									</TableRow>
								)}
							</TableBody>
						</Table>
					</div>
				</CardContent>
			</Card>
		</div>
	)
}
