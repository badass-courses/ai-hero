import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { certificateRenderUrl } from './certificate-render-url'

describe('certificate.upload fetches only our own render (sec-043)', () => {
	it('builds the render URL for the signed-in learner', () => {
		expect(
			certificateRenderUrl('https://www.aihero.dev', 'cohort-xdy1m', 'user-1'),
		).toBe(
			'https://www.aihero.dev/api/certificates?resource=cohort-xdy1m&user=user-1',
		)
	})

	it('cannot be steered by the resource value', () => {
		const url = new URL(
			certificateRenderUrl(
				'https://www.aihero.dev',
				'x&user=someone-else#@evil.example',
				'user-1',
			),
		)
		expect(url.origin).toBe('https://www.aihero.dev')
		expect(url.pathname).toBe('/api/certificates')
		expect(url.searchParams.getAll('user')).toEqual(['user-1'])
	})

	it('the upload procedure never fetches the caller-supplied imagePath', () => {
		const source = readFileSync(
			join(__dirname, '..', 'trpc/api/routers/certificate.ts'),
			'utf8',
		)
		expect(source).not.toMatch(/fetch\(\s*input\.imagePath/)
		expect(source).not.toMatch(/uploadImage\(\s*input\.imagePath/)
		expect(source).toMatch(/certificateRenderUrl\(/)
		expect(source).toMatch(/redirect: 'error'/)
	})
})
