'use client'

import {
	CERTIFICATE_TILE_ACTION,
	CertificateTile,
} from '@/components/certificates/certificate-tile'
import * as ModuleCertificate from '@/components/certificates/module-certificate'

import { useModuleProgress } from './module-progress-provider'

/**
 * The certificate dialog's contents: name, download, share URL. Every place
 * the certificate can be claimed from (sidebar tile, completion overlay,
 * actions bar) opens the same dialog, so the learner learns one flow.
 */
export const CertificateDialog = () => (
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
)

/** The workshop's certificate tile, fed by the page's live lesson progress. */
export const Certificate = ({
	resourceSlugOrId,
}: {
	resourceSlugOrId: string
}) => {
	const { moduleProgress } = useModuleProgress()
	const isCompleted = moduleProgress?.percentCompleted === 100
	const tile = {
		completedCount: moduleProgress?.completedLessonsCount ?? 0,
		totalCount: moduleProgress?.totalLessonsCount ?? 0,
		percent: moduleProgress?.percentCompleted ?? 0,
		progressLabel: 'Workshop progress',
	}

	return isCompleted ? (
		<ModuleCertificate.Root resourceIdOrSlug={resourceSlugOrId}>
			<CertificateTile
				{...tile}
				action={
					<ModuleCertificate.Trigger className={CERTIFICATE_TILE_ACTION}>
						Get Certificate
					</ModuleCertificate.Trigger>
				}
			/>
			<CertificateDialog />
		</ModuleCertificate.Root>
	) : (
		<CertificateTile {...tile} />
	)
}
