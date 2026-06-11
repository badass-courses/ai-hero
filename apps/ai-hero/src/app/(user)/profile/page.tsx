import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import LayoutClient from '@/components/layout-client'
import { db } from '@/db'
import {
	contentResource,
	contentResourceProduct,
	products,
	purchases,
	users,
} from '@/db/schema'
import { getProviders, getServerAuthSession } from '@/server/auth'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'

import EditProfileForm from './_components/edit-profile-form'

const PROFILE_COURSE_PURCHASE_STATUSES = ['Valid', 'Restricted'] as const

type PurchasedCourse = {
	key: string
	href: string
	title: string
	productName: string
	purchasedAt: Date | null
}

function getCourseHref(resourceType?: string | null, slug?: string | null) {
	if (!slug) return '/workshops'

	if (resourceType === 'cohort') return `/cohorts/${slug}`
	if (resourceType === 'workshop' || resourceType === 'tutorial') {
		return `/workshops/${slug}`
	}

	return `/${slug}`
}

async function getPurchasedCourses(userId: string): Promise<PurchasedCourse[]> {
	const rows = await db
		.select({
			purchaseId: purchases.id,
			productId: purchases.productId,
			productName: products.name,
			purchasedAt: purchases.createdAt,
			resourceId: contentResource.id,
			resourceType: contentResource.type,
			resourceSlug: contentResource.slug,
			resourceTitle: sql<
				string | null
			>`JSON_UNQUOTE(JSON_EXTRACT(${contentResource.fields}, '$.title'))`,
		})
		.from(purchases)
		.leftJoin(products, eq(purchases.productId, products.id))
		.leftJoin(
			contentResourceProduct,
			and(
				eq(contentResourceProduct.productId, purchases.productId),
				isNull(contentResourceProduct.deletedAt),
			),
		)
		.leftJoin(
			contentResource,
			eq(contentResource.id, contentResourceProduct.resourceId),
		)
		.where(
			and(
				eq(purchases.userId, userId),
				inArray(purchases.status, [...PROFILE_COURSE_PURCHASE_STATUSES]),
			),
		)
		.orderBy(desc(purchases.createdAt), asc(contentResourceProduct.position))

	const seen = new Set<string>()

	return rows.flatMap((row) => {
		const key = row.resourceId || row.productId || row.purchaseId
		if (!key || seen.has(key)) return []

		seen.add(key)

		return [
			{
				key,
				href: getCourseHref(row.resourceType, row.resourceSlug),
				title:
					row.resourceTitle?.trim() || row.productName || 'Purchased course',
				productName: row.productName || 'AI Hero course',
				purchasedAt: row.purchasedAt ?? null,
			},
		]
	})
}

export default async function ProfilePage() {
	const { session, ability } = await getServerAuthSession()
	const providers = getProviders()

	if (!ability.can('read', 'User', session?.user?.id)) {
		redirect('/')
	}

	if (!session) {
		return redirect('/')
	}

	if (!session.user) {
		notFound()
	}

	const user = await db.query.users.findFirst({
		where: eq(users.id, session.user.id),
		with: {
			accounts: true,
		},
	})

	if (!user) {
		notFound()
	}

	const githubProvider = providers?.github
	const githubConnected = Boolean(
		user.accounts.find((account: any) => account.provider === 'github'),
	)
	const discordProvider = providers?.discord
	const discordConnected = Boolean(
		user.accounts.find((account: any) => account.provider === 'discord'),
	)
	const purchasedCourses = await getPurchasedCourses(session.user.id)

	if (ability.can('read', 'User', session?.user?.id)) {
		return (
			<LayoutClient withContainer>
				<div className="max-w-(--breakpoint-lg) mx-auto flex min-h-[calc(100vh-var(--nav-height))] w-full flex-col items-start gap-8 px-5 py-20 sm:gap-10 sm:py-16 md:flex-row lg:gap-16">
					<header className="w-full md:max-w-[230px]">
						<h1 className="text-center text-xl font-bold md:text-left">
							Your Profile
						</h1>
					</header>
					<main className="flex w-full flex-col space-y-10 md:max-w-xl">
						<section className="rounded-lg border p-5">
							<div className="mb-4">
								<h2 className="font-heading text-lg font-bold">My Courses</h2>
								<p className="text-muted-foreground text-sm">
									Courses connected to this account.
								</p>
							</div>
							{purchasedCourses.length > 0 ? (
								<ul className="space-y-3">
									{purchasedCourses.map((course) => (
										<li
											key={course.key}
											className="flex flex-col gap-3 rounded-md border p-4 sm:flex-row sm:items-center sm:justify-between"
										>
											<div>
												<h3 className="font-semibold">{course.title}</h3>
												<p className="text-muted-foreground text-sm">
													{course.productName}
													{course.purchasedAt
														? ` · Added ${course.purchasedAt.toLocaleDateString()}`
														: ''}
												</p>
											</div>
											<Link
												href={course.href}
												className="bg-primary text-primary-foreground inline-flex items-center justify-center rounded-md px-3 py-2 text-sm font-medium"
											>
												Open course
											</Link>
										</li>
									))}
								</ul>
							) : (
								<div className="text-muted-foreground rounded-md border border-dashed p-4 text-sm">
									No courses found for this account yet.
								</div>
							)}
						</section>
						<EditProfileForm
							user={session.user}
							githubConnected={githubConnected}
							githubProvider={githubProvider}
							discordConnected={discordConnected}
							discordProvider={discordProvider}
						/>
					</main>
				</div>
			</LayoutClient>
		)
	}

	redirect('/')
}
