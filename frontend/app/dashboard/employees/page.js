"use client";
import { useState } from "react";
import { Mail, Pencil, Plus, RefreshCw, Trash2, Users } from "lucide-react";
import { collection, request } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useResource } from "@/lib/hooks";
import { date, initials } from "@/lib/utils";
import {
  Alert,
  Badge,
  Button,
  Confirm,
  Empty,
  ErrorState,
  Field,
  Loading,
  Modal,
  PageHeading,
  useToast,
} from "@/components/ui";
import { useWorkspace } from "@/components/layout/shell";
export default function Employees() {
  const { isAdmin } = useAuth();
  return isAdmin ? (
    <EmployeeManagement />
  ) : (
    <Empty
      title="Administrator access required"
      description="Only workspace administrators can manage employees and invitations."
    />
  );
}
function EmployeeManagement() {
  const { reload: reloadWorkspace, subscription } = useWorkspace(),
    toast = useToast();
  const users = useResource(
      (signal) => collection("/users", "users", signal),
      [],
    ),
    invitations = useResource(
      (signal) => collection("/invitations", "invitations", signal),
      [],
    );
  const [invite, setInvite] = useState(false),
    [selectedUser, setSelectedUser] = useState(null),
    [confirm, setConfirm] = useState(null),
    [error, setError] = useState(null),
    [resending, setResending] = useState(null);
  const reload = () => {
    users.reload();
    invitations.reload();
    reloadWorkspace();
  };
  async function resend(id) {
    setResending(id);
    setError(null);
    try {
      await request(`/invitations/${id}/resend`, { method: "POST" });
      toast("A new invitation email has been requested, if eligible.");
      invitations.reload();
    } catch (e) {
      setError(e);
    } finally {
      setResending(null);
    }
  }
  return (
    <>
      <PageHeading
        eyebrow="GOOD WORK HAPPENS TOGETHER"
        title="Your people"
        description="Give your team a shared home for their data."
        action={
          <Button onClick={() => setInvite(true)}>
            <Plus size={17} />
            Invite employee
          </Button>
        }
      />
      <div className="team-summary">
        <span className="large-icon">
          <Users size={23} />
        </span>
        <div>
          <strong>{subscription?.employeeCount ?? "—"} employees</strong>
          <p>
            {subscription?.plan.maxEmployees === null
              ? "Unlimited employee seats"
              : `Up to ${subscription?.plan.maxEmployees ?? "—"} employees on your plan`}{" "}
            · Company owner has a separate seat
          </p>
        </div>
        <Badge>{subscription?.plan.name || "Current"} plan</Badge>
      </div>
      <Alert>{error?.message}</Alert>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>
              Workspace members{" "}
              <span className="count">{users.data?.length ?? "—"}</span>
            </h2>
            <p>People with active access to your company’s workspace.</p>
          </div>
        </div>
        {users.loading ? (
          <Loading label="Loading your team" />
        ) : users.error ? (
          <ErrorState error={users.error} retry={users.reload} />
        ) : (
          <>
            {users.data.filter((u) => u.role === "company_member").length ===
              0 && (
              <div className="inline-empty">
                <strong>No employees yet</strong>
                <p>Invite your team to start sharing company data securely.</p>
              </div>
            )}
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th>Date added</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.data.map((u) => (
                    <tr key={u._id}>
                      <td>
                        <div className="person">
                          <span className="avatar">
                            {initials(u.fullName || u.email)}
                          </span>
                          <span>
                            <strong>{u.fullName || "Workspace member"}</strong>
                            <small>{u.email}</small>
                          </span>
                        </div>
                      </td>
                      <td>
                        {u.role === "company_owner"
                          ? "Administrator"
                          : "Employee"}
                      </td>
                      <td>
                        <Badge tone="green">Active</Badge>
                      </td>
                      <td>{date(u.createdAt)}</td>
                      <td>
                        {u.role !== "company_owner" ? (
                          <div className="row-actions">
                            <button
                              className="icon-button"
                              aria-label={`Edit ${u.email}`}
                              onClick={() => setSelectedUser(u._id)}
                            >
                              <Pencil size={16} />
                            </button>
                            <button
                              className="icon-button danger-text"
                              aria-label={`Delete ${u.email}`}
                              onClick={() =>
                                setConfirm({
                                  title: "Remove this employee?",
                                  description: `${u.email} will lose access to this workspace. This cannot be undone.`,
                                  path: `/users/${u._id}`,
                                  label: "Remove employee",
                                })
                              }
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                        ) : (
                          <span className="muted small">Owner</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
      <section className="panel section-space">
        <div className="panel-heading">
          <div>
            <h2>
              Pending invitations{" "}
              <span className="count">{invitations.data?.length ?? "—"}</span>
            </h2>
            <p>
              Invitations expire after 72 hours. Resending is subject to a
              cooldown.
            </p>
          </div>
          <Mail size={20} />
        </div>
        {invitations.loading ? (
          <Loading label="Loading invitations" />
        ) : invitations.error ? (
          <ErrorState error={invitations.error} retry={invitations.reload} />
        ) : !invitations.data.length ? (
          <Empty
            title="No pending invitations"
            description="New invitations will appear here until accepted or expired."
          />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Status</th>
                  <th>Expires</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {invitations.data.map((i) => (
                  <tr key={i.id}>
                    <td>{i.email}</td>
                    <td>
                      <Badge tone="amber">Pending invitation</Badge>
                    </td>
                    <td>{date(i.expiresAt)}</td>
                    <td>
                      <div className="row-actions">
                        <Button
                          variant="secondary"
                          busy={resending === i.id}
                          disabled={!!resending}
                          onClick={() => resend(i.id)}
                        >
                          <RefreshCw size={13} />
                          Resend
                        </Button>
                        <button
                          className="icon-button"
                          aria-label={`Revoke invitation for ${i.email}`}
                          onClick={() =>
                            setConfirm({
                              title: "Revoke this invitation?",
                              description: `The invitation for ${i.email} will no longer work.`,
                              path: `/invitations/${i.id}`,
                              label: "Revoke invitation",
                            })
                          }
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {invite && (
        <InviteDialog onClose={() => setInvite(false)} onChanged={reload} />
      )}{" "}
      {selectedUser && (
        <EmployeeDetail
          key={selectedUser}
          id={selectedUser}
          onClose={() => setSelectedUser(null)}
          onSaved={() => {
            users.reload();
            setSelectedUser(null);
            toast("Employee name updated");
          }}
        />
      )}{" "}
      {confirm && (
        <Confirm
          {...confirm}
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            await request(confirm.path, { method: "DELETE" });
            toast("Workspace updated");
            reload();
          }}
        />
      )}
    </>
  );
}
function EmployeeDetail({ id, onClose, onSaved }) {
  const employee = useResource(
    (signal) => request(`/users/${id}`, { signal }),
    [id],
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(null);
  return (
    <Modal title="Employee details" onClose={onClose} busy={busy}>
      {employee.loading ? (
        <Loading label="Loading employee details" />
      ) : employee.error ? (
        <ErrorState error={employee.error} retry={employee.reload} />
      ) : (
        <form
          className="form-stack"
          onSubmit={async (event) => {
            event.preventDefault();
            const fullName = String(
              new FormData(event.currentTarget).get("fullName") || "",
            ).trim();
            setBusy(true);
            setError(null);
            try {
              await request(`/users/${id}`, {
                method: "PATCH",
                body: { fullName },
              });
              onSaved();
            } catch (failure) {
              setError(failure);
            } finally {
              setBusy(false);
            }
          }}
        >
          <p className="muted small">
            {employee.data.email} · Employee · Joined{" "}
            {date(employee.data.createdAt)}
          </p>
          <Alert>{error?.message}</Alert>
          <Field
            name="fullName"
            label="Full name"
            defaultValue={employee.data.fullName}
            maxLength={100}
            required
            error={error?.fields?.fullName}
          />
          <div className="modal-actions">
            <Button variant="secondary" type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button busy={busy}>Save name</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
function InviteDialog({ onClose, onChanged }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(null),
    [sent, setSent] = useState(false);
  return (
    <Modal
      title={sent ? "Invitation requested" : "A place for your teammate"}
      onClose={onClose}
      busy={busy}
    >
      {sent ? (
        <>
          <Alert type="success">
            The invitation email has been requested. Your teammate can follow
            the link to set their password and join your company.
          </Alert>
          <Button onClick={onClose}>Done</Button>
        </>
      ) : (
        <form
          className="form-stack"
          onSubmit={async (e) => {
            e.preventDefault();
            const body = Object.fromEntries(new FormData(e.currentTarget));
            setBusy(true);
            setError(null);
            try {
              await request("/invitations", { method: "POST", body });
              setSent(true);
              onChanged();
            } catch (err) {
              setError(err);
              if (err.status === 503) onChanged();
            } finally {
              setBusy(false);
            }
          }}
        >
          <p>
            We’ll email an activation link. They’ll join as an employee and can
            access company-wide files and files shared with them.
          </p>
          <Alert>{error?.message}</Alert>
          <Field
            name="email"
            type="email"
            label="Employee email"
            placeholder="teammate@company.com"
            required
            error={error?.fields?.email}
          />
          <p className="muted small">
            Pending invitations count toward your plan’s employee limit.
          </p>
          <Button busy={busy}>
            <Mail size={16} />
            Send invitation
          </Button>
        </form>
      )}
    </Modal>
  );
}
