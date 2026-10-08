import { test, expect } from "@playwright/test";

// Deliberately synthetic credentials, used only by intercepted test requests.
const oauthCode = "o".repeat(43);
const oauthToken = "oauth-test-only-session";
const exchangePath = "http://localhost:3000/backend/auth/google/exchange";

test("OAuth uses document navigation on sign-in and registration", async ({
  page,
}) => {
  await page.goto("/login");
  const google = page.getByRole("link", { name: "Continue with Google" });
  await expect(google).toHaveAttribute(
    "href",
    "https://datavault-saas.onrender.com/auth/google",
  );
  await page.route(
    "https://datavault-saas.onrender.com/auth/google",
    async (r) => {
      expect(r.request().isNavigationRequest()).toBe(true);
      expect(r.request().method()).toBe("GET");
      await r.fulfill({
        contentType: "text/html",
        body: "<h1>OAuth navigation fixture</h1>",
      });
    },
  );
  await google.click();
  await expect(
    page.getByRole("heading", { name: "OAuth navigation fixture" }),
  ).toBeVisible();
  await page.goto("/register");
  await expect(google).toHaveAttribute(
    "href",
    "https://datavault-saas.onrender.com/auth/google",
  );
});

for (const role of ["owner", "member"]) {
  test(`OAuth ${role} success removes the fragment before a single exchange and restores on refresh`, async ({
    page,
  }) => {
    await fixture(page, role, false);
    let exchanges = 0;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    await page.route(exchangePath, async (r) => {
      exchanges++;
      expect(r.request().method()).toBe("POST");
      expect(r.request().postDataJSON()).toEqual({ code: oauthCode });
      expect(r.request().headers().authorization).toBeUndefined();
      expect(new URL(page.url()).hash).toBe("");
      await gate;
      await r.fulfill({ json: { accessToken: oauthToken } });
    });
    await page.goto(`/auth/sign-in#code=${oauthCode}`);
    await expect(page.getByText("Completing Google sign-in")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Continue with Google" }),
    ).toHaveCount(0);
    await expect(page).toHaveURL(/\/auth\/sign-in$/);
    // Unrelated rerenders must not consume the one-use code again (including Strict Mode).
    await page.getByRole("button", { name: "Open AI chat" }).click();
    await expect.poll(() => exchanges).toBe(1);
    const currentUser = page.waitForRequest((r) =>
      r.url().endsWith("/auth/current-user"),
    );
    release();
    expect((await currentUser).headers().authorization).toBe(
      `Bearer ${oauthToken}`,
    );
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(
      page.getByRole("heading", { name: "The big picture." }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => sessionStorage.getItem("datavault.session")),
    ).toBe(oauthToken);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "The big picture." }),
    ).toBeVisible();
    await expect(
      page
        .locator(".sidebar")
        .getByRole("link", { name: "Employees", exact: true }),
    ).toHaveCount(role === "owner" ? 1 : 0);
    expect(exchanges).toBe(1);
  });
}

test("OAuth missing code, malformed code and denial never exchange; mobile form remains usable", async ({
  page,
}) => {
  let exchanges = 0;
  await page.route(exchangePath, (r) => {
    exchanges++;
    return r.fulfill({ status: 401, json: {} });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [suffix, error] of [
    ["", null],
    ["#code=", /link is invalid/],
    ["#code=bad", /link is invalid/],
    [`#code=${oauthCode}&code=${oauthCode}`, /link is invalid/],
    ["?error=google_auth_cancelled", /sign-in was cancelled/],
    [`?error=google_auth_cancelled#code=${oauthCode}`, /sign-in was cancelled/],
    ["?error=untrusted-provider-message", /could not be completed/],
  ]) {
    // The backend callback is a full document navigation, not a hash-only change.
    await page.goto("about:blank");
    await page.goto(`/auth/sign-in${suffix}`);
    await expect(
      page.getByRole("button", { name: "Sign in to your workspace" }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/auth\/sign-in$/);
    if (error)
      await expect(page.getByRole("main").getByRole("alert")).toContainText(
        error,
      );
    else await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  expect(exchanges).toBe(0);
  await page.screenshot({
    path: "test-results/oauth-mobile.png",
    fullPage: true,
  });
});

for (const failure of [400, 401, 403, 429, 500, 503, "network"]) {
  test(`OAuth exchange ${failure} is recoverable without automatic replay`, async ({
    page,
  }) => {
    let exchanges = 0;
    await page.route(exchangePath, (r) => {
      exchanges++;
      return failure === "network"
        ? r.abort("failed")
        : r.fulfill({
            status: failure,
            json: { message: "private backend details" },
          });
    });
    await page.goto(`/auth/sign-in#code=${oauthCode}`);
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
      failure === 400 || failure === 401
        ? /invalid or has expired/
        : failure === 403
          ? /could not be completed securely/
          : failure === 429
            ? /Too many requests/
            : failure === 503 || failure === 500
              ? /temporarily unavailable/
              : /couldn’t connect/,
    );
    await expect(page.getByRole("main").getByRole("alert")).not.toContainText(
      "private backend details",
    );
    await expect(
      page.getByRole("link", { name: "Continue with Google" }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => sessionStorage.getItem("datavault.session")),
    ).toBeNull();
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Sign in to your workspace" }),
    ).toBeVisible();
    expect(exchanges).toBe(1);
  });
}

test("OAuth failed user lookup clears the partial session, and password sign-in still works", async ({
  page,
}) => {
  await fixture(page, "owner", false);
  await page.route(exchangePath, (r) =>
    r.fulfill({ json: { accessToken: oauthToken } }),
  );
  await page.route(`${api}/auth/current-user`, (r) =>
    r.fulfill({ status: 503, json: {} }),
  );
  await page.goto(`/auth/sign-in#code=${oauthCode}`);
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    /temporarily unavailable/,
  );
  expect(
    await page.evaluate(() => sessionStorage.getItem("datavault.session")),
  ).toBeNull();
  await page.unroute(`${api}/auth/current-user`);
  await page.route(`${api}/auth/sign-in`, (r) =>
    r.fulfill({ json: { accessToken: "password-test-session" } }),
  );
  await page
    .getByLabel("Work email", { exact: true })
    .fill("alex@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("Example-password-123");
  await page.getByRole("button", { name: "Sign in to your workspace" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
});

test("OAuth supersedes an existing session instead of restoring the previous user", async ({
  page,
}) => {
  await fixture(page, "member");
  let exchanges = 0;
  await page.route(exchangePath, async (r) => {
    exchanges++;
    await r.fulfill({ json: { accessToken: oauthToken } });
  });
  await page.goto(`/auth/sign-in#code=${oauthCode}`);
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(
    page.getByRole("heading", { name: "The big picture." }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => sessionStorage.getItem("datavault.session")),
  ).toBe(oauthToken);
  expect(exchanges).toBe(1);
});

function paymentFixture(overrides = {}) {
  return {
    mode: "test",
    planCode: "basic",
    paymentAccess: "active",
    stripeStatus: "active",
    cancelAtPeriodEnd: false,
    pendingPlanCode: null,
    pendingPlanAt: null,
    billingPeriod: billing.billingPeriod,
    synchronization: {
      issue: "none",
      lastSyncedAt: "2026-09-27T10:00:00Z",
      pendingUsage: 0,
    },
    invoices: [],
    ...overrides,
  };
}

test("OAuth replay is rejected after logout and malformed success never creates a session", async ({
  page,
}) => {
  await fixture(page, "owner", false);
  let calls = 0;
  await page.route(exchangePath, (r) => {
    calls++;
    return r.fulfill(
      calls === 1
        ? { json: { accessToken: oauthToken } }
        : { status: 401, json: {} },
    );
  });
  await page.goto(`/auth/sign-in#code=${oauthCode}`);
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto(`/auth/sign-in#code=${oauthCode}`);
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    /invalid or has expired/,
  );
  expect(calls).toBe(2);
  expect(
    await page.evaluate(() => sessionStorage.getItem("datavault.session")),
  ).toBeNull();
  await page.route(exchangePath, (r) =>
    r.fulfill({ json: { unexpected: true } }),
  );
  await page.goto("about:blank");
  await page.goto(`/auth/sign-in#code=${oauthCode}`);
  await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
  expect(
    await page.evaluate(() => sessionStorage.getItem("datavault.session")),
  ).toBeNull();
});
test("billing distinguishes disabled Stripe from an outage", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/dashboard/billing");
  await expect(page.getByText("Stripe isn’t connected yet.")).toBeVisible();
  await page.getByRole("button", { name: "Upgrade to Premium" }).click();
  const assignment = page.waitForRequest(
    (r) => r.method() === "PATCH" && r.url().endsWith("/subscriptions/current"),
  );
  await page.getByRole("button", { name: "Confirm plan change" }).click();
  expect((await assignment).postDataJSON()).toEqual({ planCode: "premium" });
  await page.route(`${api}/payments/current`, (r) =>
    r.fulfill({
      status: 503,
      json: { message: "Provider temporarily unavailable" },
    }),
  );
  await page.reload();
  await expect(
    page.getByText(/Billing is temporarily unavailable/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Upgrade to Premium" }),
  ).toBeDisabled();
});
test("billing avoids test-mode labels while clearly disclosing that no real charges occur", async ({
  page,
}) => {
  await fixture(page);
  await page.route(`${api}/payments/current`, (route) =>
    route.fulfill({ json: paymentFixture() }),
  );
  await page.goto("/dashboard/billing");
  await expect(
    page.getByText("No real charges", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      /Stripe (is in )?test mode|test payment method|test Checkout/i,
    ),
  ).toHaveCount(0);
  await page.goto("/payments/success");
  await expect(
    page.getByText(/No real charges are currently made/),
  ).toBeVisible();
  await expect(page.getByText(/Stripe (is in )?test mode/i)).toHaveCount(0);
});
test("paid setup uses Stripe checkout with only the documented plan payload", async ({
  page,
}) => {
  await fixture(page);
  await page.route(`${api}/payments/current`, (r) =>
    r.fulfill({
      json: paymentFixture({ stripeStatus: null, paymentAccess: "unmanaged" }),
    }),
  );
  await page.route(`${api}/payments/checkout`, (r) =>
    r.fulfill({
      json: {
        url: "https://checkout.stripe.com/c/pay/test_fixture",
        mode: "setup",
        paymentCollected: false,
      },
    }),
  );
  await page.route("https://checkout.stripe.com/**", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<h1>Hosted checkout fixture</h1>",
    }),
  );
  await page.goto("/dashboard/billing");
  await page.getByRole("button", { name: "Upgrade to Premium" }).click();
  const checkout = page.waitForRequest(
    (r) => r.method() === "POST" && r.url().endsWith("/payments/checkout"),
  );
  await page.getByRole("button", { name: "Continue to Stripe" }).click();
  expect((await checkout).postDataJSON()).toEqual({ planCode: "premium" });
  await expect(page).toHaveURL(
    "https://checkout.stripe.com/c/pay/test_fixture",
  );
});
for (const plan of ["basic", "premium"]) {
  test(`can buy ${plan} again after downgrading to Free`, async ({ page }) => {
    await fixture(page);
    await page.route(`${api}/subscriptions/current/billing`, (r) =>
      r.fulfill({ json: { ...billing, plan: plans[0] } }),
    );
    await page.route(`${api}/payments/current`, (r) =>
      r.fulfill({
        json: paymentFixture({ planCode: "free", stripeStatus: "canceled" }),
      }),
    );
    await page.route(`${api}/payments/checkout`, (r) => {
      expect(r.request().postDataJSON()).toEqual({ planCode: plan });
      return r.fulfill({
        json: {
          url: "https://checkout.stripe.com/c/pay/test_fixture",
          mode: "setup",
          paymentCollected: false,
        },
      });
    });
    await page.route("https://checkout.stripe.com/**", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: "<h1>Hosted checkout fixture</h1>",
      }),
    );
    await page.goto("/dashboard/billing");
    await page
      .getByRole("button", {
        name: `Upgrade to ${plan === "basic" ? "Basic" : "Premium"}`,
      })
      .click();
    await page.getByRole("button", { name: "Continue to Stripe" }).click();
    await expect(page).toHaveURL(
      "https://checkout.stripe.com/c/pay/test_fixture",
    );
  });
}

test("Free downgrade confirms immediate loss of paid features", async ({
  page,
}) => {
  await fixture(page);
  let state = paymentFixture();
  await page.route(`${api}/payments/current`, (r) =>
    r.fulfill({ json: state }),
  );
  await page.route(`${api}/payments/cancel`, (r) => {
    expect(r.request().postDataJSON()).toEqual({});
    state = paymentFixture({ planCode: "free", stripeStatus: "canceled" });
    return r.fulfill({ json: { planCode: "free", pendingPlanCode: null } });
  });
  await page.goto("/dashboard/billing");
  await page.getByRole("button", { name: "Downgrade to Free" }).click();
  await expect(
    page.getByText(/Free takes effect immediately after confirmation/),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/free-downgrade-immediate-desktop.png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "Confirm plan change" }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/free-downgrade-immediate-mobile.png",
  });
  await page.getByRole("button", { name: "Confirm plan change" }).click();
  await expect(page.getByText("Your workspace is now on Free.")).toBeVisible();
  await expect(page.getByText(/Cancellation is scheduled/)).toHaveCount(0);
});
test("Free downgrade explains stored-file conflicts without exposing provider errors", async ({
  page,
}) => {
  await fixture(page);
  await page.route(`${api}/payments/current`, (r) =>
    r.fulfill({ json: paymentFixture() }),
  );
  await page.route(`${api}/payments/cancel`, (r) =>
    r.fulfill({
      status: 409,
      json: {
        code: "plan_file_limit",
        planCode: "free",
        limit: 10,
        storedFiles: 11,
        message: "private diagnostics",
      },
    }),
  );
  await page.goto("/dashboard/billing");
  await page.getByRole("button", { name: "Downgrade to Free" }).click();
  await page.getByRole("button", { name: "Confirm plan change" }).click();
  await expect(page.getByText(/Free allows 10 stored files/)).toBeVisible();
  await expect(page.getByText("private diagnostics")).toHaveCount(0);
});
test("Basic downgrade explains what to remove before retrying", async ({
  page,
}) => {
  await fixture(page);
  await page.route(`${api}/subscriptions/current/billing`, (r) =>
    r.fulfill({ json: { ...billing, plan: plans[2] } }),
  );
  await page.route(`${api}/payments/current`, (r) =>
    r.fulfill({ json: paymentFixture({ planCode: "premium" }) }),
  );
  await page.route(`${api}/payments/plan`, (r) =>
    r.fulfill({
      status: 409,
      json: {
        code: "plan_file_limit",
        planCode: "basic",
        limit: 100,
        storedFiles: 101,
      },
    }),
  );
  await page.goto("/dashboard/billing");
  await page.getByRole("button", { name: "Downgrade to Basic" }).click();
  await expect(
    page.getByText(/Nothing is removed automatically/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Confirm plan change" }).click();
  await expect(
    page.getByText(/Basic allows 100 stored files. You currently have 101/),
  ).toBeVisible();
});

for (const target of ["free", "basic"]) {
  test(`${target} downgrade offers manual removal or separately confirmed automatic cleanup`, async ({
    page,
  }) => {
    await fixture(page);
    const limit = target === "free" ? 10 : 100;
    await page.route(`${api}/subscriptions/current/billing`, (r) =>
      r.fulfill({ json: { ...billing, plan: plans[2] } }),
    );
    await page.route(`${api}/payments/current`, (r) =>
      r.fulfill({ json: paymentFixture({ planCode: "premium" }) }),
    );
    await page.route(`${api}/subscriptions/downgrade-preview`, (r) =>
      r.fulfill({
        json: {
          planCode: target,
          previewToken: "b".repeat(64),
          storedFiles: limit + 5,
          fileLimit: limit,
          filesToKeep: limit,
          filesToRemove: 5,
          employees: 15,
          employeeLimit: target === "free" ? 0 : 10,
          employeesToRemove: target === "free" ? 15 : 5,
          pendingInvitations: 2,
          invitationsToRevoke: 2,
        },
      }),
    );
    let cleanups = 0;
    await page.route(`${api}/subscriptions/downgrade-cleanup`, (r) => {
      cleanups++;
      expect(r.request().postDataJSON()).toEqual({
        planCode: target,
        previewToken: "b".repeat(64),
      });
      return r.fulfill({ json: { planCode: target, pendingPlanCode: null } });
    });
    await page.goto("/dashboard/billing");
    await page
      .getByRole("button", {
        name: `Downgrade to ${target === "free" ? "Free" : "Basic"}`,
      })
      .click();
    await expect(
      page.getByText(
        `You have ${limit + 5} stored files. ${target === "free" ? "Free" : "Basic"} allows ${limit}.`,
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Choose what to remove" }),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: `test-results/${target}-cleanup-options-mobile.png`,
      animations: "disabled",
    });
    const options = page.getByRole("dialog", {
      name: `Prepare downgrade to ${target === "free" ? "Free" : "Basic"}`,
    });
    expect(
      await options.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page
      .getByRole("button", { name: "Review automatic cleanup" })
      .click();
    expect(cleanups).toBe(0);
    await expect(
      page.getByText(new RegExp(`keeping your ${limit} newest files`)),
    ).toBeVisible();
    await expect(
      page.getByText(/Buying a higher plan later will not restore them/),
    ).toBeVisible();
    await page.screenshot({
      path: `test-results/${target}-cleanup-desktop.png`,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: `test-results/${target}-cleanup-mobile.png`,
      animations: "disabled",
    });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(cleanups).toBe(0);
    await page
      .getByRole("button", {
        name: `Downgrade to ${target === "free" ? "Free" : "Basic"}`,
      })
      .click();
    await page
      .getByRole("button", { name: "Review automatic cleanup" })
      .click();
    await page
      .getByRole("button", { name: "Delete extras and downgrade", exact: true })
      .click();
    expect(cleanups).toBe(1);
  });
}

test("manual cleanup navigates to files without sending a destructive request", async ({
  page,
}) => {
  await fixture(page);
  await page.route(`${api}/payments/current`, (r) =>
    r.fulfill({ json: paymentFixture() }),
  );
  await page.route(`${api}/subscriptions/downgrade-preview`, (r) =>
    r.fulfill({
      json: {
        planCode: "free",
        previewToken: "b".repeat(64),
        storedFiles: 15,
        fileLimit: 10,
        filesToKeep: 10,
        filesToRemove: 5,
        employees: 1,
        employeeLimit: 0,
        employeesToRemove: 1,
        pendingInvitations: 0,
        invitationsToRevoke: 0,
      },
    }),
  );
  let cleanups = 0;
  await page.route(`${api}/subscriptions/downgrade-cleanup`, (r) => {
    cleanups++;
    return r.fulfill({ json: {} });
  });
  await page.goto("/dashboard/billing");
  await page.getByRole("button", { name: "Downgrade to Free" }).click();
  await page.getByRole("button", { name: "Choose what to remove" }).click();
  await expect(page).toHaveURL(/\/dashboard\/files$/);
  expect(cleanups).toBe(0);
});

test("payment returns verify state, do not trust success queries, and reconcile only on click", async ({
  page,
}) => {
  await fixture(page);
  let state = paymentFixture({
    stripeStatus: null,
    paymentAccess: "unmanaged",
  });
  let reconciles = 0;
  await page.route(`${api}/payments/current`, (r) =>
    r.fulfill({ json: state }),
  );
  await page.route(`${api}/payments/reconcile`, (r) => {
    reconciles++;
    state = paymentFixture({
      paymentAccess: "deferred",
      stripeStatus: "trialing",
    });
    return r.fulfill({ json: state });
  });
  await page.goto("/payments/success?session_id=test-only&paid=true");
  await expect(page).toHaveURL(/\/payments\/success$/);
  await expect(page.getByText(/Setup is not confirmed yet/)).toBeVisible();
  expect(reconciles).toBe(0);
  await page.getByRole("button", { name: "Synchronize with Stripe" }).click();
  await expect(
    page.getByRole("heading", { name: "Your billing is connected." }),
  ).toBeVisible();
  expect(reconciles).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: "test-results/payment-return-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.goto("/payments/cancel");
  await expect(
    page.getByRole("heading", { name: "Checkout was closed." }),
  ).toBeVisible();
  await page.goto("/payments/return");
  await expect(
    page.getByRole("heading", { name: "Back to your workspace." }),
  ).toBeVisible();
});
test("payment controls protect members and preserve a return route after login", async ({
  page,
}) => {
  await page.goto("/payments/success");
  await expect(page).toHaveURL(/\/login\?next=%2Fpayments%2Fsuccess/);
  await fixture(page);
  await page.route(`${api}/auth/sign-in`, (r) =>
    r.fulfill({ json: { accessToken: "test-session" } }),
  );
  await page
    .getByLabel("Work email", { exact: true })
    .fill("alex@example.test");
  await page.getByLabel("Password", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "Sign in to your workspace" }).click();
  await expect(page).toHaveURL(/\/payments\/success$/);
  await fixture(page, "member");
  let paymentReads = 0;
  await page.route(`${api}/payments/current`, (r) => {
    paymentReads++;
    return r.fulfill({ status: 403, json: {} });
  });
  await page.goto("/payments/return");
  await expect(
    page.getByRole("heading", { name: "Administrator access required" }),
  ).toBeVisible();
  await page.goto("/dashboard/billing");
  await expect(
    page.getByText("Your administrator manages this plan.").first(),
  ).toBeVisible();
  expect(paymentReads).toBe(0);
});
test("invoice links are restricted to Stripe and the portal uses its documented endpoint", async ({
  page,
}) => {
  await fixture(page);
  const invoice = {
    id: "in_fixture",
    status: "paid",
    currency: "usd",
    amountDueCents: 500,
    amountPaidCents: 500,
    totalCents: 500,
    createdAt: "2026-09-27T00:00:00Z",
    hostedInvoiceUrl: "https://invoice.stripe.com/i/test",
  };
  await page.route(`${api}/payments/current`, (r) =>
    r.fulfill({
      json: paymentFixture({
        invoices: [
          invoice,
          { ...invoice, id: "in_bad", hostedInvoiceUrl: "javascript:alert(1)" },
        ],
      }),
    }),
  );
  await page.route(`${api}/payments/portal`, (r) => {
    expect(r.request().postDataJSON()).toEqual({});
    return r.fulfill({
      json: { url: "https://billing.stripe.com/p/session/test_fixture" },
    });
  });
  await page.route("https://billing.stripe.com/**", (r) =>
    r.fulfill({ contentType: "text/html", body: "<h1>Portal fixture</h1>" }),
  );
  await page.goto("/dashboard/billing");
  await expect(page.getByRole("link", { name: "View invoice" })).toHaveCount(1);
  await expect(
    page.getByRole("link", { name: "View invoice" }),
  ).toHaveAttribute("href", invoice.hostedInvoiceUrl);
  await page.screenshot({
    path: "test-results/billing-stripe-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "Payment methods & invoices" })
    .click();
  await expect(page).toHaveURL(
    "https://billing.stripe.com/p/session/test_fixture",
  );
});
test("workspace animations follow request state and reduced motion", async ({
  page,
}) => {
  await fixture(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.route(`${api}/ai/conversations?**`, (route) =>
    route.fulfill({
      json: { conversations: [], total: 0, page: 1, limit: 20 },
    }),
  );
  let finishReply;
  const reply = new Promise((resolve) => {
    finishReply = resolve;
  });
  await page.route(`${api}/ai/chat`, async (route) => {
    await reply;
    await route.fulfill({ status: 503, json: { code: "ai_disabled" } });
  });
  await page.goto("/dashboard");
  await expect(page.locator(".overview-orbit")).toBeVisible();
  await expect(page.locator(".overview-orbit g")).toHaveCSS(
    "animation-name",
    "overview-drift",
  );
  await expect(page.locator(".usage-hero .progress > span")).toHaveCSS(
    "animation-iteration-count",
    "1",
  );
  await page.getByRole("button", { name: "Open AI chat", exact: true }).hover();
  await expect(page.locator(".robot-arm")).toHaveCSS(
    "animation-name",
    "robot-wave",
  );
  await page.getByRole("button", { name: "Open AI chat", exact: true }).click();
  await page.getByLabel("Message the assistant").fill("Check my usage");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  try {
    await expect(page.locator(".chat-transcript")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await expect(page.locator(".robot-antenna")).toHaveCSS(
      "animation-name",
      "robot-thinking",
    );
  } finally {
    finishReply();
  }
  await expect(page.locator(".chat-transcript")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expect(page.locator(".robot-antenna")).toHaveCSS(
    "animation-name",
    "none",
  );
  await page.getByRole("button", { name: "Close chat", exact: true }).click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".overview-orbit g")).toHaveCSS(
    "animation-iteration-count",
    "1",
  );
  await page.screenshot({
    path: "test-results/overview-motion.png",
    fullPage: true,
    animations: "disabled",
  });
});
const api = "http://localhost:3000/backend";
const owner = {
  _id: "aaaaaaaaaaaaaaaaaaaaaaaa",
  fullName: "Alex Morgan",
  email: "alex@example.test",
  role: "company_owner",
  companyId: "cccccccccccccccccccccccc",
  createdAt: "2026-09-01T00:00:00Z",
};
const member = {
  ...owner,
  _id: "bbbbbbbbbbbbbbbbbbbbbbbb",
  role: "company_member",
  fullName: "Sam Lee",
  email: "sam@example.test",
};
const plans = [
  {
    code: "free",
    name: "Free",
    includedFilesPerMonth: 10,
    maxEmployees: 0,
    basePriceCents: 0,
    employeePriceCents: 0,
    extraFilePriceCents: null,
    currency: "USD",
    interval: "month",
  },
  {
    code: "basic",
    name: "Basic",
    includedFilesPerMonth: 100,
    maxEmployees: 10,
    basePriceCents: 0,
    employeePriceCents: 500,
    extraFilePriceCents: null,
    currency: "USD",
    interval: "month",
  },
  {
    code: "premium",
    name: "Premium",
    includedFilesPerMonth: 1000,
    maxEmployees: null,
    basePriceCents: 30000,
    employeePriceCents: 0,
    extraFilePriceCents: 50,
    currency: "USD",
    interval: "month",
  },
];
const billing = {
  plan: plans[1],
  billingPeriod: {
    startsAt: "2026-09-01T00:00:00Z",
    endsAt: "2026-10-01T00:00:00Z",
  },
  successfulUploads: 38,
  includedUploadAllowance: 100,
  employeeCount: 1,
  billableEmployeeCount: 1,
  employeeUnitPriceCents: 500,
  employeeChargeCents: 500,
  baseAmountCents: 0,
  overageChargeCents: 0,
  billableOverageUploads: 0,
  overageUnitPriceCents: 50,
  totalAmountCents: 500,
};
const files = [
  {
    id: "dddddddddddddddddddddddd",
    uploaderId: owner._id,
    originalFilename: "Quarterly revenue.xlsx",
    fileType: "xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: 23000,
    visibility: "company_wide",
    restrictedUserIds: [],
    createdAt: "2026-09-24T09:00:00Z",
    updatedAt: "2026-09-24T09:00:00Z",
  },
  {
    id: "eeeeeeeeeeeeeeeeeeeeeeee",
    uploaderId: member._id,
    originalFilename: "Operations.csv",
    fileType: "csv",
    size: 1200,
    visibility: "restricted",
    restrictedUserIds: [member._id],
    createdAt: "2026-09-23T09:00:00Z",
    updatedAt: "2026-09-23T09:00:00Z",
  },
];
// Fixtures exist only in automated tests. The application always uses the real API.
async function fixture(page, role = "owner", signedIn = true) {
  if (signedIn)
    await page.addInitScript(() =>
      sessionStorage.setItem("datavault.session", "test-only-session"),
    );
  await page.route(`${api}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname.replace(
      /^\/backend/,
      "",
    );
    if (path === "/payments/current") {
      await route.fulfill({
        status: 503,
        json: { message: "Test Mode payments are not configured" },
      });
      return;
    }
    if (path === "/subscriptions/downgrade-preview") {
      const code = route.request().postDataJSON().planCode;
      const plan = plans.find((plan) => plan.code === code);
      await route.fulfill({
        json: {
          planCode: code,
          previewToken: "a".repeat(64),
          storedFiles: 2,
          fileLimit: plan.includedFilesPerMonth,
          filesToRemove: 0,
          filesToKeep: 2,
          employees: 0,
          employeeLimit: plan.maxEmployees,
          employeesToRemove: 0,
          pendingInvitations: 0,
          invitationsToRevoke: 0,
        },
      });
      return;
    }
    const bodies = {
      "/ai/conversations": { conversations: [], total: 0, page: 1, limit: 20 },
      "/auth/current-user": role === "owner" ? owner : member,
      "/companies/current": {
        name: "Northstar Studio",
        country: "GE",
        industry: "Technology",
        createdAt: owner.createdAt,
      },
      "/subscriptions/current": {
        plan: plans[1],
        billingPeriod: { ...billing.billingPeriod, uploadedFiles: 38 },
        employeeCount: 1,
        monthlyPriceEstimateCents: 500,
        billingSummary: billing,
      },
      "/subscriptions/current/billing": billing,
      "/plans": plans,
      "/statistics/current": {
        subscription: { planName: "Basic" },
        employees: { accepted: 1, pendingInvitations: 1 },
        files: {
          currentlyStored: { total: 2, restricted: 1, companyWide: 1 },
          currentBillingPeriod: {
            ...billing.billingPeriod,
            successfulUploads: 38,
            includedAllowance: 100,
            remainingIncludedUploads: 62,
          },
        },
        billing: { totalAmountCents: 500 },
      },
      "/files": { files, total: 2, page: 1, take: 30 },
      "/users": { users: [owner, member], total: 2, page: 1, take: 30 },
      "/invitations": { invitations: [], total: 0, page: 1, take: 30 },
      [`/files/${files[0].id}`]: files[0],
      [`/files/${files[1].id}`]: files[1],
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(bodies[path] || { message: "Updated" }),
    });
  });
}
test("owner views and updates an employee through the user detail API", async ({
  page,
}) => {
  await fixture(page);
  let employee = { ...member },
    updatedBody,
    detailReads = 0;
  await page.route(`${api}/users?**`, (route) =>
    route.fulfill({
      json: { users: [owner, employee], total: 2, page: 1, take: 30 },
    }),
  );
  await page.route(`${api}/users/${member._id}`, (route) => {
    if (route.request().method() === "PATCH") {
      updatedBody = route.request().postDataJSON();
      employee = { ...employee, ...updatedBody };
    } else detailReads++;
    return route.fulfill({ json: employee });
  });
  await page.goto("/dashboard/employees");
  await page.getByRole("button", { name: `Edit ${member.email}` }).click();
  const dialog = page.getByRole("dialog", { name: "Employee details" });
  await expect(dialog).toContainText(member.email);
  await expect(dialog.getByLabel("Full name")).toHaveValue("Sam Lee");
  expect(detailReads).toBeGreaterThan(0);
  await page.screenshot({
    path: "test-results/employee-detail-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await dialog.getByLabel("Full name").fill("Sam Rivera");
  await dialog.getByRole("button", { name: "Save name" }).click();
  expect(updatedBody).toEqual({ fullName: "Sam Rivera" });
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Sam Rivera", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: `Edit ${member.email}` }).click();
  await expect(dialog).toBeVisible();
  await page.screenshot({
    path: "test-results/employee-detail-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  const bounds = await dialog.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
});
test("file upload sends the chosen CSV and restricted employee access", async ({
  page,
}) => {
  await fixture(page);
  let uploadRequest;
  await page.route(`${api}/files`, (route) => {
    uploadRequest = route.request();
    return route.fulfill({ status: 201, json: files[0] });
  });
  await page.goto("/dashboard/files");
  await page
    .getByRole("button", { name: "Upload file", exact: true })
    .first()
    .click();
  await page.getByLabel("Choose files").setInputFiles({
    name: "upload-proof.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("column\nsynthetic\n"),
  });
  await page.getByRole("radio", { name: /Selected employees only/ }).check();
  await page.getByRole("checkbox", { name: /Sam Lee/ }).check();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Upload file" })
    .click();
  await expect(page.getByText("File added to your vault")).toBeVisible();
  expect(uploadRequest.method()).toBe("POST");
  expect(uploadRequest.headers().authorization).toBe(
    "Bearer test-only-session",
  );
  expect(uploadRequest.headers()["content-type"]).toContain(
    "multipart/form-data",
  );
  const payload = uploadRequest.postData();
  expect(payload).toContain('filename="upload-proof.csv"');
  expect(payload).toContain('name="visibility"');
  expect(payload).toContain("restricted");
  expect(payload).toContain(JSON.stringify([member._id]));
});

const batchFiles = (count) =>
  Array.from({ length: count }, (_, index) => ({
    name: `batch-${index + 1}.csv`,
    mimeType: "text/csv",
    buffer: Buffer.from(`id,value\n${index + 1},synthetic\n`),
  }));

test("multiple selected files upload separately with the same permissions", async ({
  page,
}) => {
  await fixture(page);
  const requests = [];
  await page.route(`${api}/files`, (route) => {
    requests.push(route.request().postData());
    return route.fulfill({ status: 201, json: files[0] });
  });
  await page.goto("/dashboard/files");
  await page
    .getByRole("button", { name: "Upload file", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "Add files to your vault" });
  await page.getByLabel("Choose files").setInputFiles(batchFiles(3));
  await expect(
    dialog.getByRole("button", { name: "Upload 3 files" }),
  ).toBeEnabled();
  await page.getByRole("radio", { name: /Selected employees only/ }).check();
  await page.getByRole("checkbox", { name: /Sam Lee/ }).check();
  await page.screenshot({
    path: "test-results/batch-upload-desktop.png",
    animations: "disabled",
  });
  await dialog.getByRole("button", { name: "Upload 3 files" }).click();
  await expect(page.getByText("3 files added to your vault")).toBeVisible();
  expect(requests).toHaveLength(3);
  requests.forEach((body, index) => {
    expect(body).toContain(`filename="batch-${index + 1}.csv"`);
    expect(body).toContain("restricted");
    expect(body).toContain(JSON.stringify([member._id]));
    expect(body.match(/filename=/g)).toHaveLength(1);
  });
});

test("Free rejects an oversized selection before sending any file", async ({
  page,
}) => {
  await fixture(page);
  await page.route(`${api}/subscriptions/current`, (route) =>
    route.fulfill({
      json: {
        plan: plans[0],
        storedFiles: 0,
        billingPeriod: billing.billingPeriod,
      },
    }),
  );
  let uploads = 0;
  await page.route(`${api}/files`, (route) => {
    uploads++;
    return route.fulfill({ status: 201, json: files[0] });
  });
  await page.goto("/dashboard/files");
  await page
    .getByRole("button", { name: "Upload file", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "Add files to your vault" });
  await page.getByLabel("Choose files").setInputFiles(batchFiles(11));
  await expect(dialog).toContainText("Only 10 more files fit");
  await expect(
    dialog.getByRole("button", { name: "Upload files" }),
  ).toBeDisabled();
  expect(uploads).toBe(0);
  await page.getByLabel("Choose files").setInputFiles(batchFiles(10));
  await expect(
    dialog.getByRole("button", { name: "Upload 10 files" }),
  ).toBeEnabled();
  await page.getByLabel("Choose files").setInputFiles(batchFiles(1));
  await expect(dialog).toContainText("Only 0 more files fit");
  await expect(dialog.getByRole("listitem")).toHaveCount(10);
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await dialog.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  const submit = dialog.getByRole("button", { name: "Upload 10 files" });
  await submit.scrollIntoViewIfNeeded();
  const submitBounds = await submit.boundingBox();
  expect(submitBounds.y).toBeGreaterThanOrEqual(0);
  expect(submitBounds.y + submitBounds.height).toBeLessThanOrEqual(844);
  await page.screenshot({
    path: "test-results/batch-upload-mobile.png",
    animations: "disabled",
  });
});

test("batch upload rechecks changed capacity before the first request", async ({
  page,
}) => {
  await fixture(page);
  let reads = 0,
    uploads = 0;
  await page.route(`${api}/subscriptions/current`, (route) =>
    route.fulfill({
      json: {
        plan: plans[0],
        storedFiles: ++reads === 1 ? 7 : 9,
        billingPeriod: billing.billingPeriod,
      },
    }),
  );
  await page.route(`${api}/files`, (route) => {
    uploads++;
    return route.fulfill({ status: 201, json: files[0] });
  });
  await page.goto("/dashboard/files");
  await page
    .getByRole("button", { name: "Upload file", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "Add files to your vault" });
  await page.getByLabel("Choose files").setInputFiles(batchFiles(3));
  await dialog.getByRole("button", { name: "Upload 3 files" }).click();
  await expect(dialog).toContainText("available file slots changed");
  expect(uploads).toBe(0);
});

test("partial batch failure preserves results and retries only unfinished files", async ({
  page,
}) => {
  await fixture(page);
  const attempts = [];
  await page.route(`${api}/files`, (route) => {
    attempts.push(route.request().postData());
    return route.fulfill(
      attempts.length === 2
        ? { status: 503, json: { message: "Private storage failure" } }
        : { status: 201, json: files[0] },
    );
  });
  await page.goto("/dashboard/files");
  await page
    .getByRole("button", { name: "Upload file", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "Add files to your vault" });
  await page.getByLabel("Choose files").setInputFiles(batchFiles(3));
  await dialog.getByRole("button", { name: "Upload 3 files" }).click();
  await expect(dialog).toContainText(
    "1 file was uploaded; 1 file needs attention",
  );
  await expect(dialog).toContainText("File storage is temporarily unavailable");
  expect(attempts).toHaveLength(2);
  await dialog.getByRole("button", { name: "Upload 2 files" }).click();
  await expect(page.getByText("2 files added to your vault")).toBeVisible();
  expect(attempts).toHaveLength(4);
  expect(attempts[2]).toContain('filename="batch-2.csv"');
  expect(attempts[3]).toContain('filename="batch-3.csv"');
});

for (const [index, limit] of [
  [0, 10],
  [1, 100],
  [2, 1000],
]) {
  test(`${plans[index].name} allows a replacement upload despite historical uploads`, async ({
    page,
  }) => {
    await fixture(page);
    await page.route(`${api}/subscriptions/current`, (route) =>
      route.fulfill({
        json: {
          plan: plans[index],
          storedFiles: limit - 1,
          billingPeriod: { ...billing.billingPeriod, uploadedFiles: limit },
        },
      }),
    );
    await page.goto("/dashboard/files");
    await expect(page.locator(".sidebar-plan")).toContainText(
      `${limit - 1} / ${limit} files stored`,
    );
    await page
      .getByRole("button", { name: "Upload file", exact: true })
      .first()
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Add files to your vault",
    });
    await expect(dialog).toContainText(
      `${limit - 1} / ${limit} files stored. Deleting a file frees a slot.`,
    );
    await expect(
      dialog.getByText("Your vault is full.", { exact: false }),
    ).toHaveCount(0);
    await page.getByLabel("Choose files").setInputFiles({
      name: "replacement.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("a,b\n1,2"),
    });
    await expect(
      dialog.getByRole("button", { name: "Upload file", exact: true }),
    ).toBeEnabled();
    await page.screenshot({
      path: `test-results/${plans[index].code}-file-slot-desktop.png`,
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      dialog.getByRole("button", { name: "Upload file", exact: true }),
    ).toBeEnabled();
    await page.screenshot({
      path: `test-results/${plans[index].code}-file-slot-mobile.png`,
      fullPage: true,
      animations: "disabled",
    });
  });
}

test("an unavailable storage provider keeps the upload dialog open with a clear retry path", async ({
  page,
}) => {
  await fixture(page);
  await page.route(`${api}/files`, (route) =>
    route.fulfill({
      status: 503,
      json: { message: "Private provider detail" },
    }),
  );
  await page.goto("/dashboard/files");
  await page
    .getByRole("button", { name: "Upload file", exact: true })
    .first()
    .click();
  await page.getByLabel("Choose files").setInputFiles({
    name: "upload-proof.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("column\nsynthetic\n"),
  });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Upload file" })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "File storage is temporarily unavailable",
  );
  await expect(page.getByText("Private provider detail")).toHaveCount(0);
});
test("redesigned directories and forms remain within desktop and mobile viewports", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/login");
  await expect(
    page.getByRole("heading", { name: "Welcome back." }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign in to your workspace" }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/redesign-login.png",
    fullPage: true,
    animations: "disabled",
  });
  await fixture(page);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [route, heading] of [
      ["", "The big picture."],
      ["/files", "The file vault"],
      ["/employees", "Your people"],
      ["/billing", "Room to grow."],
      ["/settings", "Workspace settings"],
    ]) {
      await page.goto(`/dashboard${route}`);
      await expect(
        page.getByRole("heading", { name: heading, exact: true }),
      ).toBeVisible();
      await expect(page.locator(".loading-state")).toHaveCount(0);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        `${route} at ${width}px`,
      ).toBeTruthy();
      await page.screenshot({
        path: `test-results/redesign-${route.slice(1) || "overview"}-${width}.png`,
        fullPage: true,
        animations: "disabled",
      });
    }
  }
});
test("unauthenticated routes redirect and registration renders without overflow", async ({
  page,
}) => {
  await page.goto("/dashboard/files");
  await expect(page).toHaveURL(/\/login/);
  await expect(
    page.getByRole("button", { name: "Sign in to your workspace" }),
  ).toBeVisible();
  const loginHeadline = await page.locator(".story-body h1").boundingBox();
  await page.goto("/register");
  await expect(
    page.getByRole("heading", { name: "A home for your data." }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create your workspace", exact: true }),
  ).toBeVisible();
  const signupHeadline = await page.locator(".story-body h1").boundingBox();
  expect(Math.abs(signupHeadline.y - loginHeadline.y)).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: "test-results/register-mobile.png",
    fullPage: true,
  });
});
test("owner workspace uses real response shape, filters files, and saves permissions", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/dashboard");
  await expect(
    page.getByRole("heading", { name: "The big picture." }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/overview-desktop.png",
    animations: "disabled",
    fullPage: true,
  });
  await page.goto("/dashboard/files");
  await page.getByRole("combobox", { name: "File type" }).selectOption("csv");
  await expect(
    page.getByRole("button", { name: "View Operations.csv" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Quarterly revenue.xlsx/ }),
  ).toHaveCount(0);
  await page.getByRole("combobox", { name: "File type" }).selectOption("");
  await page
    .getByRole("button", { name: "View Quarterly revenue.xlsx" })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("radio", { name: /Selected employees only/ }).check();
  await page.getByRole("checkbox", { name: /Sam Lee/ }).check();
  const save = page.waitForRequest(
    (r) => r.method() === "PATCH" && r.url().endsWith("/permissions"),
  );
  await page.getByRole("button", { name: "Save access" }).click();
  expect((await save).postDataJSON()).toEqual({
    visibility: "restricted",
    restrictedUserIds: [member._id],
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
test("member cannot access employee controls; backend forbidden stays friendly", async ({
  page,
}) => {
  await fixture(page, "member");
  await page.goto("/dashboard/employees");
  await expect(
    page.getByRole("heading", { name: "Administrator access required" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Employees", exact: true }),
  ).toHaveCount(0);
  await page.route(`${api}/files?**`, (route) =>
    route.fulfill({
      status: 403,
      json: { message: "Internal forbidden detail" },
    }),
  );
  await page.goto("/dashboard/files");
  await expect(page.getByText(/You don’t have permission/)).toBeVisible();
  await expect(page.getByText("Internal forbidden detail")).toHaveCount(0);
});
test("expired sessions return to login; activation token is removed from history", async ({
  page,
}) => {
  await fixture(page);
  await page.route(`${api}/auth/current-user`, (route) =>
    route.fulfill({ status: 401, json: {} }),
  );
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/activate?token=" + "a".repeat(43));
  await expect(page).toHaveURL(/\/activate$/);
  await page.route(`${api}/auth/verify-account`, (route) =>
    route.fulfill({ status: 400, json: {} }),
  );
  await page.getByRole("button", { name: "Activate account" }).click();
  await expect(
    page.getByText(/invalid, expired, or has already been used/),
  ).toBeVisible();
});
test("mobile navigation and billing fit viewport", async ({ page }) => {
  await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("link", { name: "Billing", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Room to grow." }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: "test-results/billing-mobile.png",
    animations: "disabled",
    fullPage: true,
  });
});

test("AI conversations persist, continue and delete through documented endpoints", async ({
  page,
}) => {
  await fixture(page);
  const id = "ffffffffffffffffffffffff";
  const conversation = {
    id,
    title: "Usage question",
    messageCount: 2,
    createdAt: "2026-09-26T10:00:00Z",
    updatedAt: "2026-09-26T10:00:00Z",
  };
  let saved = false,
    deleted = false;
  let messages = [
    {
      id: "111111111111111111111111",
      role: "user",
      content: "What is our plan?",
    },
    {
      id: "222222222222222222222222",
      role: "assistant",
      content: "Your company is on the Basic plan.",
    },
  ];
  await page.route(`${api}/ai/conversations?**`, (route) =>
    route.fulfill({
      json: {
        conversations: saved && !deleted ? [conversation] : [],
        total: saved && !deleted ? 1 : 0,
        page: 1,
        limit: 20,
      },
    }),
  );
  await page.route(`${api}/ai/conversations/${id}`, (route) => {
    if (route.request().method() === "DELETE") {
      deleted = true;
      return route.fulfill({ json: { message: "Conversation deleted" } });
    }
    return route.fulfill({ json: { conversation, messages } });
  });
  await page.route(`${api}/ai/chat`, (route) => {
    saved = true;
    return route.fulfill({
      json: {
        requestId: "test",
        conversation,
        messages,
        usage: { totalTokens: 20 },
      },
    });
  });
  await page.goto("/dashboard/assistant");
  const composer = page.getByLabel("Message the assistant");
  await composer.fill("What is our plan?");
  await composer.press("Shift+Enter");
  await expect(composer).toHaveValue("What is our plan?\n");
  await composer.press("Backspace");
  const first = page.waitForRequest(
    (r) => r.url().endsWith("/ai/chat") && r.method() === "POST",
  );
  await composer.press("Enter");
  expect((await first).postDataJSON()).toEqual({
    message: "What is our plan?",
  });
  await expect(
    page.getByText("Your company is on the Basic plan.", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Message the assistant").fill("What about limits?");
  const followup = page.waitForRequest(
    (r) => r.url().endsWith("/ai/chat") && r.method() === "POST",
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  expect((await followup).postDataJSON()).toEqual({
    conversationId: id,
    message: "What about limits?",
  });
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page
    .getByRole("button", { name: "Delete conversation: Usage question" })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(
    page.getByText("Conversation deleted", { exact: true }),
  ).toBeVisible();
});

test("AI disabled state keeps the draft and mobile chat fits the viewport", async ({
  page,
}) => {
  await fixture(page, "member");
  await page.route(`${api}/ai/conversations?**`, (route) =>
    route.fulfill({
      json: { conversations: [], total: 0, page: 1, limit: 20 },
    }),
  );
  await page.route(`${api}/ai/chat`, (route) =>
    route.fulfill({
      status: 503,
      json: { code: "ai_disabled", message: "AI assistant is not configured" },
    }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dashboard/assistant");
  await page
    .getByLabel("Message the assistant")
    .fill("How much usage is left?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByText("The AI assistant is not enabled on the server yet.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByLabel("Message the assistant")).toHaveValue(
    "How much usage is left?",
  );
  await expect(page.getByLabel("Message the assistant")).toBeDisabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
});

test("floating chat opens from login and preserves a draft across workspace navigation", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Open AI chat", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "A little help, right here." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close chat", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Open AI chat", exact: true }),
  ).toBeFocused();
  await fixture(page);
  await page.route(`${api}/ai/conversations?**`, (r) =>
    r.fulfill({ json: { conversations: [], total: 0, page: 1, limit: 20 } }),
  );
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Open AI chat", exact: true }).click();
  await page.getByLabel("Message the assistant").fill("Keep this draft for me");
  await page.getByRole("button", { name: "Close chat", exact: true }).click();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Open AI chat", exact: true }).click();
  await expect(page.getByLabel("Message the assistant")).toHaveValue(
    "Keep this draft for me",
  );
  await page.screenshot({
    path: "test-results/floating-chat-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/floating-chat-mobile.png",
    fullPage: true,
  });
  const panel = await page
    .getByRole("dialog", { name: "DataVault chat", exact: true })
    .boundingBox();
  expect(panel.x).toBeGreaterThanOrEqual(0);
  expect(panel.x + panel.width).toBeLessThanOrEqual(390);
  expect(panel.y).toBeGreaterThanOrEqual(0);
  expect(panel.y + panel.height).toBeLessThanOrEqual(844);
});
