import { notFound } from 'next/navigation'
import {
	renderSkillsWorkflowCertificateOpenGraphImage,
	SKILLS_WORKFLOW_CERTIFICATE_OG_SIZE,
} from '@/components/certificates/skills-workflow-certificate-og'
import { getPublicSkillsWorkflowCertificateShare } from '@/lib/subscriber-marketing/value-path-certificate-shares'

export const size = SKILLS_WORKFLOW_CERTIFICATE_OG_SIZE
export const dynamic = 'force-dynamic'

export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ slug: string }> },
) {
	const { slug } = await params
	const share = await getPublicSkillsWorkflowCertificateShare(slug)
	if (!share) notFound()
	return renderSkillsWorkflowCertificateOpenGraphImage(share)
}
