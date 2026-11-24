import { expect, it } from 'vitest'

import { GET } from './route'

it('answers unmatched OG paths with a bare 404', () => {
	const response = GET()

	expect(response.status).toBe(404)
	expect(response.body).toBeNull()
})
