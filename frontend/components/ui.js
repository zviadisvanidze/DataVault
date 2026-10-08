"use client";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useId,
} from "react";
import {
  ArrowUpRight,
  Check,
  CheckCircle2,
  FileSpreadsheet,
  Loader2,
  LockKeyhole,
  ShieldCheck,
  X,
} from "lucide-react";
export function Logo({ light = false }) {
  return (
    <div className={`logo ${light ? "light" : ""}`}>
      <span className="logo-mark">
        <span />
        <span />
        <span />
      </span>
      DataVault
    </div>
  );
}
export function Button({
  children,
  busy,
  variant = "primary",
  className = "",
  ...props
}) {
  return (
    <button
      className={`button ${variant} ${className}`}
      {...props}
      disabled={props.disabled || busy}
    >
      {busy && <Loader2 size={16} className="spin" />}
      {children}
    </button>
  );
}
export function Field({ label, error, hint, children, ...props }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children ? (
        children(id)
      ) : (
        <input
          id={id}
          aria-invalid={!!error}
          aria-describedby={error || hint ? `${id}-help` : undefined}
          {...props}
        />
      )}{" "}
      {(error || hint) && (
        <small id={`${id}-help`} className={error ? "field-error" : "muted"}>
          {error || hint}
        </small>
      )}
    </div>
  );
}
export function Alert({ children, type = "error" }) {
  return children ? (
    <div
      className={`alert ${type}`}
      role={type === "error" ? "alert" : "status"}
    >
      {type === "success" ? (
        <CheckCircle2 size={18} />
      ) : (
        <ShieldCheck size={18} />
      )}
      <div>{children}</div>
    </div>
  ) : null;
}
export function Loading({ label = "Opening your workspace" }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 6500);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="loading-state" role="status">
      <Loader2 className="spin" size={24} />
      <strong>{label}</strong>
      <p>
        {slow
          ? "DataVault is waking up. The first connection may take a little longer."
          : "Connecting securely to DataVault…"}
      </p>
      <div className="skeleton" />
      <div className="skeleton short" />
    </div>
  );
}
export function ErrorState({ error, retry }) {
  return (
    <div className="empty-state">
      <ShieldCheck size={30} />
      <h3>We couldn’t load this view</h3>
      <p>{error?.message}</p>
      {retry && (
        <Button variant="secondary" onClick={retry}>
          Try again
        </Button>
      )}
    </div>
  );
}
export function Empty({
  title = "Your vault is empty",
  description = "Upload your first CSV, XLS, or XLSX file to get started.",
  children,
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <FileSpreadsheet size={27} />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {children}
    </div>
  );
}
export function Badge({ children, tone = "" }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function Visibility({ value }) {
  return (
    <Badge tone={value === "restricted" ? "amber" : "green"}>
      {value === "restricted" ? (
        <LockKeyhole size={12} />
      ) : (
        <ShieldCheck size={12} />
      )}{" "}
      {value === "restricted" ? "Restricted" : "Company-wide"}
    </Badge>
  );
}
export function FileIcon({ type = "csv" }) {
  return (
    <span className={`file-icon ${type}`}>
      <FileSpreadsheet size={21} />
      <small>{type.toUpperCase()}</small>
    </span>
  );
}
export function PageHeading({ eyebrow, title, description, action }) {
  return (
    <div className="page-heading">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
export function Progress({ value, max, label }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div
      className="progress"
      role="progressbar"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemax={Math.max(value, max)}
      aria-valuemin={0}
    >
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
  busy = false,
}) {
  const ref = useRef(null),
    id = useId();
  useEffect(() => {
    const dialog = ref.current,
      previous = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={wide ? "wide" : ""}
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current && !busy) onClose();
      }}
    >
      <header className="modal-header">
        <h2 id={id}>{title}</h2>
        <button
          type="button"
          disabled={busy}
          className="icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </header>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}
export function Confirm({
  title,
  description,
  label = "Delete",
  onConfirm,
  onClose,
  dangerous = true,
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(null);
  return (
    <Modal title={title} onClose={onClose} busy={busy}>
      <p>{description}</p>
      <Alert>{error?.message}</Alert>
      <div className="modal-actions">
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant={dangerous ? "danger" : "primary"}
          busy={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onConfirm();
              onClose();
            } catch (e) {
              setError(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          {label}
        </Button>
      </div>
    </Modal>
  );
}
const ToastContext = createContext(() => {});
export const useToast = () => useContext(ToastContext);
export function ToastProvider({ children }) {
  const [toast, setToast] = useState("");
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 6000);
    return () => clearTimeout(t);
  }, [toast]);
  return (
    <ToastContext.Provider value={setToast}>
      {children}
      {toast && (
        <div className="toast" role="status">
          <Check size={18} />
          {toast}
          <button
            aria-label="Dismiss notification"
            className="icon-button"
            onClick={() => setToast("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
    </ToastContext.Provider>
  );
}
