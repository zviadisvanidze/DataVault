import { test, expect } from "@playwright/test";

test("company status dialogs preserve search and page; audit context is visible on mobile", async ({
  page,
}) => {
  let status = "active",
    mutations = 0;
  const searches = [];
  await page.addInitScript(() =>
    sessionStorage.setItem("datavault.platform.session", "fixture-admin"),
  );
  await page.route("**/backend/admin/**", (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith("/suspend") || path.endsWith("/reactivate")) {
      mutations++;
      status = path.endsWith("/suspend") ? "suspended" : "active";
      return route.fulfill({ json: {} });
    }
    if (path.endsWith("/companies")) {
      searches.push(url.searchParams.toString());
      return route.fulfill({
        json: {
          items: [
            {
              id: "company1",
              name: "QA Company",
              country: "GE",
              industry: "Testing",
              platformStatus: status,
            },
          ],
          pagination: { total: 30 },
        },
      });
    }
    if (path.endsWith("/companies/company1"))
      return route.fulfill({
        json: {
          company: {
            id: "company1",
            name: "QA Company",
            platformStatus: status,
          },
          employees: { accepted: 0 },
          currentlyStoredFiles: { total: 0 },
        },
      });
    if (path.endsWith("/audit-logs"))
      return route.fulfill({
        json: {
          items: [
            {
              id: "audit1",
              action: "company_suspended",
              targetType: "company",
              targetId: "company1",
              reason: "security_review",
              createdAt: "2026-10-03T12:34:56Z",
            },
            {
              id: "audit2",
              action: "company_reactivated",
              targetType: "company",
              targetId: "missing",
              createdAt: "2026-10-03T12:35:56Z",
            },
          ],
          pagination: { total: 2 },
        },
      });
    if (path.endsWith("/companies/missing"))
      return route.fulfill({ status: 404, json: {} });
    return route.fulfill({ json: {} });
  });
  page.on("dialog", () => {
    throw new Error("Native confirmation must not be used");
  });
  await page.goto("/admin");
  await page.getByRole("button", { name: "Companies", exact: true }).click();
  await page.getByRole("textbox", { name: "Search companies" }).fill("QA");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect.poll(() => searches.at(-1)).toContain("search=QA");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect.poll(() => searches.at(-1)).toContain("page=2");
  await page.getByRole("button", { name: "View", exact: true }).click();
  await page
    .getByRole("button", { name: "Suspend company", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("QA Company");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(mutations).toBe(0);
  await page
    .getByRole("button", { name: "Suspend company", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Suspend company", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Company details" }),
  ).toContainText("suspended");
  expect(searches.at(-1)).toContain("search=QA");
  expect(searches.at(-1)).toContain("page=2");
  await expect(
    page.getByRole("textbox", { name: "Search companies" }),
  ).toHaveValue("QA");
  await page
    .getByRole("button", { name: "Reactivate company", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Reactivate company", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(mutations).toBe(2);
  expect(searches.at(-1)).toContain("page=2");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Audit logs", exact: true }).click();
  await expect(page.locator(".platform-row").first()).toContainText(
    "QA Company",
  );
  await expect(page.locator(".platform-row").last()).toContainText(
    "Company unavailable (missing)",
  );
  await expect(page.locator("time").first()).toBeVisible();
  await expect(page.locator("time").first()).toHaveAttribute(
    "datetime",
    "2026-10-03T12:34:56Z",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/admin-audit-mobile.png",
    fullPage: true,
  });
});

test("suspended login has helpful copy without mislabeling wrong passwords", async ({
  page,
}) => {
  let message = "Account is unavailable";
  await page.route("**/backend/auth/sign-in", (r) =>
    r.fulfill({ status: 401, json: { message } }),
  );
  await page.goto("/login");
  await page.getByLabel("Work email").fill("qa@example.test");
  await page.getByLabel("Password", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "Sign in to your workspace" }).click();
  await expect(page.locator(".alert.error")).toContainText(
    "access to DataVault is suspended",
  );
  message = "Invalid credentials";
  await page.getByRole("button", { name: "Sign in to your workspace" }).click();
  await expect(page.locator(".alert.error")).not.toContainText("is suspended");
  await page.goto("/auth/sign-in?error=account_unavailable");
  await expect(page.locator(".alert.error")).toContainText(
    "inactive or suspended",
  );
  await expect(page.locator(".alert.error")).not.toContainText(
    "request a new activation email",
  );
});
