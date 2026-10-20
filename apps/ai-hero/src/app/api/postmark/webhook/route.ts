import { createHash } from "node:crypto";
import { type NextRequest } from "next/server";
import { POSTMARK_WEBHOOK_EVENT } from "@/inngest/events/postmark-webhook";
import { sendWithRetry } from "@/inngest/send-with-retry";
import { log } from "@/server/logger";
import { withSkill } from "@/server/with-skill";

export const POST = withSkill(async (req: NextRequest) => {
  const body = await req.json();

  if (
    req.headers.get("course-builder") !== process.env.POSTMARK_WEBHOOK_SECRET
  ) {
    return new Response("ok", {
      status: 200,
    });
  }

  try {
    await sendWithRetry({
      name: POSTMARK_WEBHOOK_EVENT,
      data: {
        ...body,
      },
    });
  } catch (error) {
    // Non-2xx on purpose: Postmark redelivers, which is the safety net.
    void log.error("postmark.webhook.inngest_send_failed", {
      recordType: typeof body?.RecordType === "string" ? body.RecordType : null,
      messageIdHash:
        typeof body?.MessageID === "string"
          ? createHash("sha256")
              .update(body.MessageID)
              .digest("hex")
              .slice(0, 12)
          : null,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response("send failed", { status: 500 });
  }

  return new Response("ok", {
    status: 200,
  });
});
