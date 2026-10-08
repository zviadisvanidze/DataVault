"use client";
import { useState, Children, cloneElement, isValidElement } from "react";
import { useRouter } from "next/navigation";
import { LockKeyhole, LogOut, ShieldCheck } from "lucide-react";
import { request } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { date } from "@/lib/utils";
import {
  NEW_PASSWORD_HINT,
  NEW_PASSWORD_MAX_LENGTH,
  NEW_PASSWORD_MIN_LENGTH,
  validNewPassword,
} from "@/lib/password-policy";
import {
  Alert,
  Badge,
  Button,
  Field,
  Loading,
  PageHeading,
  useToast,
} from "@/components/ui";
import { useWorkspace } from "@/components/layout/shell";
export default function Settings() {
  const { user, isAdmin, setUser, logout } = useAuth(),
    workspace = useWorkspace(),
    router = useRouter(),
    [tab, setTab] = useState("Profile");
  return (
    <>
      <PageHeading
        eyebrow="WORKSPACE / SETTINGS"
        title="Workspace settings"
        description="Your profile, company details, and account security."
      />
      <div className="tabs" aria-label="Settings sections">
        {["Profile", "Security", "Account"].map((t) => (
          <button
            key={t}
            aria-pressed={tab === t}
            className={t === tab ? "active" : ""}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === "Profile" && (
        <>
          <SettingsSection
            title="Your profile"
            description="How you appear to people in your workspace."
          >
            <SaveForm endpoint={`/users/${user._id}`} onSaved={setUser}>
              <Field
                label="Full name"
                name="fullName"
                defaultValue={user.fullName || ""}
                minLength={1}
                maxLength={100}
                required
              />
              <Field
                label="Email address"
                type="email"
                value={user.email}
                readOnly
                hint="Your account email cannot be changed here."
              />
            </SaveForm>
          </SettingsSection>
          <SettingsSection
            title="Company profile"
            description={
              isAdmin
                ? "Keep the details behind your workspace up to date."
                : "Your administrator manages your company profile."
            }
          >
            {workspace.loading ? (
              <Loading label="Loading company profile" />
            ) : workspace.company ? (
              <SaveForm
                key={workspace.company.updatedAt}
                endpoint="/companies/current"
                readOnly={!isAdmin}
                onSaved={workspace.reload}
              >
                <Field
                  label="Company name"
                  name="name"
                  defaultValue={workspace.company.name}
                  minLength={2}
                  maxLength={100}
                  required
                  readOnly={!isAdmin}
                />
                <div className="form-grid">
                  <Field
                    label="Country"
                    name="country"
                    defaultValue={workspace.company.country}
                    pattern="[A-Za-z]{2}"
                    minLength={2}
                    maxLength={2}
                    required
                    readOnly={!isAdmin}
                    hint="Two-letter country code"
                  />
                  <Field
                    label="Industry"
                    name="industry"
                    defaultValue={workspace.company.industry}
                    minLength={2}
                    maxLength={100}
                    required
                    readOnly={!isAdmin}
                  />
                </div>
              </SaveForm>
            ) : (
              <p>Reconnect to load your company’s details.</p>
            )}
          </SettingsSection>
        </>
      )}
      {tab === "Security" && (
        <>
          <SettingsSection
            title="Change password"
            description="Use a unique password for your DataVault account."
          >
            <SaveForm
              endpoint="/users/me/password"
              reset
              message="Your password has been changed."
            >
              <Field
                label="Current password"
                type="password"
                name="currentPassword"
                required
                maxLength={NEW_PASSWORD_MAX_LENGTH}
                autoComplete="current-password"
              />
              <Field
                label="New password"
                type="password"
                name="newPassword"
                minLength={NEW_PASSWORD_MIN_LENGTH}
                maxLength={NEW_PASSWORD_MAX_LENGTH}
                required
                autoComplete="new-password"
                hint={NEW_PASSWORD_HINT}
              />
            </SaveForm>
          </SettingsSection>
          <div className="security-note">
            <ShieldCheck size={23} />
            <div>
              <h3>A dedicated session for your workspace</h3>
              <p>
                Your session stays in this browser tab and expires after one
                hour. Sign out when using a shared device.
              </p>
            </div>
          </div>
        </>
      )}
      {tab === "Account" && (
        <SettingsSection
          title="Your account"
          description="The essentials behind your access."
        >
          <dl className="account-details">
            <div>
              <dt>Role</dt>
              <dd>
                <Badge>{isAdmin ? "Administrator" : "Employee"}</Badge>
              </dd>
            </div>
            <div>
              <dt>Email</dt>
              <dd>{user.email}</dd>
            </div>
            <div>
              <dt>Joined</dt>
              <dd>{date(user.createdAt)}</dd>
            </div>
          </dl>
          <Button
            variant="secondary"
            onClick={() => {
              logout();
              router.replace("/login");
            }}
          >
            <LogOut size={16} />
            Sign out of DataVault
          </Button>
        </SettingsSection>
      )}
    </>
  );
}
function SettingsSection({ title, description, children }) {
  return (
    <section className="settings-section">
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      <div className="settings-form">{children}</div>
    </section>
  );
}
function fieldErrors(children, errors) {
  return Children.map(children, (child) => {
    if (!isValidElement(child)) return child;
    if (child.type === Field)
      return cloneElement(child, { error: errors?.[child.props.name] });
    return child.props.children
      ? cloneElement(child, {}, fieldErrors(child.props.children, errors))
      : child;
  });
}
function SaveForm({
  endpoint,
  children,
  onSaved,
  readOnly = false,
  reset = false,
  message = "Changes saved",
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(null),
    toast = useToast();
  return (
    <form
      className="form-stack"
      onSubmit={async (e) => {
        e.preventDefault();
        const form = e.currentTarget,
          body = Object.fromEntries(new FormData(form));
        if (
          endpoint === "/users/me/password" &&
          !validNewPassword(body.newPassword)
        ) {
          setError(new Error(NEW_PASSWORD_HINT));
          return;
        }
        setBusy(true);
        setError(null);
        try {
          const data = await request(endpoint, { method: "PATCH", body });
          onSaved?.(data);
          toast(message);
          if (reset) form.reset();
        } catch (err) {
          setError(err);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Alert>{error?.message}</Alert>
      {fieldErrors(children, error?.fields)}
      {!readOnly && (
        <div className="form-actions">
          <Button busy={busy}>Save changes</Button>
        </div>
      )}
    </form>
  );
}
