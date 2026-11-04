import { spawnSync } from 'node:child_process'

// Vercel's ignored-build step: 0 skips, 1 builds. Only a proven docs/test-only
// preview may skip. Production, unknown environments and failures always build.
const { VERCEL_ENV, VERCEL_GIT_PREVIOUS_SHA, VERCEL_GIT_COMMIT_SHA } = process.env
const isSha = (value) => typeof value === 'string' && /^[a-f\d]{40}([a-f\d]{24})?$/i.test(value)

const canSkip = () => {
	if (VERCEL_ENV !== 'preview') return false
	if (!isSha(VERCEL_GIT_PREVIOUS_SHA) || !isSha(VERCEL_GIT_COMMIT_SHA)) return false

	const diff = spawnSync('git', [
		'diff', '--no-ext-diff', '--no-textconv', '--no-relative', '--no-renames',
		'--name-only', '-z', VERCEL_GIT_PREVIOUS_SHA, VERCEL_GIT_COMMIT_SHA, '--',
	], { encoding: 'utf8' })
	if (diff.error || diff.status !== 0 || !diff.stdout.endsWith('\0')) return false

	const files = diff.stdout.slice(0, -1).split('\0')
	return files.every((file) => {
		if (/\.test\.tsx?$/.test(file) || /(^|\/)__tests__\//.test(file)) return true
		if (file.startsWith('docs/') || file.startsWith('.brain/')) return true
		return !file.startsWith('apps/ai-hero/src/') && /\.mdx?$/.test(file)
	})
}

try {
	process.exitCode = canSkip() ? 0 : 1
} catch {
	process.exitCode = 1
}
