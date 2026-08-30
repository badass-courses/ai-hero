import { describe, expect, it } from 'vitest'

import {
	buildCertificateApiUrl,
	certificateShareButtonLabel,
} from './module-certificate'

describe('module certificate request identity', () => {
	it('keeps session identity in the URL so a flag rollback can use the legacy path', () => {
		const url = buildCertificateApiUrl({
			baseUrl: 'https://www.aihero.dev',
			resourceIdOrSlug: 'ai-coding-crash-course',
			userId: 'user-1',
		})

		expect(url.toString()).toBe(
			'https://www.aihero.dev/api/certificates?resource=ai-coding-crash-course&user=user-1',
		)
	})

	it('preserves the Regenerate label for an existing legacy share', () => {
		expect(
			certificateShareButtonLabel({
				variant: 'legacy',
				hasShareUrl: true,
				shouldRegenerate: false,
				isGenerating: false,
			}),
		).toBe('Regenerate')
	})
})
