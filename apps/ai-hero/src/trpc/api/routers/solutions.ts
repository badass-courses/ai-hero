import { getLesson } from '@/lib/lessons/lessons.service'
import { SolutionSchema } from '@/lib/solution'
import {
	createSolution as createSolutionAction,
	deleteSolution as deleteSolutionAction,
	getAllSolutionsForLesson,
	getLessonForSolution,
	getSolution,
	getSolutionForLesson,
} from '@/lib/solutions-query'
import { log, serializeError } from '@/server/logger'
import { createTRPCRouter, protectedProcedure } from '@/trpc/api/trpc'
import { subject, type Ability } from '@casl/ability'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

/**
 * A solution is as protected as its lesson: reading one needs read access to
 * the parent lesson (the same entitlement check the lesson page uses), and a
 * solution that isn't published needs an editor. protectedProcedure alone
 * only proves a login (security desk, sec-035, 2026-11-21).
 */
async function requireLessonRead(
	lessonId: string | null | undefined,
	ability: Ability,
) {
	if (!lessonId) throw new TRPCError({ code: 'NOT_FOUND' })
	const lesson = await getLesson(lessonId, ability)
	if (!lesson || ability.cannot('read', subject('Content', lesson))) {
		throw new TRPCError({ code: 'FORBIDDEN' })
	}
	return lesson
}

function visibleSolution<
	T extends { fields?: { state?: string | null } | null } | null | undefined,
>(solution: T, ability: Ability): T | null {
	if (!solution) return null
	return solution.fields?.state === 'published' ||
		ability.can('update', subject('Content', solution as object))
		? solution
		: null
}

/**
 * Router for solution-related operations
 * Delegates to server actions for actual implementation
 */
export const solutionsRouter = createTRPCRouter({
	/**
	 * Get a solution for a specific lesson (returns first one)
	 */
	getForLesson: protectedProcedure
		.input(
			z.object({
				lessonId: z.string(),
			}),
		)
		.query(async ({ ctx, input }) => {
			const { lessonId } = input
			await requireLessonRead(lessonId, ctx.ability as unknown as Ability)
			return visibleSolution(
				await getSolutionForLesson(lessonId),
				ctx.ability as unknown as Ability,
			)
		}),

	/**
	 * Get ALL solutions for a specific lesson
	 */
	getAllForLesson: protectedProcedure
		.input(
			z.object({
				lessonId: z.string(),
			}),
		)
		.query(async ({ ctx, input }) => {
			const { lessonId } = input
			const ability = ctx.ability as unknown as Ability
			await requireLessonRead(lessonId, ability)
			const solutions = await getAllSolutionsForLesson(lessonId)
			return solutions.filter((solution) => visibleSolution(solution, ability))
		}),

	/**
	 * Get a solution by ID or slug
	 */
	getSolution: protectedProcedure
		.input(
			z.object({
				solutionSlugOrId: z.string(),
			}),
		)
		.query(async ({ ctx, input }) => {
			const { solutionSlugOrId } = input
			const ability = ctx.ability as unknown as Ability
			const solution = await getSolution(solutionSlugOrId)
			if (!solution) return null
			const lesson = await getLessonForSolution(solution.id)
			await requireLessonRead(lesson?.id, ability)
			return visibleSolution(solution, ability)
		}),

	/**
	 * Create a new solution linked to a lesson
	 */
	create: protectedProcedure
		.input(
			z.object({
				lessonId: z.string(),
				title: z.string(),
				body: z.string().optional(),
				slug: z.string(),
				description: z.string().optional(),
				videoResourceId: z.string().nullable().optional(),
			}),
		)
		.mutation(async ({ input }) => {
			try {
				const solution = await createSolutionAction(input)
				return solution
			} catch (error) {
				void log.error('solution.create.trpc.error', {
					error: serializeError(error),
				})
				throw error
			}
		}),

	/**
	 * Delete a solution and remove its link to the lesson
	 */
	delete: protectedProcedure
		.input(
			z.object({
				solutionId: z.string(),
			}),
		)
		.mutation(async ({ input }) => {
			try {
				const { solutionId } = input
				return deleteSolutionAction(solutionId)
			} catch (error) {
				void log.error('solution.delete.trpc.error', {
					error: serializeError(error),
				})
				throw error
			}
		}),

	/**
	 * Get the parent lesson for a solution
	 */
	getParentLesson: protectedProcedure
		.input(
			z.object({
				solutionId: z.string(),
			}),
		)
		.query(async ({ ctx, input }) => {
			try {
				const { solutionId } = input
				const lesson = await getLessonForSolution(solutionId)
				if (!lesson) return null
				await requireLessonRead(lesson.id, ctx.ability as unknown as Ability)
				return lesson
			} catch (error) {
				void log.error('solution.getParentLesson.trpc.error', {
					error: serializeError(error),
				})
				throw error
			}
		}),
})
