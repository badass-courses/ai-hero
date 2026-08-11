'use client'

import * as ModuleCertificate from '@/components/certificates/module-certificate'
import { TYPE } from '@/components/landing/type'
import { Lock } from 'lucide-react'

import { cn } from '@coursebuilder/ui/utils/cn'

import { useModuleProgress } from './module-progress-provider'

/**
 * The certificate as a progress tile (`Workshop Landing.dc.html` § Sidebar,
 * purchased state): title with a lock while it's earned, a hairline progress
 * bar, and the completed count in mono. It replaces the certificate-shaped
 * placard — a drawing of the reward where the sidebar needs a report of the
 * distance to it. Unlocking swaps the lock for the Get Certificate action.
 */
export const Certificate = ({
	resourceSlugOrId,
}: {
	resourceSlugOrId: string
}) => {
	const { moduleProgress } = useModuleProgress()
	const isCompleted = moduleProgress?.percentCompleted === 100
	const completedCount = moduleProgress?.completedLessonsCount ?? 0
	const totalCount = moduleProgress?.totalLessonsCount ?? 0
	const percent = moduleProgress?.percentCompleted ?? 0

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

	return isCompleted ? (
		<ModuleCertificate.Root resourceIdOrSlug={resourceSlugOrId}>
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
				<div>
					<p className="pb-1 text-sm font-medium">
						Share URL (can be used on LinkedIn, etc.)
					</p>
					<div className="flex items-center">
						<ModuleCertificate.GenerateShareUrlButton />
						<ModuleCertificate.ShareUrl />
					</div>
				</div>
			</ModuleCertificate.Dialog>
		</ModuleCertificate.Root>
	) : (
		<div className="border-border flex flex-col gap-2.5 rounded-[11px] border p-4">
			<div className="flex items-center justify-between gap-2.5">
				<div className={cn(TYPE.meta, 'font-bold tracking-[-0.018em]')}>
					Certificate of Completion
				</div>
				<Lock
					className="text-muted-foreground size-3.5 shrink-0"
					aria-label="Locked until every lesson is complete"
				/>
			</div>
			{progressReport}
		</div>
	)
}
