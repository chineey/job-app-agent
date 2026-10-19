import { describe, expect, it } from "vitest";

import { isAuthorizedCronRequest } from "./auth";

describe("cron authorization", () => {
  const secret = "cron-secret";

  it.each(["Bearer", "bearer", "BEARER"])(
    "accepts the exact token with the %s scheme",
    (scheme) => {
      expect(isAuthorizedCronRequest(`${scheme} ${secret}`, secret)).toBe(true);
    },
  );

  it.each([undefined, "", " ", "\t", "\n"])(
    "fails closed when the expected secret is %j",
    (expectedSecret) => {
      expect(
        isAuthorizedCronRequest("Bearer cron-secret", expectedSecret),
      ).toBe(false);
    },
  );

  it.each([
    null,
    "",
    "Basic cron-secret",
    "Bearer",
    "Bearer ",
    "Bearer  cron-secret",
    "Bearer cron-secret extra",
    "Bearer cron-secret,other",
    "Bearer cron-secret\n",
    "Bearer cron-secret\r\n",
    "Bearer crOn-secret",
    "Bearer short",
    "Bearer a-much-longer-token",
  ])("rejects a missing, malformed or incorrect header: %j", (header) => {
    expect(isAuthorizedCronRequest(header, secret)).toBe(false);
  });

  it("rejects unequal UTF-8 byte lengths without throwing", () => {
    expect(isAuthorizedCronRequest("Bearer é", "a")).toBe(false);
  });
});
