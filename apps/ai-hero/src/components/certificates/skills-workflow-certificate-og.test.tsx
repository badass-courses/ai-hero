import { describe, expect, it } from 'vitest'

import {
	renderSkillsWorkflowCertificateOpenGraphImage,
	SKILLS_WORKFLOW_CERTIFICATE_OG_SIZE,
} from './skills-workflow-certificate-og'

describe('Skills Workflow certificate OG renderer', () => {
	it('encodes an actual 1200x630 PNG', async () => {
		const response = await renderSkillsWorkflowCertificateOpenGraphImage({
			slug: 'opaque-public-certificate-slug-123',
			learnerName: 'Joel Hooks',
			courseName: 'AI Hero Skills Workflow',
			completedAt: new Date('2026-07-18T12:00:00.000Z'),
		})
		const bytes = new Uint8Array(await response.arrayBuffer())

		expect(SKILLS_WORKFLOW_CERTIFICATE_OG_SIZE).toEqual({
			width: 1200,
			height: 630,
		})
		expect(response.headers.get('content-type')).toBe('image/png')
		expect(Array.from(bytes.slice(0, 8))).toEqual([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		])
		expect(bytes.byteLength).toBeGreaterThan(10_000)
	})
})
