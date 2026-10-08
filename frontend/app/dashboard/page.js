"use client";
import Link from "next/link";
import { useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Files,
  ShieldCheck,
  Users,
  Upload,
  LockKeyhole,
} from "lucide-react";
import { collection, request } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useResource } from "@/lib/hooks";
import { date, money } from "@/lib/utils";
import {
  Badge,
  Empty,
  ErrorState,
  Loading,
  PageHeading,
  Progress,
} from "@/components/ui";
import { FileDetail, FileTable } from "@/components/files/files-workspace";
import { useWorkspace } from "@/components/layout/shell";
export default function Overview() {
  const { user, isAdmin } = useAuth(),
    { subscription, company, reload: reloadWorkspace } = useWorkspace();
  const stats = useResource(
    (signal) => request("/statistics/current", { signal }),
    [],
  );
  const files = useResource(
    (signal) => request("/files?page=1&take=5", { signal }),
    [],
  );
  const people = useResource(
    (signal) =>
      isAdmin ? collection("/users", "users", signal) : Promise.resolve([]),
    [isAdmin],
  );
  const [selected, setSelected] = useState(null);
  const s = stats.data,
    usage = s?.files.currentBillingPeriod,
    usedFiles = s?.files.currentlyStored.total;
  return (
    <>
      <PageHeading
        eyebrow="WORKSPACE / OVERVIEW"
        title="The big picture."
        description={`Welcome back${user.fullName ? `, ${user.fullName.split(" ")[0]}` : ""}. Here’s what’s happening at ${company?.name || "your company"}.`}
        action={
          <Link className="button" href="/dashboard/files">
            Open your vault <ArrowUpRight size={16} />
          </Link>
        }
      />
      {stats.loading ? (
        <Loading label="Gathering your workspace overview" />
      ) : stats.error ? (
        <ErrorState error={stats.error} retry={stats.reload} />
      ) : (
        <>
          <section className="overview-grid">
            <div className="usage-hero">
              <svg
                className="overview-orbit"
                viewBox="0 0 320 300"
                fill="none"
                aria-hidden="true"
              >
                <g>
                  <ellipse
                    cx="160"
                    cy="150"
                    rx="125"
                    ry="83"
                    transform="rotate(-35 160 150)"
                    stroke="currentColor"
                  />
                  <circle cx="61" cy="224" r="5" fill="currentColor" />
                  <circle cx="264" cy="83" r="8" fill="currentColor" />
                </g>
              </svg>
              <div className="between">
                <span className="eyebrow">VAULT CAPACITY</span>
                <Badge>{s.subscription.planName} plan</Badge>
              </div>
              <div className="usage-number">
                {usedFiles.toLocaleString()}
                <span>/ {usage.includedAllowance.toLocaleString()}</span>
              </div>
              <h2>Files stored in your vault</h2>
              <Progress
                value={usedFiles}
                max={usage.includedAllowance}
                label="Included file usage"
              />
              <div className="between small">
                <span>
                  {usage.remainingIncludedUploads.toLocaleString()} included
                  file slots remaining
                </span>
                <span>Delete a file to free a slot</span>
              </div>
            </div>
            <div className="overview-side">
              <div className="mini-stat">
                <span className="stat-icon">
                  <Files size={20} />
                </span>
                <div>
                  <span>Files in your company</span>
                  <strong>
                    {s.files.currentlyStored.total.toLocaleString()}
                  </strong>
                  <small>
                    {s.files.currentlyStored.restricted} restricted ·{" "}
                    {s.files.currentlyStored.companyWide} company-wide
                  </small>
                </div>
              </div>
              <div className="mini-stat">
                <span className="stat-icon">
                  <Users size={20} />
                </span>
                <div>
                  <span>Your team</span>
                  <strong>
                    {s.employees.accepted + 1}
                    <small> people</small>
                  </strong>
                  <small>
                    {s.employees.pendingInvitations} pending invitations · Owner
                    included
                  </small>
                </div>
              </div>
              <div className="mini-stat">
                <span className="stat-icon">$</span>
                <div>
                  <span>Current period estimate</span>
                  <strong>{money(s.billing.totalAmountCents)}</strong>
                  <small>Internal estimate · No payment collected</small>
                </div>
                <Link
                  href="/dashboard/billing"
                  className="icon-button"
                  aria-label="View billing"
                >
                  <ArrowUpRight size={17} />
                </Link>
              </div>
            </div>
          </section>
        </>
      )}
      <div className="workspace-columns">
        <section className="recent-files">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">01 / THE VAULT</span>
              <h2>Recent files</h2>
            </div>
            <Link className="text-link" href="/dashboard/files">
              View all <ArrowRight size={15} />
            </Link>
          </div>
          {files.loading ? (
            <Loading label="Loading recent files" />
          ) : files.error ? (
            <ErrorState error={files.error} retry={files.reload} />
          ) : files.data.files.length ? (
            <FileTable
              files={files.data.files}
              users={people.data || []}
              onSelect={setSelected}
            />
          ) : (
            <Empty description="Upload your first CSV, XLS, or XLSX file to get started.">
              <Link className="text-link" href="/dashboard/files">
                Explore your vault <ArrowRight size={15} />
              </Link>
            </Empty>
          )}
        </section>
        <aside className="workspace-aside">
          <section className="quick-actions">
            <span className="eyebrow">02 / NEXT STEPS</span>
            <h2>Keep things moving.</h2>
            <Link href="/dashboard/files">
              <Files size={18} />
              <span>
                Explore your files<small>Find exactly what you need</small>
              </span>
              <ArrowUpRight size={16} />
            </Link>
            {isAdmin && (
              <Link href="/dashboard/employees">
                <Users size={18} />
                <span>
                  Bring your team together
                  <small>Invite people to your workspace</small>
                </span>
                <ArrowUpRight size={16} />
              </Link>
            )}
            <Link href="/dashboard/settings">
              <ShieldCheck size={18} />
              <span>
                Make it your workspace
                <small>Review your profile and security</small>
              </span>
              <ArrowUpRight size={16} />
            </Link>
          </section>
          <div className="workspace-note">
            <LockKeyhole size={19} />
            <p>
              <strong>Access with intention.</strong>
              <br />
              Company-wide or just the right people. You decide where your files
              belong.
            </p>
          </div>
        </aside>
      </div>
      {selected && (
        <FileDetail
          file={selected}
          users={people.data || []}
          onClose={() => setSelected(null)}
          onChanged={() => {
            files.reload();
            stats.reload();
            reloadWorkspace();
          }}
        />
      )}
    </>
  );
}
