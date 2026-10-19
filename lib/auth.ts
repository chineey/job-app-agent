import { timingSafeEqual } from "node:crypto";

export function isAuthorizedCronRequest(
  authorization: string | null,
  expectedSecret: string | undefined,
): boolean {
  if (!expectedSecret) return false;

  const suppliedSecret = /^Bearer ([^\s]+)$/i.exec(authorization ?? "")?.[1];
  if (!suppliedSecret) return false;

  const suppliedBytes = Buffer.from(suppliedSecret, "utf8");
  const expectedBytes = Buffer.from(expectedSecret, "utf8");

  return (
    suppliedBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(suppliedBytes, expectedBytes)
  );
}
