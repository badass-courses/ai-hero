'use client'

import Link from 'next/link'
import { createAppAbility } from '@/ability'
import { Contributor } from '@/components/contributor'
import { api } from '@/trpc/react'
import { FilePlus2 } from 'lucide-react'
import { useSession } from 'next-auth/react'

import type { ContentResource } from '@coursebuilder/core/schemas'
import {
	Button,
	Card,
	CardContent,
	CardFooter,
	CardHeader,
	CardTitle,
} from '@coursebuilder/ui'

export function WorkshopsIndexList({
	initialWorkshops,
}: {
	initialWorkshops: ContentResource[]
}) {
	const { status: sessionStatus } = useSession()
	const abilityQuery = api.ability.getCurrentAbilityRules.useQuery(undefined, {
		enabled: sessionStatus === 'authenticated',
	})
	const ability = createAppAbility(abilityQuery.data ?? [])
	const canCreate =
		sessionStatus === 'authenticated' &&
		abilityQuery.status === 'success' &&
		ability.can('create', 'Content')
	const editorQuery = api.contentResources.getAll.useQuery(
		{ contentTypes: ['workshop'] },
		{ enabled: canCreate, staleTime: 60_000 },
	)
	const workshops = canCreate
		? ((editorQuery.data ?? initialWorkshops) as ContentResource[])
		: initialWorkshops

	return (
		<>
			<ul className="mx-auto mt-8 flex w-full flex-col">
				{workshops.length === 0 && (
					<p className="p-5">There are no public workshops.</p>
				)}
				{workshops.map((workshop) => (
					<li key={workshop.id} className="flex">
						<Card className="divide-border bg-background -mt-px flex w-full flex-col items-center divide-y rounded-none border-x-0 shadow-none md:flex-row md:gap-3 md:divide-x md:divide-y-0">
							<div className="flex h-full w-full flex-col justify-between p-5 md:pl-8">
								<div className="flex h-full flex-col pt-2 md:pt-5">
									<CardHeader className="p-0">
										<CardTitle className="text-xl font-semibold">
											<Link
												href={`/workshops/${workshop.fields?.slug || workshop.id}`}
												className="hover:text-primary w-full text-balance"
											>
												{workshop.fields?.title}
											</Link>
										</CardTitle>
									</CardHeader>
									{workshop.fields?.description && (
										<CardContent className="px-0 py-3">
											<p className="text-muted-foreground text-base font-normal">
												{workshop.fields.description}
											</p>
										</CardContent>
									)}
								</div>
								<CardFooter className="flex items-center justify-between gap-3 px-0 pb-3 pt-5">
									<Contributor className="text-sm" />
									{canCreate && (
										<div className="flex items-center gap-2">
											<span className="text-sm">
												{workshop.fields?.visibility} {workshop.fields?.state}
											</span>
											<Button asChild variant="outline" size="sm">
												<Link
													href={`/workshops/${workshop.fields?.slug || workshop.id}/edit`}
												>
													Edit
												</Link>
											</Button>
										</div>
									)}
								</CardFooter>
							</div>
						</Card>
					</li>
				))}
			</ul>
			{canCreate && (
				<div className="mx-auto flex w-full items-center justify-center py-16">
					<Button asChild variant="secondary" className="gap-1">
						<Link href="/workshops/new">
							<FilePlus2 className="h-4 w-4" /> New Workshop
						</Link>
					</Button>
				</div>
			)}
		</>
	)
}
