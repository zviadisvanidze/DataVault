"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Building2,
  Files,
  LogOut,
  ShieldCheck,
  Users,
} from "lucide-react";
import { Button, Confirm, Field, Loading, Logo } from "@/components/ui";
import {
  NEW_PASSWORD_HINT,
  NEW_PASSWORD_MAX_LENGTH,
  NEW_PASSWORD_MIN_LENGTH,
  validNewPassword,
} from "@/lib/password-policy";
import "./platform.css";

const key = "datavault.platform.session";
const tabs = [
  "Overview",
  "Companies",
  "Users",
  "Files",
  "Audit logs",
  "Access requests",
];
const paths = [
  "dashboard",
  "companies",
  "users",
  "files",
  "audit-logs",
  "access-requests",
];
const date = (value) => (value ? new Date(value).toLocaleDateString() : "—");
const timestamp = (value) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "long",
      })
    : "Time unavailable";

async function loadDirectory(path, token, audit) {
  const result = await api(path, { token });
  if (!audit) return result;
  const ids = [
    ...new Set(
      result.items
        .filter((item) => item.targetType === "company" && item.targetId)
        .map((item) => item.targetId),
    ),
  ];
  const names = Object.fromEntries(
    await Promise.all(
      ids.map(async (id) => {
        try {
          const detail = await api(`companies/${id}`, { token });
          return [id, detail.company.name];
        } catch (error) {
          if (error.status === 401) throw error;
          return [id, null];
        }
      }),
    ),
  );
  return {
    ...result,
    items: result.items.map((item) => ({
      ...item,
      companyName: names[item.targetId],
    })),
  };
}

async function api(path, { token, method = "GET", body } = {}) {
  const response = await fetch(`/backend/admin/${path}`, {
    method,
    cache: "no-store",
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const error = new Error(
      response.status === 401
        ? "Your admin session has expired. Sign in again."
        : response.status === 429
          ? "Too many attempts. Please wait a minute and try again."
          : response.status >= 500
            ? "DataVault is temporarily unavailable. Please try again shortly."
            : "This request could not be completed. Check the details and try again.",
    );
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export default function PlatformAdmin() {
  const verifiedCode = useRef("");
  const [token, setToken] = useState(null);
  const [authMode, setAuthMode] = useState("login");
  const [resetToken, setResetToken] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [notice, setNotice] = useState("");
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [data, setData] = useState(null);
  const [detail, setDetail] = useState(null);
  const [reason, setReason] = useState("security_review");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [confirmation, setConfirmation] = useState(null);
  useEffect(() => {
    function openAccessLink() {
      const fragment = new URLSearchParams(window.location.hash.slice(1));
      const linkToken = fragment.get("reset");
      const verification = fragment.get("verify_admin_request");
      const setup = fragment.get("setup_admin");
      if (!linkToken && !verification && !setup) return false;
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
      );
      sessionStorage.removeItem(key);
      setToken(null);
      setNotice("");
      if (linkToken) {
        setResetToken(linkToken);
        setAuthMode("reset");
        setError(
          /^[A-Za-z0-9_-]{43}$/.test(linkToken)
            ? ""
            : "This reset link is invalid. Request a new one.",
        );
      } else if (verification) {
        setAuthMode("verifying");
        if (verifiedCode.current === verification) return true;
        verifiedCode.current = verification;
        if (!/^[A-Za-z0-9_-]{43}$/.test(verification)) {
          setAuthMode("verification_failed");
          setError(
            "This verification link is invalid or expired. Submit a new request if needed.",
          );
        } else {
          api("access/verify", {
            method: "POST",
            body: { token: verification },
          })
            .then(() => setAuthMode("request_pending"))
            .catch((failure) => {
              setAuthMode("verification_failed");
              setError(
                failure.status === 400
                  ? "This verification link has expired or was already used."
                  : failure.message,
              );
            });
        }
      } else {
        setAccessToken(setup);
        setAuthMode("access_setup");
        setError(
          /^[A-Za-z0-9_-]{43}$/.test(setup)
            ? ""
            : "This setup link is invalid. Ask a platform admin for a new link.",
        );
      }
      return true;
    }
    if (!openAccessLink()) setToken(sessionStorage.getItem(key));
    window.addEventListener("hashchange", openAccessLink);
    setReady(true);
    return () => window.removeEventListener("hashchange", openAccessLink);
  }, []);
  useEffect(() => {
    if (!token) return;
    let active = true;
    setData(null);
    setError("");
    const params = new URLSearchParams({ page: String(page), limit: "25" });
    if (search && [1, 2, 3].includes(tab)) params.set("search", search);
    loadDirectory(`${paths[tab]}${tab ? `?${params}` : ""}`, token, tab === 4)
      .then((result) => {
        if (active) setData(result);
      })
      .catch((failure) => {
        if (!active) return;
        if (failure.status === 401) logout();
        setError(failure.message);
      });
    return () => {
      active = false;
    };
  }, [token, tab, page, search, refresh]);
  function logout() {
    sessionStorage.removeItem(key);
    setToken(null);
    setDetail(null);
    setData(null);
  }
  async function login(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api("auth/login", {
        method: "POST",
        body: Object.fromEntries(new FormData(event.currentTarget)),
      });
      sessionStorage.setItem(key, result.accessToken);
      setToken(result.accessToken);
    } catch (failure) {
      setError(
        failure.status === 401
          ? "Check your admin email and password."
          : failure.message,
      );
    } finally {
      setBusy(false);
    }
  }
  async function forgotPassword(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("auth/forgot-password", {
        method: "POST",
        body: Object.fromEntries(new FormData(event.currentTarget)),
      });
      setNotice(
        "If this is an active platform admin email, a reset link will arrive shortly. Check your inbox and spam folder.",
      );
      setAuthMode("sent");
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  async function resetPassword(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const newPassword = form.get("newPassword");
    if (newPassword !== form.get("confirmPassword")) {
      setError("Passwords do not match.");
      return;
    }
    if (!validNewPassword(newPassword)) {
      setError(NEW_PASSWORD_HINT);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api("auth/reset-password", {
        method: "POST",
        body: { token: resetToken, newPassword },
      });
      setResetToken("");
      setAuthMode("login");
      setNotice("Password updated. Sign in with your new password.");
    } catch (failure) {
      setError(
        failure.status === 401
          ? "This reset link has expired or was already used. Request a new one."
          : failure.message,
      );
    } finally {
      setBusy(false);
    }
  }
  async function requestAccess(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const form = Object.fromEntries(new FormData(event.currentTarget));
      await api("access/request", {
        method: "POST",
        body: {
          fullName: form.fullName,
          email: form.email,
          ...(form.reason?.trim() ? { reason: form.reason.trim() } : {}),
        },
      });
      setAuthMode("request_sent");
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  async function setupAccess(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const newPassword = form.get("newPassword");
    if (newPassword !== form.get("confirmPassword")) {
      setError("Passwords do not match.");
      return;
    }
    if (!validNewPassword(newPassword)) {
      setError(NEW_PASSWORD_HINT);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api("access/setup", {
        method: "POST",
        body: { token: accessToken, newPassword },
      });
      setAccessToken("");
      setAuthMode("login");
      setNotice(
        "Your platform admin account is ready. Sign in with your new password.",
      );
    } catch (failure) {
      setError(
        failure.status === 400
          ? "This setup link has expired or was already used. Ask a platform admin for a new link."
          : failure.message,
      );
    } finally {
      setBusy(false);
    }
  }
  function changeAuthMode(mode) {
    setAuthMode(mode);
    if (mode !== "reset") setResetToken("");
    setError("");
    setNotice("");
  }
  async function reviewRequest() {
    const { id, decision } = confirmation;
    setBusy(true);
    setError("");
    try {
      const result = await api(`access-requests/${id}/decision`, {
        token,
        method: "POST",
        body: { decision },
      });
      setRefresh((value) => value + 1);
      if (!result.notificationDelivered)
        setNotice(
          decision === "approve"
            ? "Request approved, but the setup email could not be delivered. Use Resend setup link below."
            : "Request rejected, but the decision email could not be delivered.",
        );
      else
        setNotice(
          `Request ${decision === "approve" ? "approved" : "rejected"}. Email sent.`,
        );
    } catch (failure) {
      setError(
        failure.status === 409
          ? "This request was already reviewed. Refresh the list."
          : failure.message,
      );
    } finally {
      setBusy(false);
    }
  }
  async function resendDecision(id, kind) {
    setBusy(true);
    setError("");
    try {
      await api(
        `access-requests/${id}/${kind === "approved" ? "resend-setup" : "resend-rejection"}`,
        {
          token,
          method: "POST",
          body: {},
        },
      );
      setNotice(
        kind === "approved"
          ? "A new one-time setup link was emailed."
          : "The rejection decision was emailed.",
      );
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  async function openCompany(id) {
    setError("");
    try {
      setDetail(await api(`companies/${id}`, { token }));
    } catch (failure) {
      setError(failure.message);
    }
  }
  async function changeStatus() {
    const { next, company, reason: selectedReason } = confirmation;
    setBusy(true);
    setError("");
    try {
      await api(`companies/${company.id}/${next}`, {
        token,
        method: "POST",
        body: next === "suspend" ? { reason: selectedReason } : {},
      });
      // Reuse the directory loader so the current search and page are retained.
      setRefresh((value) => value + 1);
      try {
        setDetail(await api(`companies/${company.id}`, { token }));
      } catch {
        setDetail(null);
        setError(
          "Company status updated, but its details could not be refreshed. Open the company again to check its status.",
        );
      }
    } finally {
      setBusy(false);
    }
  }
  if (!ready)
    return (
      <main className="center-screen">
        <Loading />
      </main>
    );
  if (!token)
    return (
      <main className="platform-login">
        <div className="platform-login-card">
          <Logo />
          <ShieldCheck size={32} aria-hidden="true" />
          <h1>
            {authMode === "login"
              ? "Platform administration"
              : authMode === "reset"
                ? "Set a new password"
                : authMode === "request"
                  ? "Request platform admin access"
                  : authMode === "verifying"
                    ? "Verifying your email"
                    : authMode === "verification_failed"
                      ? "Verification unavailable"
                      : authMode === "request_sent"
                        ? "Check your email"
                        : authMode === "request_pending"
                          ? "Request sent"
                          : authMode === "access_setup"
                            ? "Set your admin password"
                            : authMode === "sent"
                              ? "Check your email"
                              : "Recover admin access"}
          </h1>
          <p>
            {authMode === "login"
              ? "Use your separate DataVault platform admin credentials."
              : authMode === "reset"
                ? "Choose a new password for your platform admin account."
                : authMode === "request"
                  ? "Verify your email, then an existing platform admin will review your request."
                  : authMode === "verifying"
                    ? "Checking your one-time verification link…"
                    : authMode === "request_sent"
                      ? "If your request can be received, a verification link will arrive shortly. Check your inbox and spam folder."
                      : authMode === "request_pending"
                        ? "Your email is verified. Please wait for an admin decision by email."
                        : authMode === "access_setup"
                          ? "Your request was approved. Create a password to activate your platform admin account."
                          : authMode === "verification_failed"
                            ? "The link could not be verified."
                            : authMode === "sent"
                              ? "Follow the one-time link in the email to continue."
                              : "Enter your platform admin email to receive a reset link."}
          </p>
          {error && (
            <p className="platform-error" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="platform-notice" role="status">
              {notice}
            </p>
          )}
          {authMode === "login" && (
            <>
              <form onSubmit={login} className="form-stack">
                <Field
                  label="Admin email"
                  name="email"
                  type="email"
                  autoComplete="username"
                  required
                />
                <Field
                  label="Password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  maxLength={NEW_PASSWORD_MAX_LENGTH}
                  required
                />
                <Button busy={busy} className="full">
                  Sign in to platform <ArrowRight size={16} />
                </Button>
              </form>
              <button
                type="button"
                className="platform-text-button"
                onClick={() => changeAuthMode("forgot")}
              >
                Forgot admin password?
              </button>
              <button
                type="button"
                className="platform-text-button"
                onClick={() => changeAuthMode("request")}
              >
                Request platform admin access
              </button>
              <Link href="/login" className="text-link">
                Company workspace sign in
              </Link>
            </>
          )}
          {authMode === "forgot" && (
            <form onSubmit={forgotPassword} className="form-stack">
              <Field
                label="Admin email"
                name="email"
                type="email"
                autoComplete="email"
                required
              />
              <Button busy={busy} className="full">
                Email reset link <ArrowRight size={16} />
              </Button>
            </form>
          )}
          {authMode === "request" && (
            <form onSubmit={requestAccess} className="form-stack">
              <Field
                label="Full name"
                name="fullName"
                autoComplete="name"
                minLength={2}
                maxLength={100}
                required
              />
              <Field
                label="Email address"
                name="email"
                type="email"
                autoComplete="email"
                required
              />
              <Field
                label="Why do you need access? (optional)"
                name="reason"
                maxLength={500}
              />
              <Button busy={busy} className="full">
                Send verification email <ArrowRight size={16} />
              </Button>
            </form>
          )}
          {authMode === "verifying" && <Loading label="Verifying your email" />}
          {authMode === "access_setup" && (
            <form onSubmit={setupAccess} className="form-stack">
              <Field
                label="New password"
                name="newPassword"
                type="password"
                autoComplete="new-password"
                minLength={NEW_PASSWORD_MIN_LENGTH}
                maxLength={NEW_PASSWORD_MAX_LENGTH}
                required
                hint={NEW_PASSWORD_HINT}
              />
              <Field
                label="Confirm new password"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                minLength={NEW_PASSWORD_MIN_LENGTH}
                maxLength={NEW_PASSWORD_MAX_LENGTH}
                required
              />
              <Button
                busy={busy}
                disabled={!/^[A-Za-z0-9_-]{43}$/.test(accessToken)}
                className="full"
              >
                Activate admin account <ArrowRight size={16} />
              </Button>
            </form>
          )}
          {authMode === "reset" && (
            <form onSubmit={resetPassword} className="form-stack">
              <Field
                label="New password"
                name="newPassword"
                type="password"
                autoComplete="new-password"
                minLength={NEW_PASSWORD_MIN_LENGTH}
                maxLength={NEW_PASSWORD_MAX_LENGTH}
                required
                hint={NEW_PASSWORD_HINT}
              />
              <Field
                label="Confirm new password"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                minLength={NEW_PASSWORD_MIN_LENGTH}
                maxLength={NEW_PASSWORD_MAX_LENGTH}
                required
              />
              <Button
                busy={busy}
                disabled={!/^[A-Za-z0-9_-]{43}$/.test(resetToken)}
                className="full"
              >
                Reset password <ArrowRight size={16} />
              </Button>
            </form>
          )}
          {authMode !== "login" && (
            <button
              type="button"
              className="platform-text-button"
              onClick={() => changeAuthMode("login")}
            >
              Back to admin sign in
            </button>
          )}
          {authMode === "reset" && (
            <button
              type="button"
              className="platform-text-button"
              onClick={() => changeAuthMode("forgot")}
            >
              Request a new link
            </button>
          )}
        </div>
      </main>
    );
  const items = data?.items ?? [];
  return (
    <main className="platform-shell">
      <aside className="platform-sidebar">
        <Logo />
        <span className="platform-sidebar-title">Platform administration</span>
        <nav aria-label="Platform navigation">
          {tabs.map((name, index) => (
            <button
              key={name}
              type="button"
              className={tab === index ? "active" : ""}
              onClick={() => {
                setData(null);
                setTab(index);
                setPage(1);
                setSearch("");
                setDraft("");
                setDetail(null);
              }}
            >
              {name}
            </button>
          ))}
        </nav>
        <button className="platform-signout" type="button" onClick={logout}>
          <LogOut size={16} /> Sign out
        </button>
      </aside>
      <section className="platform-main">
        <header className="platform-heading">
          <div>
            <h1>{tabs[tab]}</h1>
            <p>DataVault platform operations</p>
          </div>
          <span className="platform-badge">
            <ShieldCheck size={15} /> Platform admin
          </span>
        </header>
        {error && (
          <p className="platform-error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="platform-notice" role="status">
            {notice}
          </p>
        )}
        {tab > 0 && tab < 4 && (
          <form
            className="platform-search"
            onSubmit={(event) => {
              event.preventDefault();
              setPage(1);
              setSearch(draft.trim());
            }}
          >
            <input
              aria-label={`Search ${tabs[tab].toLowerCase()}`}
              placeholder={`Search ${tabs[tab].toLowerCase()}`}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              maxLength={80}
            />
            <Button variant="secondary">Search</Button>
          </form>
        )}
        {!data ? (
          <Loading label={`Loading ${tabs[tab].toLowerCase()}`} />
        ) : tab === 0 ? (
          <div className="platform-overview">
            <article>
              <Building2 size={21} />
              <span>Companies</span>
              <strong>{data.companies?.total ?? 0}</strong>
              <small>
                {data.companies?.pendingActivation ?? 0} pending activation
              </small>
            </article>
            <article>
              <Users size={21} />
              <span>Tenant users</span>
              <strong>{data.tenantUsers?.total ?? 0}</strong>
              <small>{data.tenantUsers?.owners ?? 0} owners</small>
            </article>
            <article>
              <Files size={21} />
              <span>Stored files</span>
              <strong>{data.currentlyStoredFiles?.total ?? 0}</strong>
              <small>
                {data.currentlyStoredFiles?.restricted ?? 0} restricted
              </small>
            </article>
            <article>
              <ShieldCheck size={21} />
              <span>Suspended companies</span>
              <strong>{data.companies?.suspended ?? 0}</strong>
              <small>{data.pendingInvitations ?? 0} pending invitations</small>
            </article>
          </div>
        ) : tab === 5 ? (
          <div className="platform-access-list">
            <p className="platform-access-intro">
              Only verified email requests appear here. Approval sends a
              one-time password setup link; it does not sign the requester in.
            </p>
            {items.length === 0 ? (
              <div className="platform-access-empty">
                No verified access requests yet.
              </div>
            ) : (
              items.map((item) => (
                <article className="platform-access-item" key={item.id}>
                  <div className="platform-access-item-heading">
                    <div>
                      <h2>{item.fullName}</h2>
                      <p>{item.email}</p>
                    </div>
                    <span
                      className={`platform-access-status status-${item.status}`}
                    >
                      {item.status.replaceAll("_", " ")}
                    </span>
                  </div>
                  {item.reason && (
                    <p className="platform-access-reason">{item.reason}</p>
                  )}
                  <p className="platform-access-meta">
                    Verified {timestamp(item.verifiedAt)}
                    {item.reviewedAt
                      ? ` · Reviewed ${timestamp(item.reviewedAt)}`
                      : ""}
                  </p>
                  {item.status === "pending_review" && (
                    <div className="platform-access-actions">
                      <Button
                        disabled={busy}
                        onClick={() =>
                          setConfirmation({
                            id: item.id,
                            name: item.fullName,
                            decision: "approve",
                          })
                        }
                      >
                        Approve request
                      </Button>
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() =>
                          setConfirmation({
                            id: item.id,
                            name: item.fullName,
                            decision: "reject",
                          })
                        }
                      >
                        Reject
                      </Button>
                    </div>
                  )}
                  {item.status === "approved" && (
                    <button
                      type="button"
                      className="platform-text-button"
                      disabled={busy}
                      onClick={() => resendDecision(item.id, "approved")}
                    >
                      Resend setup link
                    </button>
                  )}
                  {item.status === "rejected" && (
                    <button
                      type="button"
                      className="platform-text-button"
                      disabled={busy}
                      onClick={() => resendDecision(item.id, "rejected")}
                    >
                      Resend decision email
                    </button>
                  )}
                </article>
              ))
            )}
            <div className="platform-pager">
              <span>
                {data.total ?? 0} requests · Page {page}
              </span>
              <div>
                <Button
                  variant="secondary"
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  disabled={page * 25 >= (data.total ?? 0)}
                  onClick={() => setPage(page + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="platform-list">
              {items.length === 0 ? (
                <p>No records found.</p>
              ) : (
                items.map((item) => (
                  <div className="platform-row" key={item.id}>
                    <div>
                      <strong>
                        {tab === 1
                          ? item.name
                          : tab === 2
                            ? item.fullName || item.email
                            : tab === 3
                              ? item.originalFilename
                              : item.action?.replaceAll("_", " ") ||
                                "Audit event"}
                      </strong>
                      <small>
                        {tab === 1
                          ? `${item.country} · ${item.industry}`
                          : tab === 2
                            ? `${item.email} · ${item.role}`
                            : tab === 3
                              ? `${item.fileType} · ${item.visibility}`
                              : `${item.targetType === "company" ? item.companyName || `Company unavailable (${item.targetId || "unknown ID"})` : item.targetType === "admin_access_request" ? "Platform access request" : "Platform admin"} · ${item.reason?.replaceAll("_", " ") || "—"}`}
                      </small>
                    </div>
                    {tab === 4 ? (
                      <time dateTime={item.createdAt}>
                        {timestamp(item.createdAt)}
                      </time>
                    ) : (
                      <span>
                        {tab === 1 ? item.platformStatus : date(item.createdAt)}
                      </span>
                    )}
                    {tab === 1 && (
                      <button
                        className="text-link"
                        type="button"
                        onClick={() => openCompany(item.id)}
                      >
                        View <ArrowRight size={14} />
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
            <div className="platform-pager">
              <span>
                {data.pagination?.total ?? 0} records · Page {page}
              </span>
              <div>
                <Button
                  variant="secondary"
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  disabled={page * 25 >= (data.pagination?.total ?? 0)}
                  onClick={() => setPage(page + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
        {detail && (
          <section className="platform-detail" aria-label="Company details">
            <button
              type="button"
              className="text-link"
              onClick={() => setDetail(null)}
            >
              Close details
            </button>
            <h2>{detail.company.name}</h2>
            <p>
              {detail.company.country} · {detail.company.industry} ·{" "}
              {detail.company.platformStatus}
            </p>
            <dl>
              <div>
                <dt>Owner</dt>
                <dd>{detail.owner?.email ?? "—"}</dd>
              </div>
              <div>
                <dt>Plan</dt>
                <dd>{detail.subscription?.planCode ?? "—"}</dd>
              </div>
              <div>
                <dt>Employees</dt>
                <dd>{detail.employees.accepted}</dd>
              </div>
              <div>
                <dt>Files</dt>
                <dd>{detail.currentlyStoredFiles.total}</dd>
              </div>
              <div>
                <dt>Activated</dt>
                <dd>{date(detail.company.activatedAt)}</dd>
              </div>
            </dl>
            {detail.company.platformStatus === "suspended" ? (
              <Button
                busy={busy}
                onClick={() =>
                  setConfirmation({
                    next: "reactivate",
                    company: detail.company,
                  })
                }
              >
                Reactivate company
              </Button>
            ) : (
              <div className="platform-actions">
                <label>
                  Suspension reason
                  <select
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  >
                    <option value="security_review">Security review</option>
                    <option value="policy_review">Policy review</option>
                    <option value="operational_hold">Operational hold</option>
                  </select>
                </label>
                <Button
                  busy={busy}
                  variant="danger"
                  onClick={() =>
                    setConfirmation({
                      next: "suspend",
                      company: detail.company,
                      reason,
                    })
                  }
                >
                  Suspend company
                </Button>
              </div>
            )}
          </section>
        )}
      </section>
      {confirmation && (
        <Confirm
          title={
            confirmation.decision
              ? `${confirmation.decision === "approve" ? "Approve" : "Reject"} ${confirmation.name}'s request?`
              : `${confirmation.next === "suspend" ? "Suspend" : "Reactivate"} ${confirmation.company.name}?`
          }
          description={
            confirmation.decision
              ? confirmation.decision === "approve"
                ? "A one-time password setup link will be sent to the verified email address. The requester will get admin access only after completing setup."
                : "The requester will receive a rejection email and will not get admin access."
              : confirmation.next === "suspend"
                ? `This blocks the company's owners and employees from accessing DataVault until it is reactivated. Reason: ${confirmation.reason.replaceAll("_", " ")}. Files and company data will be kept.`
                : "This restores access for eligible owners and employees. Existing account activation requirements still apply."
          }
          label={
            confirmation.decision
              ? confirmation.decision === "approve"
                ? "Approve request"
                : "Reject request"
              : confirmation.next === "suspend"
                ? "Suspend company"
                : "Reactivate company"
          }
          dangerous={
            confirmation.decision === "reject" ||
            confirmation.next === "suspend"
          }
          onClose={() => setConfirmation(null)}
          onConfirm={confirmation.decision ? reviewRequest : changeStatus}
        />
      )}
    </main>
  );
}
