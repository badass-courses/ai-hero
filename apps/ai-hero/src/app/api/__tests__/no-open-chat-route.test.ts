import { readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { describe, expect, it } from 'vitest'

// sec-20261127-170: the scaffold's /api/chat handler passed any anonymous
// caller's messages to a paid model. Nothing in the app used it. Keep any
// route handler from serving /api/chat again by accident, including one
// placed under a (group) folder or with another module extension.
const appDir = join(__dirname, '..', '..')

function routeFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name)
		if (entry.isDirectory()) return routeFiles(path)
		return /^route\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : []
	})
}

function servedPath(file: string): string {
	const segments = relative(appDir, file).split(sep).slice(0, -1)
	return `/${segments.filter((s) => !/^\(.*\)$/.test(s)).join('/')}`
}

describe('/api/chat', () => {
	it('has no route handler, in any route group or module extension', () => {
		const served = routeFiles(appDir)
			.filter((file) => servedPath(file) === '/api/chat')
			.map((file) => relative(appDir, file))
		expect(served).toEqual([])
	})

	it('still finds the other API routes', () => {
		const paths = routeFiles(appDir).map(servedPath)
		expect(paths).toContain('/api/analytics/chat')
	})
})
