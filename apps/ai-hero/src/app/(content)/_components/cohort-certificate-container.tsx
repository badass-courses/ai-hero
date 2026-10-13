'use client'

import {
	CERTIFICATE_TILE_ACTION,
	CertificateTile,
} from '@/components/certificates/certificate-tile'
import * as CohortCertificate from '@/components/certificates/cohort-certificate'
import { TYPE } from '@/components/landing/type'
import type { CohortNavigation } from '@/lib/cohort-navigation'
import { api } from '@/trpc/react'
import { useSession } from 'next-auth/react'

import { cn } from '@coursebuilder/ui/utils/cn'

/** The cohort certificate dialog's contents, shared by every entry point. */
export const CohortCertificateDialog = () => (
	<CohortCertificate.Dialog>
		<CohortCertificate.NameInput />
		<CohortCertificate.DownloadButton />
		<div>
			<p className={cn(TYPE.meta, 'pb-1')}>
				Share URL (can be used on LinkedIn, etc.)
			</p>
			<div className="flex items-center">
				<CohortCertificate.GenerateShareUrlButton />
				<CohortCertificate.ShareUrl />
			</div>
		</div>
	</CohortCertificate.Dialog>
)

/**
 * Whether the signed-in learner may claim this cohort's certificate. The
 * lesson page only knows its own workshop's progress, so the cohort-wide
 * answer is a server read.
 */
export function useCohortCertificateEligibility(
	cohort: CohortNavigation | null,
) {
	const { status } = useSession()
	const { data } = api.certificate.cohortEligibility.useQuery(
		{ cohortId: cohort?.id ?? '' },
		{ enabled: status === 'authenticated' && Boolean(cohort?.id) },
	)
	return Boolean(data?.eligible)
}

/**
 * "Get your cohort certificate" for the moment the last workshop ends. The
 * caller decides eligibility (see `useCohortCertificateEligibility`) so it
 * can also arrange the buttons around it.
 */
export const CohortCertificateAction = ({
	cohort,
	className,
}: {
	cohort: CohortNavigation
	className?: string
}) => (
	<CohortCertificate.Root resourceIdOrSlug={cohort.slug}>
		<CohortCertificate.Trigger className={className}>
			Get your {cohort.title} certificate
		</CohortCertificate.Trigger>
		<CohortCertificateDialog />
	</CohortCertificate.Root>
)

/**
 * The owner's certificate tile in the cohort rail: the workshop page's tile,
 * counting lessons across every workshop. Whether it is earned is the
 * server's eligibility answer, never the count, so the tile agrees with what
 * the certificate API will allow.
 */
export const Certificate = ({
	resourceSlugOrId,
	isCompleted,
	completedCount,
	totalCount,
}: {
	resourceSlugOrId: string
	isCompleted: boolean
	/** Lessons across all workshops. Absent while the count is loading. */
	completedCount?: number
	totalCount?: number
}) => {
	const tile = {
		completedCount,
		totalCount,
		percent: isCompleted
			? 100
			: completedCount && totalCount
				? Math.floor((completedCount / totalCount) * 100)
				: 0,
		progressLabel: 'Cohort progress',
	}

	return isCompleted ? (
		<CohortCertificate.Root resourceIdOrSlug={resourceSlugOrId}>
			<CertificateTile
				{...tile}
				action={
					<CohortCertificate.Trigger className={CERTIFICATE_TILE_ACTION}>
						Get Certificate
					</CohortCertificate.Trigger>
				}
			/>
			<CohortCertificateDialog />
		</CohortCertificate.Root>
	) : (
		<CertificateTile {...tile} />
	)
}
