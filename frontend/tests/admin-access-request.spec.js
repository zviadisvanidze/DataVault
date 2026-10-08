import { test, expect } from "@playwright/test";

test("a visitor requests access and sees the email verification step", async ({
  page,
}) => {
  let body;
  await page.route("**/backend/admin/access/request", (route) => {
    body = route.request().postDataJSON();
    return route.fulfill({
      status: 202,
      json: { message: "Check your email" },
    });
  });
  await page.goto("/admin");
  await page
    .getByRole("button", { name: "Request platform admin access" })
    .click();
  await page.getByLabel("Full name").fill("Alex Morgan");
  await page.getByLabel("Email address").fill("alex@example.com");
  await page.getByRole("button", { name: "Send verification email" }).click();
  await expect(
    page.getByRole("heading", { name: "Check your email" }),
  ).toBeVisible();
  expect(body).toEqual({ fullName: "Alex Morgan", email: "alex@example.com" });
});

test("email verification exchanges its one-time fragment once and removes it", async ({
  page,
}) => {
  let calls = 0;
  const code = "A".repeat(43);
  await page.route("**/backend/admin/access/verify", (route) => {
    calls += 1;
    expect(route.request().postDataJSON()).toEqual({ token: code });
    return route.fulfill({ json: { verified: true } });
  });
  await page.goto(`/admin#verify_admin_request=${code}`);
  await expect(
    page.getByRole("heading", { name: "Request sent" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/admin$/);
  expect(calls).toBe(1);
});

test("a used verification link and an invalid setup link show helpful errors", async ({
  page,
}) => {
  const code = "B".repeat(43);
  await page.route("**/backend/admin/access/verify", (route) =>
    route.fulfill({ status: 400, json: { message: "Invalid token" } }),
  );
  await page.goto(`/admin#verify_admin_request=${code}`);
  await expect(
    page.getByText(/verification link has expired or was already used/i),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto("/admin#setup_admin=bad");
  await expect(
    page.getByRole("button", { name: "Activate admin account" }),
  ).toBeDisabled();
  await expect(page).toHaveURL(/\/admin$/);
});

test("approved requester sets a password, then signs in separately", async ({
  page,
}) => {
  let body;
  const code = "C".repeat(43);
  await page.route("**/backend/admin/access/setup", (route) => {
    body = route.request().postDataJSON();
    return route.fulfill({ json: { activated: true } });
  });
  await page.goto(`/admin#setup_admin=${code}`);
  await page
    .getByLabel("New password", { exact: true })
    .fill("SecurePassword123!");
  await page.getByLabel("Confirm new password").fill("SecurePassword123!");
  await page.getByRole("button", { name: "Activate admin account" }).click();
  await expect(
    page.getByRole("heading", { name: "Platform administration" }),
  ).toBeVisible();
  await expect(page.getByText(/account is ready/i)).toBeVisible();
  expect(body).toEqual({ token: code, newPassword: "SecurePassword123!" });
  await expect(page).toHaveURL(/\/admin$/);
});

test("platform admin reviews verified requests", async ({ page }) => {
  const id = "507f1f77bcf86cd799439011";
  await page.addInitScript(() =>
    sessionStorage.setItem("datavault.platform.session", "admin-token"),
  );
  await page.route("**/backend/admin/dashboard", (route) =>
    route.fulfill({ json: {} }),
  );
  await page.route(/\/backend\/admin\/access-requests(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        total: 1,
        items: [
          {
            id,
            fullName: "Alex Morgan",
            email: "alex@example.com",
            status: "pending_review",
            verifiedAt: "2026-10-03T12:00:00.000Z",
          },
        ],
      },
    }),
  );
  let decision;
  await page.route(
    `**/backend/admin/access-requests/${id}/decision`,
    (route) => {
      decision = route.request().postDataJSON();
      expect(route.request().headers().authorization).toBe(
        "Bearer admin-token",
      );
      return route.fulfill({
        json: { status: "approved", notificationDelivered: true },
      });
    },
  );
  await page.goto("/admin");
  await page.getByRole("button", { name: "Access requests" }).click();
  await expect(page.getByText("alex@example.com")).toBeVisible();
  await page.getByRole("button", { name: "Approve request" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Approve request" })
    .click();
  await expect(page.getByText("Request approved. Email sent.")).toBeVisible();
  expect(decision).toEqual({ decision: "approve" });
});
