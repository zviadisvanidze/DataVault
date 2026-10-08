"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  ShieldCheck,
  CircleHelp,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { googleSignInUrl, request } from "@/lib/api";
import { Alert, Button, Field, Logo, Loading } from "@/components/ui";
import LivingVault from "./living-vault";
import { paymentReturnPaths } from "@/lib/payments";
import {
  NEW_PASSWORD_HINT,
  NEW_PASSWORD_MAX_LENGTH,
  NEW_PASSWORD_MIN_LENGTH,
  validNewPassword,
} from "@/lib/password-policy";
function loginDestination() {
  const next = new URLSearchParams(window.location.search).get("next");
  return paymentReturnPaths.includes(next) ? next : "/dashboard";
}
const titles = {
  login: ["Welcome back.", "Your company’s data. Right where you left it."],
  register: [
    "A home for your data.",
    "Create your workspace. Bring clarity to your company.",
  ],
  activate: [
    "Unlock your workspace.",
    "Verify your email to get started with DataVault.",
  ],
  "employee-activate": [
    "Your team is waiting.",
    "Accept your invitation and join your company’s workspace.",
  ],
  "forgot-password": ["Let’s get you back in.", "Account recovery"],
  "reset-password": ["Reset your password.", "Account recovery"],
};
export default function AuthPage({ mode }) {
  const { user, loading, login, exchangeGoogle, registerWithGoogle } =
      useAuth(),
    router = useRouter();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(null),
    [success, setSuccess] = useState(""),
    [resendNotice, setResendNotice] = useState(""),
    [token, setToken] = useState(""),
    [tokenReady, setTokenReady] = useState(false),
    [email, setEmail] = useState(""),
    [googleCode, setGoogleCode] = useState(""),
    [oauthStatus, setOauthStatus] = useState(
      mode === "login" ? "checking" : "idle",
    );
  const captured = useRef(false);
  const oauthCaptured = useRef(false);
  const googleUrl = ["login", "register"].includes(mode)
    ? googleSignInUrl()
    : null;
  useEffect(() => {
    if (
      !loading &&
      user &&
      oauthStatus === "idle" &&
      ["login", "register"].includes(mode)
    )
      router.replace(loginDestination());
  }, [user, loading, mode, oauthStatus, router]);
  useEffect(() => {
    if (mode !== "login" || oauthCaptured.current) return;
    oauthCaptured.current = true;
    const url = new URL(window.location.href);
    const fragment = new URLSearchParams(url.hash.slice(1));
    const code = fragment.get("code");
    const denied = url.searchParams.get("error");
    if (code !== null || denied !== null) {
      url.searchParams.delete("error");
      window.history.replaceState(
        window.history.state,
        "",
        url.pathname + url.search,
      );
    }
    if (denied !== null) {
      setError(
        new Error(
          denied === "account_unavailable"
            ? "Your company’s workspace is unavailable. It may be inactive or suspended. Contact your company administrator or DataVault support for help."
            : denied === "google_auth_cancelled"
              ? "Google sign-in was cancelled. You can try again below."
              : "Google sign-in could not be completed. Please try again.",
        ),
      );
      setOauthStatus("idle");
      return;
    }
    if (code === null) {
      setOauthStatus("idle");
      return;
    }
    if (
      fragment.getAll("code").length !== 1 ||
      !/^[A-Za-z0-9_-]{43}$/.test(code)
    ) {
      setError(
        new Error(
          "This Google sign-in link is invalid. Please try Google sign-in again.",
        ),
      );
      setOauthStatus("idle");
      return;
    }
    setOauthStatus("exchanging");
    void exchangeGoogle(code)
      .then(() => router.replace(loginDestination()))
      .catch((failure) => setError(failure))
      .finally(() => setOauthStatus("idle"));
  }, [mode, exchangeGoogle, router]);
  useEffect(() => {
    if (mode !== "register") return;
    const url = new URL(window.location.href);
    const fragment = new URLSearchParams(url.hash.slice(1));
    const code = fragment.get("google_code");
    if (!code) return;
    window.history.replaceState(
      window.history.state,
      "",
      url.pathname + url.search,
    );
    if (
      fragment.getAll("google_code").length === 1 &&
      /^[A-Za-z0-9_-]{43}$/.test(code)
    )
      setGoogleCode(code);
    else
      setError(
        new Error(
          "This Google registration link is invalid. Try Google again.",
        ),
      );
  }, [mode]);
  useEffect(() => {
    if (mode !== "reset-password") return;
    function captureResetToken() {
      const url = new URL(window.location.href);
      const fragment = new URLSearchParams(url.hash.slice(1));
      if (url.hash) {
        setToken(
          fragment.getAll("token").length === 1 ? fragment.get("token") : "",
        );
        window.history.replaceState(null, "", url.pathname + url.search);
      }
      setTokenReady(true);
    }
    captureResetToken();
    window.addEventListener("hashchange", captureResetToken);
    return () => window.removeEventListener("hashchange", captureResetToken);
  }, [mode]);
  useEffect(() => {
    if (mode === "reset-password") return;
    if (captured.current) return;
    captured.current = true;
    const url = new URL(window.location.href);
    setToken(url.searchParams.get("token") || "");
    if (url.searchParams.has("token")) {
      url.searchParams.delete("token");
      window.history.replaceState(null, "", url.pathname + url.search);
    }
    setTokenReady(true);
  }, [mode]);
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      if (
        (mode === "reset-password" ||
          mode === "employee-activate" ||
          (mode === "register" && !googleCode)) &&
        !validNewPassword(
          mode === "reset-password" ? values.newPassword : values.password,
        )
      ) {
        setError(new Error(NEW_PASSWORD_HINT));
        return;
      }
      if (mode === "login") {
        await login(values);
        router.replace(loginDestination());
      }
      if (mode === "forgot-password") {
        await request("/auth/forgot-password", {
          method: "POST",
          body: { email: values.email },
          public: true,
        });
        setSuccess(
          "If this email belongs to an active workspace, a reset link will arrive shortly. Check your inbox and spam folder. The link expires after 30 minutes.",
        );
      }
      if (mode === "reset-password") {
        if (values.newPassword !== values.confirmPassword) {
          setError(new Error("Passwords do not match. Please try again."));
          return;
        }
        await request("/auth/reset-password", {
          method: "POST",
          body: { token, newPassword: values.newPassword },
          public: true,
        });
        setToken("");
        setSuccess(
          "Your password has been updated. Sign in with your new password to open your workspace.",
        );
      }
      if (mode === "register") {
        if (googleCode) {
          await registerWithGoogle({
            code: googleCode,
            companyName: values.companyName,
            country: values.country,
            industry: values.industry,
          });
          setGoogleCode("");
          router.replace("/dashboard");
        } else {
          await request("/auth/sign-up", {
            method: "POST",
            body: values,
            public: true,
          });
          setEmail(values.email);
          setSuccess(
            "Your workspace has been created. Check your inbox for an activation link, valid for 24 hours. Activate your account before signing in.",
          );
        }
      }
      if (mode === "activate") {
        await request("/auth/verify-account", {
          method: "POST",
          body: { token },
          public: true,
        });
        setToken("");
        setSuccess(
          "Your account is activated. Your workspace is ready for you.",
        );
      }
      if (mode === "employee-activate") {
        await request("/invitations/accept", {
          method: "POST",
          body: { ...values, token },
          public: true,
        });
        setToken("");
        setSuccess(
          "Invitation accepted. Sign in to open your company’s workspace.",
        );
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function resend(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await request("/auth/resend-verification", {
        method: "POST",
        body: { email },
        public: true,
      });
      setResendNotice(
        "If your account is eligible, a new activation email has been requested. Check your inbox and spam folder.",
      );
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  const recovery = ["forgot-password", "reset-password"].includes(mode),
    activation = ["activate", "employee-activate"].includes(mode);
  return (
    <main className="auth-layout">
      <section className="auth-story">
        <LivingVault />
        <Link href="/login" aria-label="DataVault home">
          <Logo light />
        </Link>
        <div className="story-body">
          <span className="eyebrow">THE COMPANY DATA WORKSPACE</span>
          <h1>
            Everything <br />
            in its <br />
            <em>right place.</em>
          </h1>
          <p>
            A considered space for the information that moves your business
            forward.
          </p>
        </div>
        <footer>BUILT FOR THE WAY YOUR COMPANY WORKS</footer>
      </section>
      <section className="auth-form-side">
        <div className="auth-top">
          <span>
            {mode === "register"
              ? "Already have a workspace?"
              : "New to DataVault?"}
          </span>
          <Link href={mode === "register" ? "/login" : "/register"}>
            {mode === "register" ? "Sign in" : "Create a workspace"}{" "}
            <ArrowUpRight size={14} />
          </Link>
        </div>
        <div className="auth-form-wrap">
          <span className="eyebrow auth-step">
            DATAVAULT /{" "}
            {mode === "register"
              ? "CREATE WORKSPACE"
              : mode === "login"
                ? "SIGN IN"
                : "ACCOUNT ACCESS"}
          </span>
          <h2>{titles[mode][0]}</h2>
          <p className="auth-subtitle">{titles[mode][1]}</p>
          <Alert>
            {error?.code === "account_exists" ? null : error?.message}
          </Alert>
          <Alert type="success">{resendNotice}</Alert>
          {error?.code === "account_exists" ? (
            <div className="success-panel account-state" role="alert">
              <CircleHelp size={32} />
              <h3>This account already exists</h3>
              <p>
                Use your existing account to get back to your workspace. If you
                have not activated it yet, request a new link below.
              </p>
              <Link className="button" href="/login">
                Sign in <ArrowRight size={16} />
              </Link>
              <button
                className="text-link"
                type="button"
                onClick={() => setError(null)}
              >
                Try another email
              </button>
            </div>
          ) : success ? (
            <div className="success-panel">
              <ShieldCheck size={32} />
              <h3>
                {mode === "register" || mode === "forgot-password"
                  ? "Check your inbox"
                  : mode === "reset-password"
                    ? "Password updated"
                    : "You’re all set"}
              </h3>
              <p>{success}</p>
              <Link className="button" href="/login">
                Continue to sign in <ArrowRight size={16} />
              </Link>
            </div>
          ) : recovery ? (
            <form onSubmit={submit} className="form-stack">
              {mode === "forgot-password" ? (
                <>
                  <p className="muted small">
                    Enter your workspace email and we’ll send a one-time reset
                    link.
                  </p>
                  <Field
                    label="Work email"
                    name="email"
                    type="email"
                    placeholder="you@company.com"
                    autoComplete="email"
                    maxLength={254}
                    required
                    error={error?.fields?.email}
                  />
                  <Button busy={busy} className="full">
                    Email reset link <ArrowRight size={17} />
                  </Button>
                </>
              ) : !tokenReady ? (
                <Loading label="Checking reset link" />
              ) : !/^[A-Za-z0-9_-]{43}$/.test(token) ? (
                <Alert>
                  This reset link is missing or invalid. Open the complete link
                  from your email, or request a new one.
                </Alert>
              ) : (
                <>
                  <p className="muted small">
                    Choose a new password for your DataVault workspace.
                  </p>
                  <Field
                    label="New password"
                    name="newPassword"
                    type="password"
                    autoComplete="new-password"
                    minLength={NEW_PASSWORD_MIN_LENGTH}
                    maxLength={NEW_PASSWORD_MAX_LENGTH}
                    required
                    hint={NEW_PASSWORD_HINT}
                    error={error?.fields?.newPassword}
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
                  <Button busy={busy} className="full">
                    Reset password <ArrowRight size={17} />
                  </Button>
                </>
              )}
              {busy && (
                <p className="muted small" role="status">
                  Connecting… DataVault may take a moment to wake up.
                </p>
              )}
              <Link
                className="text-link"
                href={
                  mode === "forgot-password" ? "/login" : "/forgot-password"
                }
              >
                {mode === "forgot-password"
                  ? "Back to sign in"
                  : "Request a new link"}
              </Link>
            </form>
          ) : (loading || oauthStatus !== "idle") &&
            ["login", "register"].includes(mode) ? (
            <Loading
              label={
                oauthStatus === "exchanging"
                  ? "Completing Google sign-in"
                  : "Checking your session"
              }
            />
          ) : (
            <form onSubmit={submit} className="form-stack">
              {activation && tokenReady && !token ? (
                <Alert>
                  This link is missing its activation token. Open the complete
                  link from your email. If you already activated your account,
                  sign in below.
                </Alert>
              ) : (
                <>
                  {mode === "register" && (
                    <>
                      <div className="form-grid">
                        <Field
                          label="Company name"
                          name="companyName"
                          placeholder="SpaceX"
                          minLength={2}
                          maxLength={100}
                          required
                          error={error?.fields?.companyName}
                        />
                        {!googleCode && (
                          <Field
                            label="Your name"
                            name="fullName"
                            placeholder="Elon Musk"
                            maxLength={100}
                            required
                            autoComplete="name"
                            error={error?.fields?.fullName}
                          />
                        )}
                      </div>
                    </>
                  )}
                  {(mode === "login" ||
                    (mode === "register" && !googleCode)) && (
                    <Field
                      label="Work email"
                      name="email"
                      type="email"
                      placeholder="you@company.com"
                      required
                      maxLength={254}
                      autoComplete="email"
                      onChange={(e) => setEmail(e.target.value)}
                      error={error?.fields?.email}
                    />
                  )}
                  {mode === "employee-activate" && (
                    <>
                      <p className="muted small">
                        Your invitation connects you to the company that sent
                        your email. Invitations expire after 72 hours.
                      </p>
                      <Field
                        label="Full name"
                        name="fullName"
                        autoComplete="name"
                        required
                        maxLength={100}
                        error={error?.fields?.fullName}
                      />
                    </>
                  )}
                  {mode !== "activate" &&
                    !(mode === "register" && googleCode) && (
                      <Field
                        label={
                          mode === "login" ? "Password" : "Create a password"
                        }
                        name="password"
                        type="password"
                        required
                        minLength={
                          mode === "login" ? 1 : NEW_PASSWORD_MIN_LENGTH
                        }
                        maxLength={NEW_PASSWORD_MAX_LENGTH}
                        autoComplete={
                          mode === "login" ? "current-password" : "new-password"
                        }
                        hint={mode !== "login" ? NEW_PASSWORD_HINT : undefined}
                        error={error?.fields?.password}
                      />
                    )}
                  {mode === "register" && (
                    <div className="form-grid">
                      <Field
                        label="Country"
                        name="country"
                        placeholder="US"
                        pattern="[A-Za-z]{2}"
                        minLength={2}
                        maxLength={2}
                        required
                        hint="Two-letter country code, e.g. GE or US"
                        onInput={(e) => {
                          e.target.value = e.target.value.toUpperCase();
                        }}
                        error={error?.fields?.country}
                      />
                      <Field
                        label="Industry"
                        name="industry"
                        placeholder="Aerospace"
                        minLength={2}
                        maxLength={100}
                        required
                        error={error?.fields?.industry}
                      />
                    </div>
                  )}
                  {mode === "login" && (
                    <div className="form-end">
                      <Link href="/forgot-password">Forgot password?</Link>
                    </div>
                  )}
                  <Button
                    busy={busy}
                    className="full"
                    disabled={activation && !tokenReady}
                  >
                    {mode === "login"
                      ? "Sign in to your workspace"
                      : mode === "register"
                        ? googleCode
                          ? "Create workspace with Google"
                          : "Create your workspace"
                        : mode === "activate"
                          ? "Activate account"
                          : "Join your workspace"}
                    <ArrowRight size={17} />
                  </Button>
                  {busy && (
                    <p className="muted small" role="status">
                      Connecting… the first request may take a moment while
                      DataVault wakes up.
                    </p>
                  )}
                </>
              )}
            </form>
          )}
          {["login", "register"].includes(mode) &&
            googleUrl &&
            !loading &&
            !googleCode &&
            oauthStatus === "idle" && (
              <div className="oauth-choice">
                <span className="oauth-divider">or</span>
                <a className="button secondary full" href={googleUrl}>
                  <svg
                    aria-hidden="true"
                    focusable="false"
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                  >
                    <path
                      fill="#4285F4"
                      d="M21.6 12.23c0-.71-.06-1.42-.19-2.1H12v3.98h5.38a4.6 4.6 0 0 1-1.99 3.02v2.58h3.22c1.88-1.73 2.99-4.29 2.99-7.48Z"
                    />
                    <path
                      fill="#34A853"
                      d="M12 22c2.7 0 4.97-.9 6.62-2.29l-3.22-2.58c-.9.61-2.04.97-3.4.97-2.61 0-4.82-1.77-5.61-4.16H3.07v2.65A10 10 0 0 0 12 22Z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M6.39 13.94a6 6 0 0 1 0-3.88V7.41H3.07a10 10 0 0 0 0 9.18l3.32-2.65Z"
                    />
                    <path
                      fill="#EA4335"
                      d="M12 5.9c1.43 0 2.7.49 3.71 1.46l2.78-2.78A9.96 9.96 0 0 0 12 2a10 10 0 0 0-8.93 5.41l3.32 2.65C7.18 7.67 9.39 5.9 12 5.9Z"
                    />
                  </svg>
                  Continue with Google
                </a>
                <p className="muted small">
                  {mode === "register"
                    ? "Verify your email with Google, then enter your company details here."
                    : "New here? Google will guide you through workspace setup."}
                </p>
              </div>
            )}
          {(mode === "activate" || mode === "register" || mode === "login") && (
            <details className="resend">
              <summary>Need a new activation email?</summary>
              <form className="form-stack" onSubmit={resend}>
                <Field
                  label="Account email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                <Button busy={busy} variant="secondary">
                  Resend activation
                </Button>
              </form>
            </details>
          )}
          {activation && !success && (
            <Link className="text-link" href="/login">
              Already activated? Sign in <ArrowRight size={14} />
            </Link>
          )}
          <div className="auth-footnote">
            <ShieldCheck size={15} />
            <span>Your company’s data deserves a dedicated home.</span>
          </div>
          {mode === "login" && (
            <Link className="text-link" href="/admin">
              Platform admin sign in
            </Link>
          )}
        </div>
        <footer className="auth-bottom">
          <span>© {new Date().getFullYear()} DataVault</span>
          <span>Clarity. Control. Confidence.</span>
        </footer>
      </section>
    </main>
  );
}
