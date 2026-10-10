import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
	ENGINE_VERSION,
	decodeBindingQuotes,
	decodePolicy,
	price,
} from '../src/pricing.js'

const dir = new URL('../vendor/front-desk-pricing/', import.meta.url)
const source: {
	readonly frontDeskCommit: string
	readonly version: string
	readonly files: Record<string, { sha256: string; bodySha256?: string }>
} = JSON.parse(await readFile(new URL('SOURCE.json', dir), 'utf8'))
const sha256 = (data: Buffer | string) =>
	createHash('sha256').update(data).digest('hex')

test('every vendored file matches its pinned sha256', async () => {
	for (const [name, pin] of Object.entries(source.files)) {
		assert.equal(sha256(await readFile(new URL(name, dir))), pin.sha256, name)
	}
})

test('the bundle header names the pinned commit and its own body hash', async () => {
	const file = await readFile(new URL('pricing.js', dir), 'utf8')
	const newline = file.indexOf('\n')
	const header = file.slice(0, newline)
	const body = file.slice(newline + 1)
	assert.match(
		header,
		new RegExp(
			`^/\\*! @front-desk/pricing ${source.version} public build; front-desk commit ${source.frontDeskCommit}; sha256 of the body below ([0-9a-f]{64}) \\*/$`,
		),
	)
	const declared = header.match(/([0-9a-f]{64}) \*\/$/)![1]
	assert.equal(sha256(body), declared)
	assert.equal(source.files['pricing.js']!.bodySha256, declared)
	assert.equal(ENGINE_VERSION, source.version)
})

test('the vendored files carry no private refs, emails or policy data', async () => {
	for (const name of Object.keys(source.files)) {
		const text = await readFile(new URL(name, dir), 'utf8')
		assert.doesNotMatch(text, /aihero-support:/, name)
		assert.doesNotMatch(text, /\.brain\//, name)
		assert.doesNotMatch(
			text,
			/[A-Za-z0-9._%+-]+@[A-Za-z][A-Za-z0-9-]*\.[A-Za-z]{2,}/,
			name,
		)
		// The public build ships rule code, never Cohort 005's policy document.
		assert.doesNotMatch(text, /aihero-cohort-005@/, name)
	}
})

test('the plain-data decoders refuse malformed input without throwing', () => {
	assert.equal(decodePolicy({}).ok, false)
	assert.equal(decodeBindingQuotes([{ amount: -1 }]).ok, false)
	assert.deepEqual(decodeBindingQuotes([]), { ok: true, value: [] })
	assert.equal(price({} as never).ok, false)
})
