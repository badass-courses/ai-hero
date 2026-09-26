import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getProduct: vi.fn(),
  getContentResource: vi.fn(),
  findMany: vi.fn(),
  findFirst: vi.fn(),
  insert: vi.fn(),
  values: vi.fn(),
  update: vi.fn(),
  set: vi.fn(),
  where: vi.fn(),
  revalidateProducts: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("@/db", () => ({
  courseBuilderAdapter: {
    getProduct: mocks.getProduct,
    getContentResource: mocks.getContentResource,
  },
  db: {
    query: {
      contentResourceProduct: {
        findMany: mocks.findMany,
        findFirst: mocks.findFirst,
      },
    },
    insert: mocks.insert,
    update: mocks.update,
  },
}));
vi.mock("@/lib/product-cache", () => ({
  revalidateProducts: mocks.revalidateProducts,
}));
vi.mock("@/server/ability-for-request", () => ({
  getUserAbilityForRequest: mocks.auth,
}));
vi.mock("@/server/logger", () => ({ log: { error: mocks.logError } }));
vi.mock("@/server/with-skill", () => ({
  withSkill: (handler: unknown) => handler,
}));

import { POST } from "@/app/api/(content)/products/[productId]/resources/route";

const context = { params: Promise.resolve({ productId: "product_1" }) };
const request = (resourceId: unknown = "resource_1") =>
  new NextRequest("http://localhost/api/products/product_1/resources", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resourceId }),
  });

describe("POST /api/products/[productId]/resources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({
      user: { id: "user_1" },
      ability: { can: () => true },
    });
    mocks.getProduct.mockResolvedValue({ id: "product_1" });
    mocks.getContentResource.mockResolvedValue({ id: "resource_1" });
    mocks.findMany.mockResolvedValue([]);
    mocks.findFirst.mockResolvedValue(undefined);
    mocks.insert.mockReturnValue({ values: mocks.values });
    mocks.values.mockResolvedValue(undefined);
    mocks.update.mockReturnValue({ set: mocks.set });
    mocks.set.mockReturnValue({ where: mocks.where });
    mocks.where.mockResolvedValue(undefined);
  });

  it("rejects anonymous requests before database access", async () => {
    mocks.auth.mockResolvedValue({ user: null, ability: { can: () => false } });
    const response = await POST(request(), context);
    expect(response.status).toBe(401);
    expect(mocks.getProduct).not.toHaveBeenCalled();
  });

  it("forbids callers without update Content", async () => {
    mocks.auth.mockResolvedValue({
      user: { id: "user_1" },
      ability: { can: () => false },
    });
    const response = await POST(request(), context);
    expect(response.status).toBe(403);
    expect(mocks.getProduct).not.toHaveBeenCalled();
  });

  it("rejects invalid resource ids without looking up a product", async () => {
    const response = await POST(request(" "), context);
    expect(response.status).toBe(400);
    expect(mocks.getProduct).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing product", async () => {
    mocks.getProduct.mockResolvedValue(null);
    const response = await POST(request(), context);
    expect(response.status).toBe(404);
    expect(mocks.getContentResource).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing resource", async () => {
    mocks.getContentResource.mockResolvedValue(null);
    const response = await POST(request(), context);
    expect(response.status).toBe(404);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("attaches at position 0 with the authenticated user in metadata and invalidates cache", async () => {
    const response = await POST(request(), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      result: { productId: "product_1", resourceId: "resource_1", position: 0 },
      productId: "product_1",
      resourceId: "resource_1",
      position: 0,
    });
    expect(mocks.values).toHaveBeenCalledWith({
      productId: "product_1",
      resourceId: "resource_1",
      position: 0,
      metadata: { addedBy: "user_1" },
    });
    expect(mocks.revalidateProducts).toHaveBeenCalledOnce();
  });

  it("returns the existing position on re-attach without a duplicate insert", async () => {
    mocks.findMany.mockResolvedValue([
      { resourceId: "resource_1", position: 3 },
    ]);
    mocks.findFirst.mockResolvedValue({
      resourceId: "resource_1",
      position: 3,
      deletedAt: null,
    });
    const response = await POST(request(), context);
    expect(response.status).toBe(200);
    expect((await response.json()).result.position).toBe(3);
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("allows a second distinct resource at the next position, as CMS does", async () => {
    mocks.findMany.mockResolvedValue([{ resourceId: "other", position: 0 }]);
    const response = await POST(request(), context);
    expect(response.status).toBe(200);
    expect(mocks.values).toHaveBeenCalledWith(
      expect.objectContaining({ position: 1 }),
    );
  });

  it("restores a soft-deleted relation instead of inserting another row", async () => {
    mocks.findFirst.mockResolvedValue({ position: 0, deletedAt: new Date() });
    const response = await POST(request(), context);
    expect(response.status).toBe(200);
    expect(mocks.set).toHaveBeenCalledWith({ deletedAt: null, position: 0 });
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.revalidateProducts).toHaveBeenCalledOnce();
  });
});
