'use client'

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
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
}

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
	const scope =
		segments.length === 1 && module && lesson
			? {
					input: { moduleId: module, lessonId: lesson },
					seed:
						seed?.moduleId === module && seed.lessonId === lesson
							? seed
							: undefined,
				}
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
