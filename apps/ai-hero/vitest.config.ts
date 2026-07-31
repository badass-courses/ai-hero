/// <reference types="vitest" />
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		setupFiles: ['./src/test/setup.ts'],
		environment: 'node',
		include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
		globals: true,
	},
	plugins: [tsconfigPaths()],
	resolve: {
		alias: {
			'@': '/src',
			// `server-only` is a build-time guard with no runtime module, so vite
			// cannot resolve it and any test whose import graph reaches a server
			// module fails to LOAD — not on an assertion, which makes it look like
			// the test itself broke.
			//
			// Aliased centrally rather than mocked per file: the guard belongs in
			// the source (it is what keeps a session read out of a client bundle),
			// and which tests transitively reach one is not something each test
			// author should have to know.
			'server-only': '/src/test/server-only-stub.ts',
		},
	},
})
