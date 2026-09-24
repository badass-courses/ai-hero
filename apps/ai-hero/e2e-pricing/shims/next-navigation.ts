// The fixture page has no Next router; the real URL query drives commerce.
export const usePathname = () => '/workshops/ai-coding-crash-course'
export const useSearchParams = () => new URLSearchParams(window.location.search)
export const useRouter = () => ({
	push: () => {},
	replace: () => {},
	refresh: () => {},
	prefetch: () => {},
	back: () => {},
})
