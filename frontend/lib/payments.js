import { request } from "./api";

export const paymentReturnPaths = [
  "/payments/success",
  "/payments/cancel",
  "/payments/return",
];
export const planName = (code) =>
  ({ free: "Free", basic: "Basic", premium: "Premium" })[code] || "your plan";
export const hasStripeSubscription = (state) =>
  !!state?.stripeStatus &&
  !["canceled", "incomplete_expired"].includes(state.stripeStatus);
export const paymentStatus = (state) =>
  ({
    incomplete: "Setup incomplete",
    incomplete_expired: "Setup expired",
    trialing: "First billing period",
    active: "Active",
    past_due: "Payment overdue",
    canceled: "Canceled",
    unpaid: "Unpaid",
    paused: "Paused",
  })[state?.stripeStatus] || "Not connected";

export async function getPaymentState(signal) {
  const state = await request("/payments/current", { signal });
  if (
    state?.mode !== "test" ||
    !Array.isArray(state.invoices) ||
    !state.synchronization
  ) {
    throw new Error(
      "We couldn’t verify the payment configuration. Please refresh or contact your workspace administrator.",
    );
  }
  return state;
}

// Only follow hosted Stripe links returned by the API, never return-URL query strings.
export function stripeUrl(value, kind) {
  const hosts = {
    checkout: "checkout.stripe.com",
    portal: "billing.stripe.com",
    invoice: "invoice.stripe.com",
  };
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === hosts[kind] &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === "443")
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export async function openStripe(kind, planCode) {
  const result = await request(`/payments/${kind}`, {
    method: "POST",
    body: kind === "checkout" ? { planCode } : {},
  });
  const url = stripeUrl(result.url, kind);
  if (
    !url ||
    (kind === "checkout" &&
      (result.mode !== "setup" || result.paymentCollected !== false))
  ) {
    throw new Error(
      "Stripe did not return a valid setup link. Refresh payment status before trying again.",
    );
  }
  window.location.assign(url);
}
