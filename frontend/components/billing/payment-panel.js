"use client";
import { useState } from "react";
import { ArrowUpRight, CreditCard, RefreshCw } from "lucide-react";
import { request } from "@/lib/api";
import { openStripe, paymentStatus, planName, stripeUrl } from "@/lib/payments";
import { date } from "@/lib/utils";
import { Alert, Badge, Button, ErrorState, Loading } from "@/components/ui";

const accessLabels = {
  unmanaged: "No Stripe billing",
  deferred: "First payment deferred",
  active: "Billing access active",
  suspended: "Billing access suspended",
};
const syncMessages = {
  retry_required:
    "A billing update is waiting to sync. You can request synchronization below.",
  reconciliation_required:
    "Billing needs reconciliation. Synchronize once; if this remains, contact your administrator.",
  plan_conflict:
    "The queued plan conflicts with your workspace. Review employees and pending invitations before changing plans.",
};
function invoiceMoney(cents, currency) {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(cents / 100);
  } catch {
    return "—";
  }
}
export default function PaymentPanel({
  resource,
  onChanged,
  showInvoices = true,
}) {
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(null);
  async function act(kind) {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      if (kind === "portal") await openStripe("portal");
      else {
        await request("/payments/reconcile", { method: "POST", body: {} });
        resource.reload();
        onChanged?.();
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy("");
    }
  }
  if (resource.loading)
    return <Loading label="Checking payment availability" />;
  if (resource.error?.code === "payments_disabled")
    return (
      <section className="payment-section">
        <span className="eyebrow">PAYMENTS</span>
        <h2>Stripe isn’t connected yet.</h2>
        <p>
          Hosted setup, payment methods, and invoices will appear when online
          payments are available. Your usage estimates are still available.
        </p>
        <Button variant="secondary" onClick={resource.reload}>
          Check availability
        </Button>
      </section>
    );
  if (resource.error)
    return <ErrorState error={resource.error} retry={resource.reload} />;
  const state = resource.data;
  if (!state) return null;
  return (
    <section className="payment-section" aria-label="Payment management">
      <div className="payment-heading">
        <div>
          <span className="eyebrow">PAYMENTS & INVOICES</span>
          <h2>Your payment details.</h2>
        </div>
        {state.mode === "test" && <Badge tone="amber">No real charges</Badge>}
      </div>
      <dl className="payment-facts">
        <div>
          <dt>Stripe subscription</dt>
          <dd>{paymentStatus(state)}</dd>
        </div>
        <div>
          <dt>Payment access</dt>
          <dd>{accessLabels[state.paymentAccess] || "Status unavailable"}</dd>
        </div>
        <div>
          <dt>Last synchronized</dt>
          <dd>{date(state.synchronization.lastSyncedAt)}</dd>
        </div>
      </dl>
      {state.pendingPlanCode && (
        <Alert type="info">
          Change to {planName(state.pendingPlanCode)} requested
          {state.pendingPlanAt ? ` for ${date(state.pendingPlanAt)}` : ""}. The
          current plan remains in effect until the backend confirms the change.
        </Alert>
      )}
      {state.cancelAtPeriodEnd && (
        <Alert type="info">
          Cancellation is scheduled for {date(state.billingPeriod.endsAt)}.
          Choose your current plan below to keep it.
        </Alert>
      )}
      {state.paymentAccess === "suspended" && (
        <Alert>
          Payment access is suspended. Review your payment method and invoices
          in Stripe, then synchronize the status.
        </Alert>
      )}
      {syncMessages[state.synchronization.issue] && (
        <Alert type="info">{syncMessages[state.synchronization.issue]}</Alert>
      )}
      {state.synchronization.pendingUsage > 0 && (
        <p className="small muted">
          {state.synchronization.pendingUsage} usage records are waiting to
          reach Stripe. Invoice totals may not yet reflect them.
        </p>
      )}
      <Alert>{error?.message}</Alert>
      <div className="payment-actions">
        <Button
          variant="secondary"
          busy={busy === "portal"}
          disabled={!!busy}
          onClick={() => act("portal")}
        >
          <CreditCard size={16} />
          Payment methods & invoices
          <ArrowUpRight size={15} />
        </Button>
        <Button
          variant="secondary"
          busy={busy === "reconcile"}
          disabled={!!busy}
          onClick={() => act("reconcile")}
        >
          <RefreshCw size={15} />
          Synchronize with Stripe
        </Button>
        <Button variant="secondary" disabled={!!busy} onClick={resource.reload}>
          Refresh status
        </Button>
      </div>
      <p className="small muted">
        Card details stay in Stripe. Checkout saves a payment method; it does
        not collect a payment immediately.
      </p>
      {showInvoices && (
        <div className="invoice-section">
          <h3>Recent invoices</h3>
          {!state.invoices.length ? (
            <div className="invoice-empty">
              <strong>No invoices yet</strong>
              <p>
                Stripe invoices will appear here when they are issued. Usage
                estimates are separate from Stripe invoices.
              </p>
            </div>
          ) : (
            <div className="table-scroll">
              <table className="invoice-table">
                <caption className="sr-only">
                  Latest ten Stripe invoices
                </caption>
                <thead>
                  <tr>
                    <th>Issued</th>
                    <th>Status</th>
                    <th>Total</th>
                    <th>Amount due</th>
                    <th>Paid</th>
                    <th>
                      <span className="sr-only">View invoice</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {state.invoices.map((invoice) => {
                    const url = stripeUrl(invoice.hostedInvoiceUrl, "invoice");
                    return (
                      <tr key={invoice.id}>
                        <td>{date(invoice.createdAt)}</td>
                        <td>
                          <Badge>
                            {{
                              draft: "Draft",
                              open: "Open",
                              paid: "Paid",
                              void: "Void",
                              uncollectible: "Uncollectible",
                            }[invoice.status] || "Unavailable"}
                          </Badge>
                        </td>
                        <td>
                          {invoiceMoney(invoice.totalCents, invoice.currency)}
                        </td>
                        <td>
                          {invoiceMoney(
                            invoice.amountDueCents,
                            invoice.currency,
                          )}
                        </td>
                        <td>
                          {invoiceMoney(
                            invoice.amountPaidCents,
                            invoice.currency,
                          )}
                        </td>
                        <td>
                          {url ? (
                            <a
                              className="text-link"
                              href={url}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              View invoice <ArrowUpRight size={14} />
                            </a>
                          ) : (
                            <span className="muted small">Not available</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
