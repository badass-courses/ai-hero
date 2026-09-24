import { defineConfig, devices } from '@playwright/test'

// Self-contained CI check for the workshop CTAs: builds the fixture page with
// Vite, serves it statically and answers every API call from page.route.
export default defineConfig({
	testDir: '.',
	forbidOnly: !!process.env['CI'],
	retries: 0,
	reporter: process.env['CI'] ? 'list' : 'line',
	outputDir: '../test-results/e2e-pricing',
	use: {
		baseURL: 'http://localhost:4179',
		trace: 'retain-on-failure',
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	webServer: {
		command:
			'vite build --config e2e-pricing/vite.config.ts && vite preview --config e2e-pricing/vite.config.ts',
		cwd: '..',
		url: 'http://localhost:4179',
		reuseExistingServer: !process.env['CI'],
		timeout: 120_000,
	},
})
