import { test, expect } from "@playwright/test";

test("existing signup shows a route back to sign in", async ({ page }) => {
  await page.route("**/backend/auth/sign-up", (route) =>
    route.fulfill({
      status: 409,
      json: { message: "Email is already in use" },
    }),
  );
  await page.goto("/register");
  await page.getByLabel("Company name").fill("Acme Studio");
  await page.getByLabel("Your name").fill("Alex Morgan");
  await page.getByLabel("Work email").fill("alex@example.com");
  await page.getByLabel("Create a password").fill("TenantPassword42!");
  await page.getByLabel("Country").fill("GE");
  await page.getByLabel("Industry").fill("Technology");
  await page.getByRole("button", { name: "Create your workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "This account already exists" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Sign in", exact: true }).last(),
  ).toHaveAttribute("href", "/login");
  await page.screenshot({
    path: "test-results/account-exists-desktop.png",
    fullPage: true,
  });
});

test("Google signup collects company details without asking for another password", async ({
  page,
}) => {
  let posted;
  await page.route("**/backend/auth/google/register", (route) => {
    posted = route.request().postDataJSON();
    return route.fulfill({ json: { accessToken: "token" } });
  });
  await page.route("**/backend/auth/current-user", (route) =>
    route.fulfill({
      json: { _id: "user-1", fullName: "Alex", role: "company_owner" },
    }),
  );
  await page.goto(`/register#google_code=${"A".repeat(43)}`);
  await expect(page.getByLabel("Work email")).toHaveCount(0);
  await expect(page.getByLabel("Create a password")).toHaveCount(0);
  await page.getByLabel("Company name").fill("Acme Studio");
  await page.getByLabel("Country").fill("GE");
  await page.getByLabel("Industry").fill("Technology");
  await page
    .getByRole("button", { name: "Create workspace with Google" })
    .click();
  await expect(page).toHaveURL(/\/dashboard$/);
  expect(posted).toEqual({
    code: "A".repeat(43),
    companyName: "Acme Studio",
    country: "GE",
    industry: "Technology",
  });
});

test("platform admin uses a separate token and displays backend data", async ({
  page,
}) => {
  await page.route("**/backend/admin/auth/login", (route) =>
    route.fulfill({ json: { accessToken: "admin-token" } }),
  );
  await page.route("**/backend/admin/dashboard", (route) => {
    expect(route.request().headers().authorization).toBe("Bearer admin-token");
    return route.fulfill({
      json: {
        companies: { total: 3, pendingActivation: 1, suspended: 0 },
        tenantUsers: { total: 6, owners: 3 },
        currentlyStoredFiles: { total: 12, restricted: 2 },
        pendingInvitations: 1,
      },
    });
  });
  await page.goto("/admin");
  await page.getByLabel("Admin email").fill("admin@example.com");
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in to platform" }).click();
  await expect(
    page.getByText("Platform administration", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText("12", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("datavault.platform.session"),
    ),
  ).toBe("admin-token");
  expect(
    await page.evaluate(() => sessionStorage.getItem("datavault.session")),
  ).toBeNull();
  await page.screenshot({
    path: "test-results/platform-admin-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/platform-admin-mobile.png",
    fullPage: true,
  });
});

test("platform admin can request and use an email password reset link", async ({
  page,
}) => {
  let requested;
  let reset;
  await page.route("**/backend/admin/auth/forgot-password", (route) => {
    requested = route.request().postDataJSON();
    return route.fulfill({
      json: {
        message:
          "If this is an active platform admin email, a reset link will arrive shortly.",
      },
    });
  });
  await page.route("**/backend/admin/auth/reset-password", (route) => {
    reset = route.request().postDataJSON();
    return route.fulfill({ json: { reset: true } });
  });
  await page.goto("/admin");
  await page.getByRole("button", { name: "Forgot admin password?" }).click();
  await page.getByLabel("Admin email").fill("platform@example.com");
  await page.getByRole("button", { name: "Email reset link" }).click();
  await expect(
    page.getByRole("heading", { name: "Check your email" }),
  ).toBeVisible();
  expect(requested).toEqual({ email: "platform@example.com" });

  await page.goto(`/admin#reset=${"A".repeat(43)}`);
  await expect(
    page.getByRole("heading", { name: "Set a new password" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/admin$/);
  await page.screenshot({
    path: "test-results/admin-reset-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/admin-reset-mobile.png",
    fullPage: true,
  });
  await page
    .getByLabel("New password", { exact: true })
    .fill("New-Platform-Password42!");
  await page.getByLabel("Confirm new password").fill("Different-Password42!");
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page.locator(".platform-error")).toContainText(
    "Passwords do not match",
  );
  expect(reset).toBeUndefined();
  await page
    .getByLabel("Confirm new password")
    .fill("New-Platform-Password42!");
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(
    page.getByRole("heading", { name: "Platform administration" }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Password updated");
  expect(reset).toEqual({
    token: "A".repeat(43),
    newPassword: "New-Platform-Password42!",
  });
});
