import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { CertificateTile } from './certificate-tile'

const LOCK = 'Locked until every lesson is complete'

describe('CertificateTile', () => {
	it('reports the distance to the certificate while it is locked', () => {
		const html = renderToStaticMarkup(
			<CertificateTile
				completedCount={8}
				totalCount={61}
				percent={13}
				progressLabel="Workshop progress"
			/>,
		)
		expect(html).toContain('Certificate of Completion')
		expect(html).toContain(LOCK)
		expect(html).toContain('8/61 lessons completed')
		expect(html).toContain('aria-valuenow="13"')
		expect(html).toContain('aria-label="Workshop progress"')
		expect(html).toContain('width:13%')
	})

	it('swaps the lock for the action once it is earned', () => {
		const html = renderToStaticMarkup(
			<CertificateTile
				completedCount={61}
				totalCount={61}
				percent={100}
				progressLabel="Cohort progress"
				action={<button type="button">Get Certificate</button>}
			/>,
		)
		expect(html).not.toContain(LOCK)
		expect(html).toContain('61/61 lessons completed')
		expect(html).toContain('Get Certificate')
	})

	it('holds an empty line, not a made-up count, while the count loads', () => {
		const html = renderToStaticMarkup(
			<CertificateTile percent={0} progressLabel="Cohort progress" />,
		)
		expect(html).not.toContain('lessons completed')
		expect(html).toContain('aria-hidden="true"')
		expect(html).toContain(LOCK)
	})
})
