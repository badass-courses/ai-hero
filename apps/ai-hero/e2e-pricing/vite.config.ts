import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))

// Next, NextAuth, env and server-action modules are the only stand-ins; the
// workshop CTAs, commerce-next Pricing.Root and the commerce pricing machine
// (with the app's pnpm patches) are bundled as production code.
export default defineConfig({
	root: here('.'),
	esbuild: { jsx: 'automatic' },
	// Like a Vercel preview built with production env: an absolute price URL
	// would leave this origin, which the spec treats as a failure.
	define: {
		'process.env.NEXT_PUBLIC_URL': JSON.stringify('https://www.aihero.dev'),
		'process.env': '{}',
	},
	resolve: {
		alias: [
			{
				find: /^next\/navigation$/,
				replacement: here('./shims/next-navigation.ts'),
			},
			{ find: /^next\/link$/, replacement: here('./shims/next-link.tsx') },
			{ find: /^next\/image$/, replacement: here('./shims/next-image.tsx') },
			{
				find: /^next-auth\/react$/,
				replacement: here('./shims/next-auth-react.tsx'),
			},
			{ find: /^@\/env\.mjs$/, replacement: here('./shims/env.ts') },
			{
				find: /^@\/utils\/analytics$/,
				replacement: here('./shims/analytics.ts'),
			},
			{
				find: /^@\/components\/cta\/conversion-intent-(button|form)$/,
				replacement: here('./shims/conversion-intent.tsx'),
			},
			{ find: /^@\//, replacement: here('../src/') },
		],
	},
	// A production build: Rollup's CommonJS interop handles React and friends
	// the way the Next bundle does, without dev-server dependency discovery.
	build: {
		outDir: here('./dist'),
		emptyOutDir: true,
		chunkSizeWarningLimit: 4096,
		rollupOptions: {
			// Next honors "use client"; a single client bundle does not need it.
			onwarn(warning, warn) {
				if (warning.code === 'MODULE_LEVEL_DIRECTIVE') return
				if (warning.code === 'SOURCEMAP_ERROR') return
				warn(warning)
			},
		},
	},
	preview: { port: 4179, strictPort: true },
})
