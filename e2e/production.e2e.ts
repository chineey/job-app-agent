import { expect, test } from "@playwright/test";

test("production backend starts and serves its public liveness route", async ({
  request,
}, testInfo) => {
  const response = await request.get("/api/health");
  const body = await response.text();
  const headers = response.headers();

  await testInfo.attach("http-response.json", {
    contentType: "application/json",
    body: JSON.stringify(
      {
        replay: "npm ci && npm test",
        request: { method: "GET", path: "/api/health" },
        response: {
          status: response.status(),
          headers: {
            contentType: headers["content-type"],
            cacheControl: headers["cache-control"],
          },
          body,
        },
      },
      null,
      2,
    ),
  });

  expect(response.status()).toBe(200);
  expect(headers["content-type"]).toContain("application/json");
  expect(headers["cache-control"]).toBe("no-store");
  const payload: unknown = JSON.parse(body);
  expect(payload).toEqual({ status: "ok" });
});
