import { expect, test } from "@playwright/test";
import { NEW_PASSWORD_HINT } from "../lib/password-policy.js";

test("signup and recovery show the same password rule", async ({ page }) => {
  await page.goto("/register");
  await expect(page.getByText(NEW_PASSWORD_HINT)).toBeVisible();
  await page.goto(`/reset-password#token=${"r".repeat(43)}`);
  await expect(page.getByText(NEW_PASSWORD_HINT)).toBeVisible();
});

test("reset rejects a weak password before contacting the backend", async ({
  page,
}) => {
  let exchanged = false;
  await page.route("**/backend/auth/reset-password", (route) => {
    exchanged = true;
    return route.fulfill({ json: { reset: true } });
  });
  await page.goto(`/reset-password#token=${"r".repeat(43)}`);
  await page.getByLabel("New password", { exact: true }).fill("weakpassword12");
  await page.getByLabel("Confirm new password").fill("weakpassword12");
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page.getByRole("alert").first()).toContainText(
    NEW_PASSWORD_HINT,
  );
  expect(exchanged).toBe(false);
});
