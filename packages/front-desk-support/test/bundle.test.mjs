import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const meta = JSON.parse(await readFile('dist/metafile.json', 'utf8'))
assert.ok(
	Object.keys(meta.inputs).some(
		(input) => input.includes('effect@4.0.2') || input.includes('/effect/'),
	),
	'Effect must be bundled',
)
assert.deepEqual(Object.keys(meta.outputs), ['dist/index.js'])
for (const output of Object.values(meta.outputs)) {
	assert.ok(
		output.imports.every((entry) => entry.path.startsWith('node:')),
		'Only Node builtins may remain external',
	)
}
const declaration = await readFile('dist/index.d.ts', 'utf8')
assert.doesNotMatch(declaration, /\b(?:from|import).*['"]effect(?:\/|['"])/)
console.log(
	'Bundle contract passed: one ESM output, only Node builtins external, native facade declarations',
)
