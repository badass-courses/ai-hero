import { db } from '@/db'
import { valuePathCertificateShare } from '@/db/schema'
import { and, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'

import type { ValuePathCertificateEligibility } from './value-path-certificates'
import { SKILLS_WORKFLOW_CERTIFICATE_RESOURCE } from './value-path-certificates'

export const SKILLS_WORKFLOW_CERTIFICATE_COURSE_NAME =
	'AI Hero Skills Workflow'
export const SKILLS_WORKFLOW_CERTIFICATE_SHARE_PATH = '/certificates'
export const SKILLS_WORKFLOW_FREE_COURSE_PATH =
	'/skills/subscribe?utm_source=certificate&utm_medium=share&utm_campaign=skills-workflow-certificate'

export type PublicValuePathCertificateShare = {
	slug: string
	learnerName: string
	courseName: string
	completedAt: Date
}

export type ValuePathCertificateShareRecord =
	PublicValuePathCertificateShare & {
		contactId: string
		resourceId: string
	}

export type ValuePathCertificateShareRepository = {
	findByContactAndResource(input: {
		contactId: string
		resourceId: string
	}): Promise<ValuePathCertificateShareRecord | null>
	findPublicBySlug(
		slug: string,
	): Promise<PublicValuePathCertificateShare | null>
	create(record: ValuePathCertificateShareRecord): Promise<void>
}

export type EnsureValuePathCertificateShareResult =
	| {
			available: true
			created: boolean
			share: PublicValuePathCertificateShare
	  }
	| {
			available: false
			reason: string
	  }

const drizzleValuePathCertificateShareRepository: ValuePathCertificateShareRepository =
	{
		async findByContactAndResource(input) {
			const [record] = await db
				.select({
					slug: valuePathCertificateShare.slug,
					contactId: valuePathCertificateShare.contactId,
					resourceId: valuePathCertificateShare.resourceId,
					learnerName: valuePathCertificateShare.learnerName,
					courseName: valuePathCertificateShare.courseName,
					completedAt: valuePathCertificateShare.completedAt,
				})
				.from(valuePathCertificateShare)
				.where(
					and(
						eq(valuePathCertificateShare.contactId, input.contactId),
						eq(valuePathCertificateShare.resourceId, input.resourceId),
					),
				)
				.limit(1)
			return record ?? null
		},

		async findPublicBySlug(slug) {
			const [record] = await db
				.select({
					slug: valuePathCertificateShare.slug,
					learnerName: valuePathCertificateShare.learnerName,
					courseName: valuePathCertificateShare.courseName,
					completedAt: valuePathCertificateShare.completedAt,
				})
				.from(valuePathCertificateShare)
				.where(eq(valuePathCertificateShare.slug, slug))
				.limit(1)
			return record ?? null
		},

		async create(record) {
			await db.insert(valuePathCertificateShare).values(record)
		},
	}

export async function ensureSkillsWorkflowCertificateShare(input: {
	eligibility: ValuePathCertificateEligibility
	repository?: ValuePathCertificateShareRepository
	createSlug?: () => string
}): Promise<EnsureValuePathCertificateShareResult> {
	if (!input.eligibility.eligible) {
		return {
			available: false,
			reason: input.eligibility.reason ?? 'certificate-ineligible',
		}
	}
	if (!input.eligibility.contactId) {
		return { available: false, reason: 'contact-id-missing' }
	}
	const learnerName = input.eligibility.learnerName?.trim()
	if (!learnerName) {
		return { available: false, reason: 'learner-name-missing' }
	}
	if (!input.eligibility.completedAt) {
		return { available: false, reason: 'completion-date-missing' }
	}

	const repository =
		input.repository ?? drizzleValuePathCertificateShareRepository
	const resourceId = SKILLS_WORKFLOW_CERTIFICATE_RESOURCE
	const existing = await repository.findByContactAndResource({
		contactId: input.eligibility.contactId,
		resourceId,
	})
	if (existing) {
		return { available: true, created: false, share: toPublicShare(existing) }
	}

	const createSlug = input.createSlug ?? (() => nanoid(32))
	let lastError: unknown
	for (let attempt = 0; attempt < 3; attempt++) {
		const slug = createSlug()
		if (!isOpaqueCertificateShareSlug(slug)) {
			throw new Error('Generated certificate share slug is invalid')
		}
		const record: ValuePathCertificateShareRecord = {
			slug,
			contactId: input.eligibility.contactId,
			resourceId,
			learnerName,
			courseName: SKILLS_WORKFLOW_CERTIFICATE_COURSE_NAME,
			completedAt: input.eligibility.completedAt,
		}
		try {
			await repository.create(record)
			return { available: true, created: true, share: toPublicShare(record) }
		} catch (error) {
			lastError = error
			const concurrentlyCreated =
				await repository.findByContactAndResource({
					contactId: input.eligibility.contactId,
					resourceId,
				})
			if (concurrentlyCreated) {
				return {
					available: true,
					created: false,
					share: toPublicShare(concurrentlyCreated),
				}
			}
		}
	}

	throw lastError
}

export async function getPublicSkillsWorkflowCertificateShare(
	slug: string,
	repository: ValuePathCertificateShareRepository =
		drizzleValuePathCertificateShareRepository,
) {
	if (!isOpaqueCertificateShareSlug(slug)) return null
	return repository.findPublicBySlug(slug)
}

export function buildSkillsWorkflowCertificateShareUrl(input: {
	slug: string
	baseUrl?: string
}) {
	const path = `${SKILLS_WORKFLOW_CERTIFICATE_SHARE_PATH}/${encodeURIComponent(input.slug)}`
	return input.baseUrl
		? new URL(path, input.baseUrl).toString()
		: path
}

export function buildSkillsWorkflowCertificateShareImageUrl(input: {
	slug: string
	baseUrl?: string
	download?: boolean
}) {
	const path = '/api/certificates'
	const params = new URLSearchParams({ share: input.slug })
	if (input.download) params.set('download', '1')
	return input.baseUrl
		? new URL(`${path}?${params}`, input.baseUrl).toString()
		: `${path}?${params}`
}

export function isOpaqueCertificateShareSlug(slug: string) {
	return /^[A-Za-z0-9_-]{20,64}$/.test(slug)
}

function toPublicShare(
	record: ValuePathCertificateShareRecord,
): PublicValuePathCertificateShare {
	return {
		slug: record.slug,
		learnerName: record.learnerName,
		courseName: record.courseName,
		completedAt: record.completedAt,
	}
}
