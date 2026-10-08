import { test, expect } from "@playwright/test";

test("live OAuth start sets browser state", async ({ request }) => {
  test.setTimeout(110000);
  const start = await request.get(
    "https://datavault-saas.onrender.com/auth/google",
    { maxRedirects: 0 },
  );
  expect(start.status()).toBe(302);
  // Do not include the state value, provider URL or cookie in test output.
  const destination = new URL(start.headers().location);
  expect(destination.origin).toBe("https://accounts.google.com");
  expect(destination.searchParams.has("state")).toBe(true);
  const cookie = start.headers()["set-cookie"] || "";
  expect(cookie.includes("__Host-dv_google_oauth=")).toBe(true);
  expect(/HttpOnly/i.test(cookie)).toBe(true);
  expect(/Secure/i.test(cookie)).toBe(true);
  expect(/SameSite=Lax/i.test(cookie)).toBe(true);
});

test("live OAuth gateway rejects a synthetic exchange code", async ({
  request,
}) => {
  test.setTimeout(110000);
  const exchange = await request.post("/backend/auth/google/exchange", {
    data: { code: "x".repeat(43) },
  });
  expect(exchange.status()).toBe(401);
  expect(exchange.headers()["cache-control"]).toContain("no-store");
  for (const path of [
    "/backend/auth/google",
    "/backend/auth/google/callback",
  ]) {
    expect((await request.get(path)).status()).toBe(404);
  }
});
test("live public API responds through the same-origin gateway and rejects unauthenticated access", async ({
  page,
}) => {
  test.setTimeout(110000);
  await page.goto("/login");
  const result = await page.evaluate(async () => {
    const base = "/backend";
    const plans = await fetch(base + "/plans");
    const body = await plans.json();
    const protectedResponse = await fetch(base + "/auth/current-user");
    const paymentsResponse = await fetch(base + "/payments/current");
    const webhookResponse = await fetch(base + "/payments/webhook", {
      method: "POST",
    });
    return {
      status: plans.status,
      codes: body.map((p) => p.code),
      protectedStatus: protectedResponse.status,
      paymentsStatus: paymentsResponse.status,
      webhookStatus: webhookResponse.status,
    };
  });
  expect(result).toEqual({
    status: 200,
    codes: ["free", "basic", "premium"],
    protectedStatus: 401,
    paymentsStatus: 401,
    webhookStatus: 404,
  });
  await page.screenshot({
    path: "test-results/login-desktop.png",
    fullPage: true,
  });
});
