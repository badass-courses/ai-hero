import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
await mkdir('dist', { recursive: true })
const result = await build({
	entryPoints: ['src/index.ts', 'src/pricing.ts'],
	outdir: 'dist',
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node24',
	metafile: true,
})
await writeFile('dist/metafile.json', JSON.stringify(result.metafile, null, 2))
