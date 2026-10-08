"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useState } from "react";
import {
  ArrowUpRight,
  ChevronRight,
  CreditCard,
  Files,
  LayoutGrid,
  LogOut,
  Menu,
  MessageSquare,
  Search,
  Settings,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { request } from "@/lib/api";
import { useResource } from "@/lib/hooks";
import { fileUsage, initials } from "@/lib/utils";
import { Button, ErrorState, Loading, Logo, Progress } from "@/components/ui";
import DataAtmosphere from "./data-atmosphere";
import { paymentReturnPaths } from "@/lib/payments";
const WorkspaceContext = createContext(null);
export const useWorkspace = () => useContext(WorkspaceContext);
const navigation = [
  ["/dashboard", "Overview", LayoutGrid],
  ["/dashboard/files", "Files", Files],
  ["/dashboard/employees", "Employees", Users],
  ["/dashboard/billing", "Billing", CreditCard],
  ["/dashboard/settings", "Settings", Settings],
];
export default function Shell({ children }) {
  const auth = useAuth(),
    router = useRouter(),
    pathname = usePathname();
  useEffect(() => {
    if (!auth.loading && !auth.user && !auth.error)
      router.replace(
        paymentReturnPaths.includes(pathname)
          ? `/login?next=${encodeURIComponent(pathname)}`
          : "/login",
      );
  }, [auth.loading, auth.user, auth.error, router, pathname]);
  if (auth.loading)
    return (
      <main className="center-screen">
        <Logo />
        <Loading />
      </main>
    );
  if (auth.error)
    return (
      <main className="center-screen">
        <Logo />
        <ErrorState error={auth.error} retry={auth.restore} />
        <Button variant="secondary" onClick={auth.logout}>
          Return to sign in
        </Button>
      </main>
    );
  if (!auth.user) return <Loading label="Returning to sign in" />;
  return <AuthenticatedShell>{children}</AuthenticatedShell>;
}
function AuthenticatedShell({ children }) {
  const { user, isAdmin, logout } = useAuth(),
    pathname = usePathname(),
    router = useRouter(),
    [open, setOpen] = useState(false);
  const workspace = useResource(
    async (signal) => {
      const [company, subscription] = await Promise.all([
        request("/companies/current", { signal }),
        request("/subscriptions/current", { signal }),
      ]);
      return { company, subscription };
    },
    [user._id],
  );
  const company = workspace.data?.company,
    subscription = workspace.data?.subscription;
  useEffect(() => setOpen(false), [pathname]);
  const nav = navigation.filter((item) => isAdmin || item[1] !== "Employees");
  function exit() {
    logout();
    router.replace("/login");
  }
  const sidebar = (
    <>
      <Link href="/dashboard" className="sidebar-brand">
        <Logo />
      </Link>
      <div className="workspace-identity">
        <span className="workspace-avatar">{initials(company?.name)}</span>
        <div>
          <strong>{company?.name || "Your workspace"}</strong>
          <small>Company workspace</small>
        </div>
        <ShieldCheck size={16} />
      </div>
      <span className="nav-label">WORKSPACE</span>
      <nav aria-label="Main navigation">
        {nav.map(([href, label, Icon]) => (
          <Link
            key={href}
            href={href}
            onClick={() => setOpen(false)}
            aria-current={
              pathname === href ||
              (label === "Billing" && pathname.startsWith("/payments/"))
                ? "page"
                : undefined
            }
            className={
              pathname === href ||
              (label === "Billing" && pathname.startsWith("/payments/"))
                ? "active"
                : ""
            }
          >
            <Icon size={18} />
            {label}
            {pathname === href && <span className="nav-dot" />}
          </Link>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <div className="sidebar-plan">
          <div className="between">
            <span className="eyebrow">
              {subscription?.plan.name || "YOUR"} PLAN
            </span>
            <span className="mini-dot" />
          </div>
          <p>
            <strong>{fileUsage(subscription) ?? "—"}</strong> /{" "}
            {subscription?.plan.includedFilesPerMonth ?? "—"} files stored
          </p>
          <Progress
            value={fileUsage(subscription) || 0}
            max={subscription?.plan.includedFilesPerMonth || 1}
            label="Stored file usage"
          />
          <Link href="/dashboard/billing">
            {isAdmin ? "Manage your plan" : "View your plan"}{" "}
            <ArrowUpRight size={14} />
          </Link>
        </div>
        <Link href="/dashboard/settings" className="user-profile">
          <span className="avatar">
            {initials(user.fullName || user.email)}
          </span>
          <span>
            <strong>{user.fullName || user.email}</strong>
            <small>{isAdmin ? "Administrator" : "Employee"}</small>
          </span>
          <ChevronRight size={15} />
        </Link>
        <button onClick={exit} className="signout">
          <LogOut size={15} /> Sign out
        </button>
      </div>
    </>
  );
  return (
    <WorkspaceContext.Provider value={{ ...workspace, company, subscription }}>
      <div className="app-shell">
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <aside className="sidebar">{sidebar}</aside>
        {open && (
          <MobileNav onClose={() => setOpen(false)}>{sidebar}</MobileNav>
        )}
        <div className="app-content">
          <DataAtmosphere />
          <header className="topbar">
            <div className="breadcrumb">
              <button
                className="icon-button mobile-menu"
                aria-label="Open navigation"
                onClick={() => setOpen(true)}
              >
                <Menu size={21} />
              </button>
              <span>Workspace</span>
              <ChevronRight size={13} />
              <strong>
                {pathname.startsWith("/payments/")
                  ? "Billing"
                  : navigation.find((n) => n[0] === pathname)?.[1] ||
                    "Overview"}
              </strong>
            </div>
            <form className="global-search" action="/dashboard/files">
              <Search size={16} />
              <input
                name="q"
                aria-label="Search files"
                placeholder="Find something in your vault…"
              />
              <kbd>↵</kbd>
            </form>
            <Link
              href="/dashboard/settings"
              className="top-avatar"
              aria-label="Your profile"
            >
              {initials(user.fullName || user.email)}
            </Link>
          </header>
          <main id="main" className="page-content">
            {workspace.error && (
              <div className="shell-error">
                <span>{workspace.error.message}</span>
                <Button variant="secondary" onClick={workspace.reload}>
                  Reconnect
                </Button>
              </div>
            )}
            {children}
          </main>
          <footer className="app-footer">
            <span>
              <ShieldCheck size={13} /> Your workspace. Your control.
            </span>
            <span>DATAVAULT / {new Date().getFullYear()}</span>
          </footer>
        </div>
      </div>
    </WorkspaceContext.Provider>
  );
}
function MobileNav({ onClose, children }) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);
  return (
    <dialog
      open
      className="mobile-drawer"
      ref={(node) => {
        if (node && !node.matches(":modal")) {
          node.close();
          node.showModal();
        }
      }}
      onCancel={onClose}
    >
      <button
        className="icon-button drawer-close"
        aria-label="Close navigation"
        onClick={onClose}
      >
        <X size={20} />
      </button>
      {children}
    </dialog>
  );
}
