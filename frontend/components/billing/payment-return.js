"use client";
import Link from "next/link";
import { useEffect } from "react";
import { ArrowRight } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useResource } from "@/lib/hooks";
import { getPaymentState, planName } from "@/lib/payments";
import { Alert, Empty, PageHeading } from "@/components/ui";
import { useWorkspace } from "@/components/layout/shell";
import PaymentPanel from "./payment-panel";

export default function PaymentReturn({ kind }) {
  const { isAdmin } = useAuth();
  useEffect(() => {
    // Checkout status is verified using the tenant API, never a query parameter.
    window.history.replaceState(null, "", window.location.pathname);
  }, []);
  return isAdmin ? (
    <OwnerReturn kind={kind} />
  ) : (
    <Empty
      title="Administrator access required"
      description="Only your workspace administrator can manage Stripe billing."
    />
  );
}
function OwnerReturn({ kind }) {
  const workspace = useWorkspace();
  const payment = useResource((signal) => getPaymentState(signal), []);
  const connected =
    payment.data &&
    ["active", "deferred"].includes(payment.data.paymentAccess) &&
    ["active", "trialing"].includes(payment.data.stripeStatus);
  const title =
    kind === "cancel"
      ? "Checkout was closed."
      : kind === "return"
        ? "Back to your workspace."
        : connected
          ? "Your billing is connected."
          : "Let’s check your setup.";
  return (
    <>
      <PageHeading
        eyebrow="WORKSPACE / BILLING"
        title={title}
        description={
          kind === "cancel"
            ? "Closing Checkout does not cancel an existing subscription. Review your current status below."
            : "This page reads your subscription from DataVault. A Stripe redirect alone does not confirm a payment or plan change."
        }
        action={
          <Link href="/dashboard/billing" className="button">
            Back to billing <ArrowRight size={16} />
          </Link>
        }
      />
      {kind === "success" && payment.data && (
        <Alert type={connected ? "success" : "info"}>
          {connected
            ? `${planName(payment.data.planCode)} billing is connected. This confirms your subscription status, not a payment receipt. No real charges are currently made.`
            : "Setup is not confirmed yet. Stripe may still be updating your subscription. Refresh the status or synchronize once below before starting another Checkout."}
        </Alert>
      )}
      <PaymentPanel resource={payment} onChanged={workspace.reload} />
    </>
  );
}
