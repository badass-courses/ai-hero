import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getCourseSyncHistory } from '@/course-sync/history'
import { getServerAuthSession } from '@/server/auth'
import { format } from 'date-fns'

function short(value: string | null, length = 12) {
	if (!value) return '—'
	return value.length > length ? value.slice(0, length) : value
}

function displayCount(value: number | null) {
	return value === null ? '—' : value.toLocaleString()
}

function displayDuration(seconds: number | null) {
	return seconds === null ? '—' : `${Math.floor(seconds / 60)} min`
}

export default async function CourseSyncHistoryDetailPage({
	params,
}: {
	params: Promise<{ courseVersionId: string }>
}) {
	const { ability } = await getServerAuthSession()
	if (ability.cannot('manage', 'all')) notFound()

	const { courseVersionId } = await params
	const history = await getCourseSyncHistory(courseVersionId)
	if (!history) notFound()

	return (
		<main className="flex w-full flex-1 flex-col">
			<header className="px-8 py-10 sm:px-16">
				<Link
					href="/admin/course-sync"
					className="font-mono text-[11px] font-medium uppercase tracking-wider underline-offset-4 opacity-60 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
				>
					Course sync history
				</Link>
				<h1 className="mt-4 text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
					{history.courseName ?? short(history.courseVersionId, 8)}
				</h1>
				<p className="text-muted-foreground mt-3 break-all font-mono text-sm">
					{history.courseVersionId}
				</p>
			</header>

			<section className="border-y">
				<dl className="bg-border grid gap-px sm:grid-cols-2 xl:grid-cols-4">
					<div className="bg-background px-8 py-6">
						<dt className="font-mono text-[11px] uppercase tracking-wider opacity-60">
							Outcome
						</dt>
						<dd className="mt-2 font-semibold">{history.outcome}</dd>
						{history.failureClass && (
							<dd className="text-muted-foreground mt-1 break-words font-mono text-xs">
								{history.failureClass}
							</dd>
						)}
					</div>
					<div className="bg-background px-8 py-6">
						<dt className="font-mono text-[11px] uppercase tracking-wider opacity-60">
							Provider revision
						</dt>
						<dd className="mt-2 break-all font-mono text-sm">
							{history.providerRevision}
						</dd>
					</div>
					<div className="bg-background px-8 py-6">
						<dt className="font-mono text-[11px] uppercase tracking-wider opacity-60">
							Manifest SHA
						</dt>
						<dd className="mt-2 font-mono text-sm">
							{short(history.manifestSha256)}
						</dd>
					</div>
					<div className="bg-background px-8 py-6">
						<dt className="font-mono text-[11px] uppercase tracking-wider opacity-60">
							Mux readiness
						</dt>
						<dd className="mt-2 font-semibold tabular-nums">
							{displayCount(history.muxReadyCount)} of{' '}
							{displayCount(history.videoCount)}
							{' assets ready'}
						</dd>
					</div>
					<div className="bg-background px-8 py-6">
						<dt className="font-mono text-[11px] uppercase tracking-wider opacity-60">
							Structure
						</dt>
						<dd className="mt-2 leading-relaxed tabular-nums">
							{displayCount(history.sectionCount)} sections
							<br />
							{displayCount(history.lessonCount)} lessons
							<br />
							{displayCount(history.videoCount)} videos
						</dd>
					</div>
					<div className="bg-background px-8 py-6">
						<dt className="font-mono text-[11px] uppercase tracking-wider opacity-60">
							Duration
						</dt>
						<dd className="mt-2 font-semibold tabular-nums">
							{displayDuration(history.durationSeconds)}
						</dd>
					</div>
					<div className="bg-background px-8 py-6">
						<dt className="font-mono text-[11px] uppercase tracking-wider opacity-60">
							Binding
						</dt>
						<dd className="mt-2 font-mono text-sm">
							{short(history.bindingId)}
						</dd>
						<dd className="text-muted-foreground mt-1 text-xs">
							{history.binding?.status ?? 'unknown'}
						</dd>
					</div>
					<div className="bg-background px-8 py-6">
						<dt className="font-mono text-[11px] uppercase tracking-wider opacity-60">
							Last activity
						</dt>
						<dd className="mt-2 tabular-nums">
							{format(history.when, 'MMM d, yyyy HH:mm:ss')}
						</dd>
					</div>
				</dl>
			</section>

			<section>
				<div className="px-8 py-10 sm:px-16">
					<h2 className="text-3xl font-medium leading-tight tracking-tight">
						Run attempts
					</h2>
					<p className="text-muted-foreground mt-2 max-w-2xl">
						The poll trail in time order, from detection through apply, hold,
						retry, or skip.
					</p>
					{history.idlePollCount > 0 && (
						<p className="text-muted-foreground mt-2 font-mono text-xs">
							{history.idlePollCount.toLocaleString()} idle poll{' '}
							{history.idlePollCount === 1 ? 'cycle' : 'cycles'} (nothing new
							detected) are counted here but not listed.
						</p>
					)}
				</div>

				{history.attempts.length === 0 ? (
					<div className="bg-stripes border-y px-8 py-16 text-center">
						<span className="bg-background font-mono text-xs uppercase tracking-wider">
							{history.idlePollCount > 0
								? 'Only idle poll cycles recorded'
								: 'No poll trail recorded'}
						</span>
					</div>
				) : (
					<ol className="border-y divide-y">
						{history.attempts.map((attempt, attemptIndex) => {
							const controlPlaneRun = history.runs.find(
								(run) => run.runId === attempt.controlPlaneRunId,
							)
							return (
								<li key={attempt.pollRunId} className="bg-background">
									<div className="grid gap-6 px-8 py-8 sm:px-16 lg:grid-cols-[14rem_minmax(0,1fr)]">
										<header>
											<p className="font-mono text-[11px] uppercase tracking-wider opacity-60">
												Attempt {attemptIndex + 1}
											</p>
											<h3 className="mt-2 text-2xl font-semibold leading-tight tracking-tight">
												{attempt.outcome}
											</h3>
											<p className="text-muted-foreground mt-2 font-mono text-xs tabular-nums">
												{format(attempt.startedAt, 'MMM d HH:mm:ss')}
											</p>
											<p className="text-muted-foreground mt-3 break-all font-mono text-xs">
												poll {attempt.pollRunId}
											</p>
											{controlPlaneRun && (
												<p className="text-muted-foreground mt-1 break-all font-mono text-xs">
													sync {controlPlaneRun.runId} ({controlPlaneRun.state})
												</p>
											)}
											{attempt.failureClass && (
												<p className="mt-3 break-words font-mono text-xs">
													{attempt.failureClass}
												</p>
											)}
										</header>

										<ol className="border-l pl-5">
											{attempt.events.map((event) => (
												<li key={event.id} className="relative pb-5 last:pb-0">
													<span className="bg-foreground absolute top-1.5 -left-[1.5rem] size-2 rounded-full" />
													<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
														<span className="font-mono text-xs font-semibold uppercase tracking-wider">
															{event.stage}
														</span>
														<span>{event.outcome}</span>
														<time className="text-muted-foreground font-mono text-xs tabular-nums">
															{format(event.occurredAt, 'HH:mm:ss.SSS')}
														</time>
													</div>
													{event.failureClass && (
														<p className="text-muted-foreground mt-1 break-words font-mono text-xs">
															{event.failureClass}
														</p>
													)}
												</li>
											))}
										</ol>
									</div>
								</li>
							)
						})}
					</ol>
				)}
			</section>
		</main>
	)
}
