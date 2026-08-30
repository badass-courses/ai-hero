'use client'

import Link from 'next/link'
import * as ModuleCertificate from '@/components/certificates/module-certificate'
import { TYPE } from '@/components/landing/type'
import { api } from '@/trpc/react'
import { Lock } from 'lucide-react'

import { cn } from '@coursebuilder/ui/utils/cn'

import { useModuleProgress } from './module-progress-provider'

export const Certificate = ({
	resourceSlugOrId,
	variant = 'lesson-progress',
	finalQuizLessonId,
}: {
	resourceSlugOrId: string
	variant?: 'lesson-progress' | 'crash-course'
	finalQuizLessonId?: string
}) => {
	const { moduleProgress } = useModuleProgress()
	const eligibility = api.certificate.crashCourseEligibility.useQuery(
		undefined,
		{
			enabled: variant === 'crash-course',
			retry: false,
		},
	)
	const completedCount = moduleProgress?.completedLessonsCount ?? 0
	const totalCount = moduleProgress?.totalLessonsCount ?? 0
	const percent = moduleProgress?.percentCompleted ?? 0

	if (variant === 'crash-course') {
		if (eligibility.status === 'pending') {
			return <CertificateStatus message="Checking certificate eligibility..." />
		}
		if (eligibility.status === 'error') {
			return (
				<CertificateStatus
					message="Certificate check is temporarily unavailable."
					onRetry={() => eligibility.refetch()}
				/>
			)
		}
		if (eligibility.data.status === 'unavailable') {
			return (
				<CertificateStatus
					message="Certificate check is temporarily unavailable."
					onRetry={() => eligibility.refetch()}
				/>
			)
		}
		if (eligibility.data.status === 'locked') {
			const checkpointHref = finalQuizLessonId
				? `/workshops/${resourceSlugOrId}/${finalQuizLessonId}`
				: `/workshops/${resourceSlugOrId}`
			return (
				<LockedCertificate
					message={
						<div className={cn(TYPE.metaMark)}>
							{eligibility.data.correctAnswers}/
							{eligibility.data.requiredAnswers} checkpoint questions correct
						</div>
					}
				>
					<Link
						className={cn(
							TYPE.meta,
							'focus-visible:ring-ring focus-visible:ring-offset-background border-input hover:bg-muted inline-flex min-h-10 items-center justify-center rounded-[9px] border px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
						)}
						href={checkpointHref}
					>
						Finish the certificate checkpoint
					</Link>
				</LockedCertificate>
			)
		}
		if (eligibility.data.status === 'granted') {
			return (
				<ReadyCertificate
					progressReport={
						<div className={cn(TYPE.metaMark)}>
							{eligibility.data.eligibility.correctAnswers}/
							{eligibility.data.eligibility.requiredAnswers} checkpoint
							questions correct
						</div>
					}
					resourceSlugOrId={resourceSlugOrId}
					variant="crash-course"
				/>
			)
		}
	}

	const progressReport = (
		<>
			<div
				className="bg-foreground/10 h-[3px] overflow-hidden rounded-[4px]"
				role="progressbar"
				aria-valuenow={percent}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-label="Workshop progress"
			>
				<div
					className="bg-accent-fill h-full"
					style={{ width: `${percent}%` }}
				/>
			</div>
			<div className={cn(TYPE.metaMark)}>
				{completedCount}/{totalCount} lessons completed
			</div>
		</>
	)

	return percent === 100 ? (
		<ReadyCertificate
			progressReport={progressReport}
			resourceSlugOrId={resourceSlugOrId}
			variant="legacy"
		/>
	) : (
		<LockedCertificate message={progressReport} />
	)
}

function ReadyCertificate({
	progressReport,
	resourceSlugOrId,
	variant,
}: {
	progressReport: React.ReactNode
	resourceSlugOrId: string
	variant: ModuleCertificate.ModuleCertificateVariant
}) {
	return (
		<ModuleCertificate.Root
			resourceIdOrSlug={resourceSlugOrId}
			variant={variant}
		>
			<div className="border-border flex flex-col gap-2.5 rounded-[11px] border p-4">
				<div className={cn(TYPE.meta, 'font-bold tracking-[-0.018em]')}>
					Certificate of Completion
				</div>
				{progressReport}
				<ModuleCertificate.Trigger
					className={cn(
						TYPE.meta,
						'border-border text-foreground hover:bg-muted mt-0.5 h-10 w-full cursor-pointer rounded-[9px] border bg-transparent',
					)}
				>
					Get Certificate
				</ModuleCertificate.Trigger>
			</div>
			<ModuleCertificate.Dialog>
				<ModuleCertificate.NameInput />
				<ModuleCertificate.DownloadButton />
				{variant === 'crash-course' ? (
					<div className="space-y-2">
						<p className={cn(TYPE.meta, 'font-medium')}>
							Share on LinkedIn or X
						</p>
						<div className="flex items-center">
							<ModuleCertificate.GenerateShareUrlButton />
							<ModuleCertificate.ShareUrl />
						</div>
						<ModuleCertificate.ShareActions courseName="AI Coding Crash Course" />
					</div>
				) : (
					<div>
						<p className="pb-1 text-sm font-medium">
							Share URL (can be used on LinkedIn, etc.)
						</p>
						<div className="flex items-center">
							<ModuleCertificate.GenerateShareUrlButton />
							<ModuleCertificate.ShareUrl />
						</div>
					</div>
				)}
			</ModuleCertificate.Dialog>
		</ModuleCertificate.Root>
	)
}

function LockedCertificate({
	children,
	message,
}: {
	children?: React.ReactNode
	message: React.ReactNode
}) {
	return (
		<div className="border-border flex flex-col gap-2.5 rounded-[11px] border p-4">
			<div className="flex items-center justify-between gap-2.5">
				<div className={cn(TYPE.meta, 'font-bold tracking-[-0.018em]')}>
					Certificate of Completion
				</div>
				<Lock
					className="text-muted-foreground size-3.5 shrink-0"
					aria-label="Certificate locked"
				/>
			</div>
			{message}
			{children}
		</div>
	)
}

function CertificateStatus({
	message,
	onRetry,
}: {
	message: string
	onRetry?: () => void
}) {
	return (
		<LockedCertificate
			message={<div className={cn(TYPE.metaMark)}>{message}</div>}
		>
			{onRetry ? (
				<button
					className={cn(
						TYPE.meta,
						'focus-visible:ring-ring focus-visible:ring-offset-background border-input hover:bg-muted min-h-10 rounded-[9px] border px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
					)}
					type="button"
					onClick={onRetry}
				>
					Try again
				</button>
			) : null}
		</LockedCertificate>
	)
}
