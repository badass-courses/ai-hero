import { describe, expect, it } from 'vitest'

import type { ValuePathCertificateEligibility } from './value-path-certificates'
import {
	ensureSkillsWorkflowCertificateShare,
	type PublicValuePathCertificateShare,
	type ValuePathCertificateShareRecord,
	type ValuePathCertificateShareRepository,
} from './value-path-certificate-shares'

const completedAt = new Date('2026-07-18T12:00:00.000Z')

function eligible(
	overrides: Partial<ValuePathCertificateEligibility> = {},
): ValuePathCertificateEligibility {
	return {
		eligible: true,
		resourceIdOrSlug: 'value-path:ai-hero-skills-workflow',
		contactId: 'contact-1',
		learnerName: 'Joel Hooks',
		learnerEmail: 'joel@example.com',
		completedAt,
		...overrides,
	}
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

	async findPublicBySlug(slug: string): Promise<PublicValuePathCertificateShare | null> {
		const record = this.records.find((candidate) => candidate.slug === slug)
		return record
			? {
					slug: record.slug,
					learnerName: record.learnerName,
					courseName: record.courseName,
					completedAt: record.completedAt,
				}
			: null
	}

	async create(record: ValuePathCertificateShareRecord) {
		if (this.records.some((candidate) => candidate.slug === record.slug)) {
			throw new Error('duplicate-slug')
		}
		if (
			this.records.some(
				(candidate) =>
					candidate.contactId === record.contactId &&
					candidate.resourceId === record.resourceId,
			)
		) {
			throw new Error('duplicate-certificate')
		}
		this.records.push(record)
	}
}

describe('shareable Skills Workflow certificates', () => {
	it('creates one stable opaque permalink without persisting the learner email', async () => {
		const repository = new MemoryShareRepository()
		const first = await ensureSkillsWorkflowCertificateShare({
			eligibility: eligible(),
			repository,
			createSlug: () => 'opaque-public-certificate-slug-123',
		})
		const second = await ensureSkillsWorkflowCertificateShare({
			eligibility: eligible(),
			repository,
			createSlug: () => 'must-not-replace-the-existing-slug',
		})

		expect(first).toMatchObject({
			available: true,
			created: true,
			share: {
				slug: 'opaque-public-certificate-slug-123',
				learnerName: 'Joel Hooks',
				courseName: 'AI Hero Skills Workflow',
				completedAt,
			},
		})
		expect(second).toMatchObject({
			available: true,
			created: false,
			share: { slug: 'opaque-public-certificate-slug-123' },
		})
		expect(repository.records).toHaveLength(1)
		expect(repository.records[0]).not.toHaveProperty('learnerEmail')
		expect(JSON.stringify(first)).not.toContain('joel@example.com')
	})

	it('fails closed when eligibility or a public learner name is missing', async () => {
		const repository = new MemoryShareRepository()
		const ineligible = await ensureSkillsWorkflowCertificateShare({
			eligibility: eligible({ eligible: false, reason: 'value-path-not-complete' }),
			repository,
		})
		const unnamed = await ensureSkillsWorkflowCertificateShare({
			eligibility: eligible({ learnerName: null }),
			repository,
		})

		expect(ineligible).toEqual({
			available: false,
			reason: 'value-path-not-complete',
		})
		expect(unnamed).toEqual({
			available: false,
			reason: 'learner-name-missing',
		})
		expect(repository.records).toHaveLength(0)
	})

	it('retries an opaque slug collision without returning another certificate', async () => {
		const repository = new MemoryShareRepository()
		const collisionSlug = 'collision-slug-12345678901234567890'
		await ensureSkillsWorkflowCertificateShare({
			eligibility: eligible({ contactId: 'contact-a' }),
			repository,
			createSlug: () => collisionSlug,
		})
		const slugs = [
			collisionSlug,
			'fresh-opaque-slug-123456789012345',
		]
		const result = await ensureSkillsWorkflowCertificateShare({
			eligibility: eligible({ contactId: 'contact-b', learnerName: 'Matt Pocock' }),
			repository,
			createSlug: () => slugs.shift()!,
		})

		expect(result).toMatchObject({
			available: true,
			created: true,
			share: {
				slug: 'fresh-opaque-slug-123456789012345',
				learnerName: 'Matt Pocock',
			},
		})
		expect(repository.records).toHaveLength(2)
	})

	it('generates a 32-character public slug by default', async () => {
		const repository = new MemoryShareRepository()
		const result = await ensureSkillsWorkflowCertificateShare({
			eligibility: eligible(),
			repository,
		})

		expect(result.available).toBe(true)
		if (!result.available) throw new Error(result.reason)
		expect(result.share.slug).toMatch(/^[A-Za-z0-9_-]{32}$/)
	})
})
