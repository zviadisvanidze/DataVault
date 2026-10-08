"use client";
import { useState } from "react";
import { ArrowRight, Check, CreditCard, Layers3 } from "lucide-react";
import { request } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useResource } from "@/lib/hooks";
import { date, fileUsage, money } from "@/lib/utils";
import {
  Alert,
  Badge,
  Button,
  Confirm,
  ErrorState,
  Loading,
  Modal,
  PageHeading,
  Progress,
  useToast,
} from "@/components/ui";
import { useWorkspace } from "@/components/layout/shell";
import PaymentPanel from "@/components/billing/payment-panel";
import {
  getPaymentState,
  hasStripeSubscription,
  openStripe,
  planName,
} from "@/lib/payments";
export default function Billing() {
  const { isAdmin } = useAuth(),
    workspace = useWorkspace(),
    toast = useToast();
  const billing = useResource(
      (signal) => request("/subscriptions/current/billing", { signal }),
      [],
    ),
    plans = useResource(
      (signal) => request("/plans", { signal, public: true }),
      [],
    );
  const [preview, setPreview] = useState(null);
  const [automatic, setAutomatic] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [chosen, setChosen] = useState(null),
    b = billing.data;
  const payments = useResource(
    (signal) => (isAdmin ? getPaymentState(signal) : Promise.resolve(null)),
    [isAdmin],
  );
  const assignmentMode = payments.error?.code === "payments_disabled";
  const stripeReady = payments.data?.mode === "test";
  const managed = hasStripeSubscription(payments.data);
  const pending = payments.data?.pendingPlanCode;
  const setup = chosen && stripeReady && !managed && chosen.code !== "free";
  function reloadBilling() {
    billing.reload();
    workspace.reload();
  }
  const rank = { free: 0, basic: 1, premium: 2 };
  const usedFiles = fileUsage(workspace.subscription);
  const needsCleanup =
    preview &&
    (preview.filesToRemove > 0 ||
      preview.employeesToRemove > 0 ||
      preview.invitationsToRevoke > 0);
  function closeChange() {
    setChosen(null);
    setPreview(null);
    setAutomatic(false);
  }
  async function choosePlan(plan) {
    setPreviewLoading(true);
    try {
      const downgrade = rank[plan.code] < rank[b?.plan.code];
      const result = downgrade
        ? await request("/subscriptions/downgrade-preview", {
            method: "POST",
            body: { planCode: plan.code },
          })
        : null;
      setPreview(result);
      setAutomatic(false);
      setChosen(plan);
    } catch (error) {
      toast(error.message);
    } finally {
      setPreviewLoading(false);
    }
  }

  return (
    <>
      <PageHeading
        eyebrow="WORKSPACE / BILLING"
        title="Room to grow."
        description="Your plan, your usage, and exactly what it adds up to."
      />
      {!stripeReady && (
        <Alert type="info">
          {assignmentMode
            ? "Online payments are not available yet. Plan changes here update your workspace without collecting payment. Amounts below are internal estimates, not invoices."
            : "Amounts below are internal usage estimates, not invoices. Your administrator manages payment methods and plan changes."}
        </Alert>
      )}
      {billing.loading ? (
        <Loading label="Loading billing details" />
      ) : billing.error ? (
        <ErrorState error={billing.error} retry={billing.reload} />
      ) : (
        <>
          <section className="billing-overview">
            <div className="billing-plan">
              <span className="eyebrow">YOUR CURRENT PLAN</span>
              <h2>
                {b.plan.name}
                <Badge tone="green">Current plan</Badge>
              </h2>
              <p>{money(b.baseAmountCents)} monthly base price</p>
              <div className="billing-period">
                <span>Current billing period</span>
                <strong>
                  {date(b.billingPeriod.startsAt)} —{" "}
                  {date(b.billingPeriod.endsAt)}
                </strong>
                <small>Next period begins {date(b.billingPeriod.endsAt)}</small>
              </div>
            </div>
            <div className="billing-usage">
              <div className="between">
                <h3>Stored file usage</h3>
                <strong>
                  {usedFiles ?? "—"} / {b.includedUploadAllowance}
                </strong>
              </div>
              <Progress
                value={usedFiles || 0}
                max={b.includedUploadAllowance}
                label="Stored file allowance"
              />
              <p>
                {b.plan.includedFilesPerMonth.toLocaleString()} included stored
                files. Delete a file to free a slot.
                {b.plan.extraFilePriceCents !== null &&
                  ` ${money(b.plan.extraFilePriceCents)} per upload above stored capacity.`}
              </p>
              <div className="between">
                <span>Employees</span>
                <strong>
                  {b.employeeCount}
                  {b.plan.maxEmployees !== null
                    ? ` / ${b.plan.maxEmployees}`
                    : " / Unlimited"}
                </strong>
              </div>
              <p>
                {b.plan.code === "basic"
                  ? "$5/month per employee. The company owner is not billed as an employee."
                  : b.plan.code === "free"
                    ? "One company owner included. Upgrade to invite employees."
                    : "Unlimited employees included in your monthly base price."}
              </p>
            </div>
          </section>
          <section className="cost-panel">
            <div>
              <span className="eyebrow">CURRENT PERIOD ESTIMATE</span>
              <h2>
                {money(b.totalAmountCents)}
                <small> USD</small>
              </h2>
              <p>Based on your current plan and recorded usage.</p>
            </div>
            <dl className="cost-lines">
              <div>
                <dt>Monthly base</dt>
                <dd>{money(b.baseAmountCents)}</dd>
              </div>
              <div>
                <dt>
                  {b.billableEmployeeCount} billable employees ×{" "}
                  {money(b.employeeUnitPriceCents)}
                </dt>
                <dd>{money(b.employeeChargeCents)}</dd>
              </div>
              <div>
                <dt>
                  {b.billableOverageUploads} recorded additional files ×{" "}
                  {money(b.overageUnitPriceCents)}
                </dt>
                <dd>{money(b.overageChargeCents)}</dd>
              </div>
              <div className="total">
                <dt>Estimated total</dt>
                <dd>{money(b.totalAmountCents)}</dd>
              </div>
            </dl>
          </section>
          {b.planChangedInCurrentPeriod && (
            <Alert type="info">
              Your plan changed this period. This estimate uses your current
              plan plus any previously recorded file overage.
            </Alert>
          )}
        </>
      )}
      {isAdmin && (
        <PaymentPanel resource={payments} onChanged={reloadBilling} />
      )}
      <div className="section-heading">
        <span className="eyebrow">PLAN DIRECTORY</span>
        <h2>Choose your capacity.</h2>
      </div>
      {plans.loading ? (
        <Loading label="Loading available plans" />
      ) : plans.error ? (
        <ErrorState error={plans.error} retry={plans.reload} />
      ) : (
        <section
          className="plan-directory"
          aria-label="Available subscription plans"
        >
          {plans.data.map((plan, i) => {
            const current = b?.plan.code === plan.code;
            const keepPlan =
              current &&
              managed &&
              (pending || payments.data?.cancelAtPeriodEnd);
            const connectPlan =
              current && stripeReady && !managed && plan.code !== "free";
            const queued = pending === plan.code;
            const blockedByPending =
              pending && !current && plan.code !== "free";
            return (
              <article
                className={`plan-row ${current ? "current" : ""}`}
                key={plan.code}
              >
                <div className="plan-identity">
                  <span className="plan-index">0{i + 1}</span>
                  {current && (
                    <Badge tone="green">
                      <Check size={12} />
                      Your plan
                    </Badge>
                  )}
                  <h3>{plan.name}</h3>
                  <p>
                    {plan.code === "free"
                      ? "A focused start for your data."
                      : plan.code === "basic"
                        ? "A shared space for a growing team."
                        : "Built for your next stage of scale."}
                  </p>
                </div>
                <div className="plan-price">
                  {money(
                    plan.code === "basic"
                      ? plan.employeePriceCents
                      : plan.basePriceCents,
                  )}
                  <span>
                    {plan.code === "basic" ? "/ employee / month" : "/ month"}
                  </span>
                </div>
                <div className="plan-allowance">
                  <strong>{plan.includedFilesPerMonth.toLocaleString()}</strong>
                  <span>stored files</span>
                  <div
                    className={`allowance-ticks ticks-${plan.code}`}
                    aria-hidden="true"
                  >
                    {Array.from({ length: 20 }, (_, j) => (
                      <i key={j} />
                    ))}
                  </div>
                </div>
                <ul>
                  <li>
                    <Check size={15} />
                    {plan.maxEmployees === null
                      ? "Unlimited employees"
                      : plan.maxEmployees === 0
                        ? "1 user · Company owner"
                        : `Up to ${plan.maxEmployees} employees`}
                  </li>
                  <li>
                    <Check size={15} />
                    Company and restricted file access
                  </li>
                  <li>
                    <Check size={15} />
                    {plan.extraFilePriceCents === null
                      ? "Stored file allowance"
                      : `${money(plan.extraFilePriceCents)} per additional file`}
                  </li>
                </ul>
                {isAdmin ? (
                  <Button
                    variant={
                      current
                        ? "secondary"
                        : plan.code === "premium"
                          ? "primary"
                          : "secondary"
                    }
                    className="full"
                    disabled={
                      !b ||
                      payments.loading ||
                      previewLoading ||
                      (!stripeReady && !assignmentMode) ||
                      (current && !keepPlan && !connectPlan) ||
                      queued ||
                      blockedByPending
                    }
                    onClick={() => choosePlan(plan)}
                  >
                    {keepPlan
                      ? `Keep ${plan.name}`
                      : connectPlan
                        ? `Connect ${plan.name} billing`
                        : queued
                          ? "Change requested"
                          : current
                            ? "Current plan"
                            : `${rank[plan.code] > rank[b?.plan.code] ? "Upgrade" : "Downgrade"} to ${plan.name}`}
                    {!current && <ArrowRight size={15} />}
                  </Button>
                ) : (
                  <p className="small muted">
                    Your administrator manages this plan.
                  </p>
                )}
              </article>
            );
          })}
        </section>
      )}
      {chosen && needsCleanup && !automatic && (
        <Modal
          title={`Prepare downgrade to ${chosen.name}`}
          onClose={closeChange}
        >
          <p>
            You have {preview.storedFiles} stored files. {chosen.name} allows{" "}
            {preview.fileLimit}.
          </p>
          <p>
            You have {preview.employees} employees and{" "}
            {preview.pendingInvitations} pending invitations. {chosen.name}{" "}
            allows {preview.employeeLimit} combined slots.
          </p>
          <Alert type="info">
            Choose which files, employees, and invitations to remove yourself,
            or confirm automatic cleanup in the next step.
          </Alert>
          <div className="downgrade-options">
            <Button
              variant="secondary"
              onClick={() => {
                closeChange();
                window.location.assign(
                  preview.filesToRemove > 0
                    ? "/dashboard/files"
                    : "/dashboard/employees",
                );
              }}
            >
              Choose what to remove
            </Button>
            <Button variant="danger" onClick={() => setAutomatic(true)}>
              Review automatic cleanup
            </Button>
          </div>
        </Modal>
      )}
      {chosen && (!needsCleanup || automatic) && (
        <Confirm
          title={
            automatic
              ? `Delete extras and downgrade to ${chosen.name}?`
              : setup
                ? `Set up ${chosen.name} billing?`
                : chosen.code === b?.plan.code
                  ? `Keep ${chosen.name}?`
                  : `Change to ${chosen.name}?`
          }
          description={
            automatic
              ? `This permanently deletes ${preview.filesToRemove} older files, keeping your ${preview.filesToKeep} newest files. It deletes ${preview.employeesToRemove} newest employee accounts and revokes ${preview.invitationsToRevoke} newest pending invitations beyond the limit. The oldest employee accounts are kept first, then the oldest pending invitations within remaining slots. Cleanup happens now, before the plan request; if billing fails, deleted items are not restored. Buying a higher plan later will not restore them. ${assignmentMode ? "The plan changes immediately after cleanup." : chosen.code === "free" ? "Free takes effect immediately after billing confirmation." : "The Basic downgrade takes effect at the billing-period boundary."} No automatic refund is issued. Are you sure?`
              : `${chosen.name} includes ${chosen.includedFilesPerMonth.toLocaleString()} stored files. ${chosen.code === "basic" ? "$5 per employee per month." : `${money(chosen.basePriceCents)} monthly base.`} ${assignmentMode ? "This is a workspace plan assignment; no payment is collected." : setup ? "You’ll continue to Stripe Checkout to save a payment method. Checkout does not collect a payment immediately. Return here to verify your subscription." : chosen.code === b?.plan.code ? "This requests keeping your current plan and clearing its scheduled change." : chosen.code === "free" ? "Free takes effect immediately after confirmation. Paid features end immediately. No automatic refund is issued." : "No real charges are currently made. Downgrades take effect at the billing-period boundary; upgrades can take effect earlier. No prorated charge is applied."} Before downgrading, choose which files and employees to keep. Remove extra files and employees and revoke excess pending invitations to fit the selected plan. Nothing is removed automatically.`
          }
          label={
            automatic
              ? "Delete extras and downgrade"
              : setup
                ? "Continue to Stripe"
                : "Confirm plan change"
          }
          dangerous={automatic}
          onClose={closeChange}
          onConfirm={async () => {
            if (setup && !automatic) {
              await openStripe("checkout", chosen.code);
              return;
            }
            const result = await request(
              automatic
                ? "/subscriptions/downgrade-cleanup"
                : assignmentMode
                  ? "/subscriptions/current"
                  : chosen.code === "free"
                    ? "/payments/cancel"
                    : "/payments/plan",
              {
                method: assignmentMode && !automatic ? "PATCH" : "POST",
                body: automatic
                  ? {
                      planCode: chosen.code,
                      previewToken: preview.previewToken,
                    }
                  : !assignmentMode && chosen.code === "free"
                    ? {}
                    : { planCode: chosen.code },
              },
            );
            toast(
              assignmentMode
                ? `Workspace plan changed to ${chosen.name}`
                : result.pendingPlanCode
                  ? `Change to ${planName(result.pendingPlanCode)} requested${result.effectiveAt ? ` for ${date(result.effectiveAt)}` : ""}`
                  : result.planCode === "free"
                    ? "Your workspace is now on Free."
                    : "Plan request completed. Payment status is being refreshed.",
            );
            reloadBilling();
            payments.reload();
          }}
        />
      )}
    </>
  );
}
