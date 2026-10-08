import { expect, test } from "@playwright/test";

const token = "r".repeat(43);

test("workspace recovery requests a link without disclosing account existence", async ({
  page,
}) => {
  let request;
  await page.route("**/backend/auth/forgot-password", (route) => {
    request = route.request().postDataJSON();
    return route.fulfill({
      status: 202,
      json: { message: "Request received" },
    });
  });
  await page.goto("/login");
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Work email").fill("owner@example.com");
  await page.getByRole("button", { name: "Email reset link" }).click();
  await expect(
    page.getByRole("heading", { name: "Check your inbox" }),
  ).toBeVisible();
  expect(request).toEqual({ email: "owner@example.com" });
});

test("reset link is removed from the address bar and a new password can be set", async ({
  page,
}) => {
  let body;
  await page.route("**/backend/auth/reset-password", (route) => {
    body = route.request().postDataJSON();
    return route.fulfill({ json: { reset: true } });
  });
  await page.goto(`/reset-password#token=${token}`);
  await expect(page).toHaveURL(/\/reset-password$/);
  await page.getByLabel("New password", { exact: true }).fill("NewPassword42!");
  await page.getByLabel("Confirm new password").fill("different123");
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(
    page.getByText("Passwords do not match. Please try again."),
  ).toBeVisible();
  expect(body).toBeUndefined();
  await page.getByLabel("Confirm new password").fill("NewPassword42!");
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(
    page.getByRole("heading", { name: "Password updated" }),
  ).toBeVisible();
  expect(body).toEqual({ token, newPassword: "NewPassword42!" });
});

test("missing, expired and repeated reset links give useful recovery options", async ({
  page,
}) => {
  await page.goto("/reset-password");
  await expect(
    page.getByText(/reset link is missing or invalid/i),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Request a new link" }),
  ).toBeVisible();
  await page.route("**/backend/auth/reset-password", (route) =>
    route.fulfill({
      status: 401,
      json: { message: "Invalid or expired reset link" },
    }),
  );
  await page.goto(`/reset-password#token=${token}`);
  await page.getByLabel("New password", { exact: true }).fill("NewPassword42!");
  await page.getByLabel("Confirm new password").fill("NewPassword42!");
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(
    page.getByText(/invalid, expired, or has already been used/i),
  ).toBeVisible();
});

test("recovery explains service failures without losing the form", async ({
  page,
}) => {
  await page.route("**/backend/auth/forgot-password", (route) =>
    route.fulfill({ status: 503, json: { message: "Service unavailable" } }),
  );
  await page.goto("/forgot-password");
  await page.getByLabel("Work email").fill("owner@example.com");
  await page.getByRole("button", { name: "Email reset link" }).click();
  await expect(
    page.getByText(/couldn’t request a reset link right now/i),
  ).toBeVisible();
  await expect(page.getByLabel("Work email")).toHaveValue("owner@example.com");
});
