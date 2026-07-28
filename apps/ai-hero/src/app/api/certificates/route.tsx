import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ImageResponse } from 'next/og'
import Background from '@/components/certificates/background'
import Logo from '@/components/certificates/logo'
import Signature from '@/components/certificates/signature'
import { db } from '@/db'
import { contentResource, users } from '@/db/schema'
import {
	checkCertificateEligibility,
	checkCohortCertificateEligibility,
} from '@/lib/certificates'
import {
	checkSkillsWorkflowValuePathCertificateEligibility,
	isSkillsWorkflowCertificateResource,
} from '@/lib/subscriber-marketing/value-path-certificates'
import { getPublicSkillsWorkflowCertificateShare } from '@/lib/subscriber-marketing/value-path-certificate-shares'
import { format } from 'date-fns'
import { and, eq, or, sql } from 'drizzle-orm'

// Reads `request.url` to pull `resource` / `cohort` query params, so this
// route is inherently per-request and can't be prerendered.
export const dynamic = 'force-dynamic'
// export const contentType = 'image/png'

export async function GET(request: Request) {
	try {
		const { searchParams } = new URL(request.url)
		const shareSlug = searchParams.get('share')
		const publicShare = shareSlug
			? await getPublicSkillsWorkflowCertificateShare(shareSlug)
			: null
		if (shareSlug && !publicShare) {
			return new Response(JSON.stringify({ error: 'Certificate not found' }), {
				status: 404,
				headers: { 'Content-Type': 'application/json' },
			})
		}

		const resourceSlugOrID = searchParams.get('resource')
		if (!publicShare && !resourceSlugOrID) {
			return new Response(JSON.stringify({ error: 'Missing resource' }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			})
		}
		const userId = searchParams.get('user')
		if (!publicShare && !userId) {
			return new Response(JSON.stringify({ error: 'Missing user' }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			})
		}

		const valuePathCertificate =
			!publicShare &&
			Boolean(
				resourceSlugOrID &&
					isSkillsWorkflowCertificateResource(resourceSlugOrID),
			)
		const resource =
			publicShare || valuePathCertificate || !resourceSlugOrID
				? null
				: await db.query.contentResource.findFirst({
						where: and(
							or(
								eq(
									sql`JSON_EXTRACT (${contentResource.fields}, "$.slug")`,
									resourceSlugOrID,
								),
								eq(contentResource.id, resourceSlugOrID),
							),
						),
					})

		if (!publicShare && !resource && !valuePathCertificate) {
			return new Response(JSON.stringify({ error: 'Resource not found' }), {
				status: 404,
				headers: { 'Content-Type': 'application/json' },
			})
		}

		let isEligible = Boolean(publicShare)
		let completedAt: Date | null | undefined = publicShare?.completedAt
		let certificateTitle = publicShare?.courseName ?? resource?.fields?.title
		let certificateKind = publicShare
			? 'Course'
			: resource?.type === 'cohort'
				? 'Cohort'
				: 'Workshop'
		let certificateName: string | null | undefined = publicShare?.learnerName

		if (valuePathCertificate) {
			const eligibility =
				await checkSkillsWorkflowValuePathCertificateEligibility({
					contactId: userId,
				})
			isEligible = eligibility.eligible
			completedAt = eligibility.completedAt
			certificateTitle = 'AI Hero Skills Workflow'
			certificateKind = 'Course'
			certificateName = eligibility.learnerName || eligibility.learnerEmail
		} else if (!publicShare && resource?.type === 'cohort' && userId) {
			const { hasCompletedCohort, date } =
				await checkCohortCertificateEligibility(resource.id, userId)
			isEligible = hasCompletedCohort
			completedAt = date
		} else if (!publicShare && resourceSlugOrID && userId) {
			const { hasCompletedModule, date } = await checkCertificateEligibility(
				resourceSlugOrID,
				userId,
			)
			isEligible = hasCompletedModule
			completedAt = date
		}

		if (!isEligible) {
			return new Response(
				JSON.stringify({ error: 'Not eligible for certificate' }),
				{
					status: 422,
					headers: { 'Content-Type': 'application/json' },
				},
			)
		}

		const user =
			publicShare || valuePathCertificate || !userId
				? null
				: await db.query.users.findFirst({
						where: or(eq(users.id, userId), eq(users.email, userId)),
					})

		if (!user && !publicShare && !valuePathCertificate) {
			return new Response(JSON.stringify({ error: 'User not found' }), {
				status: 404,
				headers: { 'Content-Type': 'application/json' },
			})
		}

		certificateName = certificateName || user?.name || user?.email

		const fontData = await readFile(
			join(
				process.cwd(),
				'public/fonts/79122e33-d8c9-4b2c-8add-f48bd7b317e0.ttf',
			),
		)

		return new ImageResponse(
			<div
				tw="flex h-full w-full items-center justify-center bg-black flex-col"
				style={{
					fontFamily: 'Maison',
					background: 'linear-gradient(105deg, #FFF 0.91%, #F7F7F9 100%)',
					lineHeight: 1,
					width: 842 * 2,
					height: 595 * 2,
				}}
			>
				<div tw="absolute flex items-center justify-center left-0 top-0 w-full h-full">
					<Background />
				</div>
				<div tw="flex flex-col items-center leading-none text-center justify-center w-full">
					{/* <img
							src={resource?.fields?.coverImage.url}
							width={500}
							height={500}
						/> */}
					<h1
						style={{
							fontSize: 75,
							lineHeight: 0.2,
							color: '#fff',
						}}
						className="font-bold text-white"
					>
						Certificate of Completion
					</h1>
					<div
						style={{
							fontSize: 50,
							maxWidth: 700,
						}}
						tw="flex mt-24 border-b-2 border-gray-500 pb-4 w-full flex-col items-center justify-center text-center text-white"
					>
						{certificateName}
					</div>
					<div
						style={{
							fontSize: 24,
							maxWidth: 700,
							lineHeight: 1.3,
						}}
						tw="flex mt-10 w-full flex-col items-center justify-center text-center text-white"
					>
						Has Successfully Completed the {certificateTitle} {certificateKind}.
					</div>
				</div>
				<div tw="absolute flex items-center justify-center left-32 bottom-32">
					<Logo />
				</div>
				<div tw="absolute flex items-center justify-center bottom-24 text-white">
					<Signature />
				</div>
				<div tw="absolute flex items-center text-xl justify-center bottom-32 right-32 text-white">
					{completedAt && `${format(completedAt, 'MMMM do, y')}`}
				</div>
			</div>,
			{
				width: 842 * 2,
				height: 595 * 2,
				headers:
					publicShare && searchParams.get('download') === '1'
						? {
								'Content-Disposition': `attachment; filename="${certificateFilename(publicShare.learnerName)}"`,
							}
						: undefined,
				fonts: [
					{
						name: 'Maison',
						data: fontData,
						style: 'normal',
					},
				],
			},
		)
	} catch (e: any) {
		console.error('Certificate generation error:', e)
		return new Response(
			JSON.stringify({ error: 'Failed to generate certificate' }),
			{
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			},
		)
	}
}

function certificateFilename(learnerName: string) {
	const safeName = learnerName
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
	return `${safeName || 'ai-hero'}-skills-workflow-certificate.png`
}
