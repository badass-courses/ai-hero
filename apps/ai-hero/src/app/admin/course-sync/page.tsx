import Link from 'next/link'
import { notFound } from 'next/navigation'
import { listCourseSyncHistory } from '@/course-sync/history'
import { getServerAuthSession } from '@/server/auth'
import { format } from 'date-fns'

function shortId(value: string) {
	return value.length > 12 ? value.slice(0, 8) : value
}

function count(value: number | null) {
	return value === null ? '—' : value.toLocaleString()
}

function duration(seconds: number | null) {
	return seconds === null ? '—' : `${Math.floor(seconds / 60)} min`
}

export default async function CourseSyncHistoryPage() {
	const { ability } = await getServerAuthSession()
	if (ability.cannot('manage', 'all')) notFound()

	const history = await listCourseSyncHistory()

	return (
		<main className="flex w-full flex-1 flex-col">
			<header className="px-8 py-10 sm:px-16">
				<p className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
					Admin
				</p>
				<h1 className="mt-2 text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
					Course sync history
				</h1>
				<p className="text-muted-foreground mt-3 max-w-2xl text-base leading-relaxed">
					Every detected source version, its current outcome, and the trail that
					produced it.
				</p>
			</header>

			<section className="border-y">
				{history.length === 0 ? (
					<div className="bg-stripes flex min-h-48 items-center justify-center px-8 py-16 text-center">
						<p className="bg-background font-mono text-xs uppercase tracking-wider">
							No course sync history yet
						</p>
					</div>
				) : (
					<div className="overflow-x-auto">
						<table className="w-full min-w-[920px] border-collapse text-left text-sm">
							<thead className="bg-muted font-mono text-[11px] uppercase tracking-wider">
								<tr>
									<th className="px-6 py-3 font-medium">Version</th>
									<th className="px-4 py-3 font-medium">When</th>
									<th className="px-4 py-3 font-medium">Outcome</th>
									<th className="px-4 py-3 font-medium">Structure</th>
									<th className="px-4 py-3 font-medium">Duration</th>
									<th className="px-6 py-3 text-right font-medium">History</th>
								</tr>
							</thead>
							<tbody className="divide-y">
								{history.map((item) => (
									<tr
										key={item.courseVersionId}
										className="bg-background hover:bg-muted/50 relative transition-colors"
									>
										<td className="px-6 py-5 align-top">
											<Link
												href={`/admin/course-sync/${encodeURIComponent(item.courseVersionId)}`}
												className="focus-visible:ring-ring font-semibold underline-offset-4 after:absolute after:inset-0 after:content-[''] hover:underline focus-visible:ring-2 focus-visible:ring-offset-2"
											>
												{item.courseName ?? shortId(item.courseVersionId)}
											</Link>
											<div className="text-muted-foreground mt-1 font-mono text-xs">
												{shortId(item.courseVersionId)}
											</div>
										</td>
										<td className="px-4 py-5 align-top tabular-nums">
											{format(item.when, 'MMM d, yyyy HH:mm')}
										</td>
										<td className="px-4 py-5 align-top">
											<span className="border-border inline-flex rounded-full border px-2 py-1 font-mono text-[11px] uppercase tracking-wider">
												{item.outcome}
											</span>
											{item.failureClass && (
												<div className="text-muted-foreground mt-2 max-w-48 break-words font-mono text-xs">
													{item.failureClass}
												</div>
											)}
										</td>
										<td className="px-4 py-5 align-top tabular-nums">
											{count(item.sectionCount)} sections ·{' '}
											{count(item.lessonCount)} lessons ·{' '}
											{count(item.videoCount)} videos
										</td>
										<td className="px-4 py-5 align-top tabular-nums">
											{duration(item.durationSeconds)}
										</td>
										<td className="px-6 py-5 text-right align-top">
											<Link
												href={`/admin/course-sync/${encodeURIComponent(item.courseVersionId)}`}
												className="underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
											>
												Open
											</Link>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</section>
		</main>
	)
}
