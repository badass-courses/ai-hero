/**
 * `sendAnEmail` returns Postmark's JSON without checking it, so a rejected
 * send looks like a success. Postmark reports success as `ErrorCode: 0`.
 */
export function assertPostmarkAccepted(response: unknown) {
  if (!response || typeof response !== "object" || !("ErrorCode" in response))
    return;
  const { ErrorCode, Message } = response as {
    ErrorCode: unknown;
    Message?: unknown;
  };
  if (ErrorCode !== 0) {
    throw new Error(
      `Postmark rejected the email: ${String(ErrorCode)} ${String(Message ?? "")}`,
    );
  }
}
