import { Effect, Either } from "effect";
import { z } from "zod";
import type {
  CurrentSubscriberTagsPageEvidence,
  CurrentSubscriberTagsPageRequest,
} from "./current-authority";

const KIT_V4 = "https://api.kit.com/v4";
const MAX_BODY_BYTES = 128 * 1024;
const ProviderId = z.number().int().positive().safe();
const Cursor = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const SubscriberEnvelope = z
  .object({
    subscriber: z
      .object({
        id: ProviderId,
        email_address: z.string().min(1),
        state: z.string().min(1),
        fields: z.record(z.string().nullable()),
      })
      .passthrough(),
  })
  .strict();
const TagsEnvelope = z.object({
  tags: z.array(z.object({ id: ProviderId })).max(100),
  pagination: z.object({
    has_next_page: z.boolean(),
    end_cursor: Cursor.nullable(),
  }),
  // CLI presentation wrappers and mixed endpoint identities are not HTTP bodies.
  truncated: z.never().optional(),
  result: z.never().optional(),
  ok: z.never().optional(),
  subscriber: z.never().optional(),
});

/** Fixed public failure only. Never attach response text, URLs, headers or causes. */
export class KitCommunicationUnavailable extends Error {
  readonly type = "AuthorityUnavailable" as const;
  readonly reason = "Current Kit communication transport unavailable";
  constructor() {
    super("Current Kit communication transport unavailable");
    this.name = "KitCommunicationUnavailable";
  }
}
function unavailable(): never {
  throw new KitCommunicationUnavailable();
}
function rejectResponse(response: Response): never {
  void response.body?.cancel().catch(() => {});
  return unavailable();
}
function subscriberId(value: string): string {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]*$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    return unavailable();
  return value;
}
function timestamp(now: () => Date): string {
  const date = now();
  if (!(date instanceof Date) || !Number.isFinite(date.getTime()))
    return unavailable();
  return date.toISOString();
}

/** Full stream completion + bounded UTF-8/JSON decode, not a CLI truncation flag. */
async function readJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const lengthHeader = response.headers.get("content-length");
  const length = lengthHeader === null ? null : Number(lengthHeader);
  if (
    lengthHeader !== null &&
    (!/^[0-9]+$/.test(lengthHeader) ||
      !Number.isSafeInteger(length) ||
      length! > MAX_BODY_BYTES)
  )
    return unavailable();
  if (!response.body) return unavailable();
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  let complete = false;
  try {
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      if (signal.aborted) return unavailable();
      const next = await reader.read();
      if (signal.aborted) return unavailable();
      if (next.done) break;
      if (chunks.length >= 4096) return unavailable();
      bytes += next.value.byteLength;
      if (bytes > MAX_BODY_BYTES) return unavailable();
      chunks.push(next.value);
    }
    // Fetch may decompress the body while preserving the encoded Content-Length.
    const encoding = response.headers.get("content-encoding");
    if (
      (!encoding || encoding === "identity") &&
      length !== null &&
      bytes !== length
    )
      return unavailable();
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const decoded: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(body),
    );
    complete = true;
    return decoded;
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}

/**
 * Concrete single-attempt GET callbacks; no environment, default fetch, cache,
 * policy, pagination loop or runtime registration. Inject the SAME clock used by
 * current-authority. Returned subscriber data is private adapter input, not an
 * operator/logging surface.
 *
 * Kit v4 contract: GET /subscribers/{id} -> {subscriber}; GET
 * /subscribers/{id}/tags -> {tags,pagination:{has_next_page,end_cursor,...}}.
 * A final end_cursor may be non-null. Tags do not echo subscriber identity:
 * binding comes from the exact nonredirected request URL, never an invented field.
 */
export function createKitCommunicationTransport(options: {
  apiKey: string;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => Date;
  timeoutMs?: number;
  signal?: AbortSignal;
}) {
  async function get<Value>(
    url: URL,
    decode: (input: unknown) => Value,
  ): Promise<{ value: Value; readStartedAt: string; readAt: string }> {
    const timeoutMs = options.timeoutMs ?? 5000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
      return unavailable();
    try {
      const operation = Effect.tryPromise({
        try: async (signal) => {
          if (options.signal?.aborted || signal.aborted) return unavailable();
          const key = options.apiKey;
          if (typeof key !== "string" || !key.trim() || /[\r\n]/.test(key))
            return unavailable();
          const readStartedAt = timestamp(options.now);
          const response = await options.fetch(url.toString(), {
            method: "GET",
            redirect: "error",
            cache: "no-store",
            credentials: "omit",
            headers: {
              Accept: "application/json",
              "X-Kit-Api-Key": key.trim(),
            },
            signal,
          });
          if (
            response.status !== 200 ||
            response.redirected !== false ||
            !["basic", "cors"].includes(response.type) ||
            response.url !== url.toString()
          )
            return rejectResponse(response);
          if (
            !/^application\/json(?:\s*;|$)/i.test(
              response.headers.get("content-type") ?? "",
            )
          )
            return rejectResponse(response);
          const value = decode(await readJson(response, signal));
          const readAt = timestamp(options.now);
          if (readAt < readStartedAt || signal.aborted) return unavailable();
          return { value, readStartedAt, readAt };
        },
        catch: () => new KitCommunicationUnavailable(),
      }).pipe(
        Effect.timeoutFail({
          duration: timeoutMs,
          onTimeout: () => new KitCommunicationUnavailable(),
        }),
      );
      const result = await Effect.runPromise(Effect.either(operation), {
        signal: options.signal,
      });
      if (Either.isLeft(result)) throw result.left;
      return result.right;
    } catch {
      return unavailable();
    }
  }
  return {
    getSubscriber: async (id: string) => {
      const canonical = subscriberId(id);
      const url = new URL(
        `${KIT_V4}/subscribers/${encodeURIComponent(canonical)}`,
      );
      const result = await get(url, (input) => {
        const parsed = SubscriberEnvelope.safeParse(input);
        if (!parsed.success || String(parsed.data.subscriber.id) !== canonical)
          return unavailable();
        return parsed.data.subscriber;
      });
      return result.value;
    },
    getSubscriberTagsPage: async (
      request: CurrentSubscriberTagsPageRequest,
    ): Promise<CurrentSubscriberTagsPageEvidence> => {
      const parsed = z
        .object({
          subscriberId: z.string(),
          after: Cursor.nullable(),
          limit: z.literal(100),
        })
        .safeParse(request);
      if (!parsed.success) return unavailable();
      const canonical = subscriberId(parsed.data.subscriberId);
      const after = parsed.data.after;
      const url = new URL(
        `${KIT_V4}/subscribers/${encodeURIComponent(canonical)}/tags`,
      );
      url.searchParams.set("per_page", "100");
      if (after !== null) url.searchParams.set("after", after);
      const result = await get(url, (input) => {
        const body = TagsEnvelope.safeParse(input);
        if (
          !body.success ||
          (body.data.pagination.has_next_page &&
            (!body.data.pagination.end_cursor ||
              body.data.pagination.end_cursor === after))
        )
          return unavailable();
        return body.data;
      });
      return {
        subscriberId: canonical,
        after,
        tags: result.value.tags,
        readStartedAt: result.readStartedAt,
        readAt: result.readAt,
        truncated: false,
        pagination: result.value.pagination.has_next_page
          ? {
              hasNextPage: true,
              nextCursor: result.value.pagination.end_cursor!,
            }
          : { hasNextPage: false, nextCursor: null },
      };
    },
  };
}
