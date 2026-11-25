'use client'

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
	type ReactNode,
} from 'react'
import { useParams, useSelectedLayoutSegments } from 'next/navigation'
import type { AppRouter } from '@/trpc/api/root'
import type { inferRouterOutputs } from '@trpc/server'

type LessonAbilityRules =
	inferRouterOutputs<AppRouter>['ability']['getCurrentAbilityRules']

type Seed = {
	moduleId: string
	lessonId: string
	viewer: { id: string; rules: LessonAbilityRules } | null
}

type LessonScope = {
	input: Pick<Seed, 'moduleId' | 'lessonId'>
	seed: Seed | undefined
	waitingForPage: boolean
}

// Give each lesson's streamed page time to register after the route changes.
// Keep the wait bounded for renders that never supply a seed.
const SEED_WAIT_MS = 2_500

const ScopeContext = createContext<LessonScope | null>(null)
const RegisterContext = createContext<((seed: Seed) => () => void) | null>(null)

export function LessonAbilitySeedProvider({ children }: { children: ReactNode }) {
	const { module, lesson } = useParams<{ module: string; lesson: string }>()
	const segments = useSelectedLayoutSegments()
	const [seed, setSeed] = useState<Seed>()
	const register = useCallback((next: Seed) => {
		setSeed(next)
		return () => setSeed((current) => (current === next ? undefined : current))
	}, [])
	// Only the base lesson page supplies a seed. Exercise and solution keep
	// their existing client queries. The sidebar outlives all these pages.
	const isBaseLesson = segments.length === 1
	const input = useMemo(
		() => isBaseLesson && module && lesson ? { moduleId: module, lessonId: lesson } : null,
		[isBaseLesson, module, lesson],
	)
	const matchingSeed = seed?.moduleId === module && seed?.lessonId === lesson
		? seed
		: undefined
	const [expiredInput, setExpiredInput] = useState<LessonScope['input']>()
	useEffect(() => {
		if (!input || matchingSeed) return
		const timeout = window.setTimeout(() => setExpiredInput(input), SEED_WAIT_MS)
		return () => window.clearTimeout(timeout)
	}, [input, matchingSeed])

	const scope = input
		? { input, seed: matchingSeed, waitingForPage: !matchingSeed && expiredInput !== input }
		: null

	return (
		<RegisterContext value={register}>
			<ScopeContext value={scope}>{children}</ScopeContext>
		</RegisterContext>
	)
}

export function LessonAbilitySeed(seed: Seed) {
	const register = useContext(RegisterContext)
	useEffect(() => register?.(seed), [register, seed])
	return null
}

export function useLessonAbilityScope() {
	return useContext(ScopeContext)
}
