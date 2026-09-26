import { NextRequest, NextResponse } from "next/server";
import { courseBuilderAdapter } from "@/db";
import { ProductResourceAttachRequestSchema } from "@/lib/agent-api-contracts";
import { attachProductResource } from "@/lib/product-resource-attachment";
import { getUserAbilityForRequest } from "@/server/ability-for-request";
import { log } from "@/server/logger";
import { withSkill } from "@/server/with-skill";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

const postProductResource = async (
  request: NextRequest,
  { params }: { params: Promise<{ productId: string }> },
) => {
  try {
    const { ability, user } = await getUserAbilityForRequest(request);
    if (!user) {
      return NextResponse.json(
        { error: "Unauthorized", docs: "/api" },
        { status: 401, headers: corsHeaders },
      );
    }
    if (!ability.can("update", "Content")) {
      return NextResponse.json(
        { error: "Forbidden", docs: "/api" },
        { status: 403, headers: corsHeaders },
      );
    }

    const { productId } = await params;
    const parsed = ProductResourceAttachRequestSchema.safeParse(
      await request.json(),
    );
    if (!productId?.trim() || !parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid input",
          ...(!parsed.success && { details: parsed.error.format() }),
        },
        { status: 400, headers: corsHeaders },
      );
    }

    const { resourceId } = parsed.data;
    const product = await courseBuilderAdapter.getProduct(productId);
    if (!product) {
      return NextResponse.json(
        { error: "Product not found" },
        { status: 404, headers: corsHeaders },
      );
    }
    const resource = await courseBuilderAdapter.getContentResource(resourceId);
    if (!resource) {
      return NextResponse.json(
        { error: "Resource not found" },
        { status: 404, headers: corsHeaders },
      );
    }

    // CMS permits multiple resources per product and restores soft-deleted joins.
    const { position } = await attachProductResource({
      productId,
      resourceId,
      addedBy: user.id,
    });
    const result = { productId, resourceId, position };
    return NextResponse.json(
      {
        ok: true,
        command: "POST /api/products/[productId]/resources",
        result,
        next_actions: [],
        ...result,
      },
      { headers: corsHeaders },
    );
  } catch (error) {
    await log.error("api.products.resources.post.failed", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: corsHeaders },
    );
  }
};

export const POST = withSkill(postProductResource);
