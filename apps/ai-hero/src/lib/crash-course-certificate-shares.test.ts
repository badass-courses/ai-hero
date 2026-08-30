import { describe, expect, it } from 'vitest'

import type { CrashCourseCertificateEligibility } from './crash-course-certificate-eligibility'
import {
	CRASH_COURSE_CERTIFICATE_COURSE_NAME,
	ensureCrashCourseCertificateShare,
} from './crash-course-certificate-shares'
import type {
	PublicValuePathCertificateShare,
	ValuePathCertificateShareRecord,
	ValuePathCertificateShareRepository,
} from './subscriber-marketing/value-path-certificate-shares'

const completedAt = new Date('2026-08-30T12:00:07.000Z')
const eligible: CrashCourseCertificateEligibility = {
	eligible: true,
	userId: 'user-1',
	courseResourceId: 'workshop-2ozd9',
	finalQuizLessonId: 'sync_lesson_800b577c51997b78aa74a65c',
	completedAt,
	correctAnswers: 8,
	requiredAnswers: 8,
}

class MemoryShareRepository implements ValuePathCertificateShareRepository {
	readonly records: ValuePathCertificateShareRecord[] = []

	async findByContactAndResource(input: {
		contactId: string
		resourceId: string
	}) {
		return (
			this.records.find(
				(record) =>
					record.contactId === input.contactId &&
					record.resourceId === input.resourceId,
			) ?? null
		)
	}

	async findPublicBySlug(
		slug: string,
	): Promise<PublicValuePathCertificateShare | null> {
		const record = this.records.find((candidate) => candidate.slug === slug)
		return record
			? {
					slug: record.slug,
					resourceId: record.resourceId,
					learnerName: record.learnerName,
					courseName: record.courseName,
					completedAt: record.completedAt,
				}
			: null
	}

	async create(record: ValuePathCertificateShareRecord) {
		if (
			this.records.some(
				(candidate) =>
					candidate.slug === record.slug ||
					(candidate.contactId === record.contactId &&
						candidate.resourceId === record.resourceId),
			)
		) {
			throw new Error('duplicate-certificate')
		}
		this.records.push(record)
	}
}

describe('Crash Course certificate shares', () => {
	it('creates one stable opaque share only after eligibility', async () => {
		const repository = new MemoryShareRepository()
		const first = await ensureCrashCourseCertificateShare({
			eligibility: eligible,
			learnerName: 'Joel Hooks',
			repository,
			createSlug: () => 'opaque-crash-course-share-slug-123',
		})
		const second = await ensureCrashCourseCertificateShare({
			eligibility: eligible,
			learnerName: 'Joel Hooks',
			repository,
			createSlug: () => 'must-not-replace-existing-share',
		})

		expect(first).toMatchObject({
			available: true,
			created: true,
			share: {
				slug: 'opaque-crash-course-share-slug-123',
				resourceId: 'workshop-2ozd9',
				learnerName: 'Joel Hooks',
				courseName: CRASH_COURSE_CERTIFICATE_COURSE_NAME,
				completedAt,
			},
		})
		expect(second).toMatchObject({
			available: true,
			created: false,
			share: { slug: 'opaque-crash-course-share-slug-123' },
		})
		expect(repository.records).toHaveLength(1)
		expect(repository.records[0]).toMatchObject({
			contactId: 'user-1',
			resourceId: 'workshop-2ozd9',
		})
	})

	it('creates nothing when eligibility or learner name is unavailable', async () => {
		const repository = new MemoryShareRepository()
		const locked = await ensureCrashCourseCertificateShare({
			eligibility: {
				eligible: false,
				reason: 'answers-missing',
				correctAnswers: 7,
				requiredAnswers: 8,
			},
			learnerName: 'Joel Hooks',
			repository,
		})
		const unnamed = await ensureCrashCourseCertificateShare({
			eligibility: eligible,
			learnerName: '   ',
			repository,
		})

		expect(locked).toEqual({
			available: false,
			reason: 'answers-missing',
		})
		expect(unnamed).toEqual({
			available: false,
			reason: 'learner-name-missing',
		})
		expect(repository.records).toHaveLength(0)
	})
})
