"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  FileUp,
  Search,
  SlidersHorizontal,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { collection, request, upload } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useResource } from "@/lib/hooks";
import { bytes, date, fileUsage, filterFiles } from "@/lib/utils";
import {
  Alert,
  Button,
  Confirm,
  Empty,
  ErrorState,
  Field,
  FileIcon,
  Loading,
  Modal,
  PageHeading,
  Progress,
  useToast,
  Visibility,
} from "@/components/ui";
import { useWorkspace } from "@/components/layout/shell";
export function FileTable({ files, users = [], onSelect, compact = false }) {
  const { user } = useAuth();
  const uploader = (id) =>
    id === user._id
      ? "You"
      : users.find((u) => u._id === id)?.fullName ||
        users.find((u) => u._id === id)?.email ||
        "Company member";
  return (
    <div className="table-scroll">
      <table className="file-table">
        <thead>
          <tr>
            <th>File name</th>
            <th>Uploaded by</th>
            <th>Date added</th>
            <th>Visibility</th>
            <th>
              <span className="sr-only">Details</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {files.map((file) => (
            <tr key={file.id}>
              <td>
                <button className="file-name" onClick={() => onSelect(file)}>
                  <FileIcon type={file.fileType} />
                  <span>
                    <strong>{file.originalFilename}</strong>
                    <small>
                      {bytes(file.size)} · {file.fileType.toUpperCase()}
                    </small>
                  </span>
                </button>
              </td>
              <td>{uploader(file.uploaderId)}</td>
              <td>{date(file.createdAt)}</td>
              <td>
                <Visibility value={file.visibility} />
              </td>
              <td>
                <button
                  className="icon-button"
                  aria-label={`View ${file.originalFilename}`}
                  onClick={() => onSelect(file)}
                >
                  <ArrowRight size={17} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function Permissions({
  value,
  onChange,
  users,
  isAdmin,
  user,
  legend = "Who can access this file?",
}) {
  const [search, setSearch] = useState("");
  const employees = users.filter((u) => u.role === "company_member");
  return (
    <fieldset className="permissions">
      <legend>{legend}</legend>
      {[
        [
          "company_wide",
          "Everyone in the company",
          "A shared resource for your whole workspace.",
        ],
        [
          "restricted",
          "Selected employees only",
          "Only selected employees, the uploader, and administrators.",
        ],
      ].map(([id, title, help]) => (
        <label
          className={`radio-card ${value.visibility === id ? "selected" : ""}`}
          key={id}
        >
          <input
            type="radio"
            name="visibility"
            value={id}
            checked={value.visibility === id}
            onChange={() =>
              onChange({
                visibility: id,
                restrictedUserIds:
                  id === "company_wide" ? [] : value.restrictedUserIds,
              })
            }
          />
          <span>
            <strong>{title}</strong>
            <small>{help}</small>
          </span>
        </label>
      ))}
      {value.visibility === "restricted" && (
        <div className="employee-picker">
          {isAdmin ? (
            <>
              <div className="search-field">
                <Search size={15} />
                <input
                  aria-label="Search employees"
                  placeholder="Find an employee…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className="checkbox-list">
                {employees
                  .filter((u) =>
                    `${u.fullName} ${u.email}`
                      .toLowerCase()
                      .includes(search.toLowerCase()),
                  )
                  .map((u) => (
                    <label key={u._id}>
                      <input
                        type="checkbox"
                        checked={value.restrictedUserIds.includes(u._id)}
                        onChange={(e) =>
                          onChange({
                            ...value,
                            restrictedUserIds: e.target.checked
                              ? [...value.restrictedUserIds, u._id]
                              : value.restrictedUserIds.filter(
                                  (id) => id !== u._id,
                                ),
                          })
                        }
                      />
                      <span>
                        {u.fullName || u.email}
                        <small>{u.email}</small>
                      </span>
                    </label>
                  ))}
              </div>
              {!employees.length && (
                <p className="muted small">
                  Invite an employee before creating restricted access.
                </p>
              )}
            </>
          ) : (
            <>
              <p className="muted small">
                The employee directory is available to administrators. You can
                retain existing recipients or restrict a file to yourself. Ask
                an administrator to add other employees.
              </p>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={value.restrictedUserIds.includes(user._id)}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      restrictedUserIds: e.target.checked
                        ? [...value.restrictedUserIds, user._id]
                        : value.restrictedUserIds.filter(
                            (id) => id !== user._id,
                          ),
                    })
                  }
                />
                Include me
              </label>
              {value.restrictedUserIds
                .filter((id) => id !== user._id)
                .map((id) => (
                  <div className="chip" key={id}>
                    Employee {id.slice(-6)}
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="Remove recipient"
                      onClick={() =>
                        onChange({
                          ...value,
                          restrictedUserIds: value.restrictedUserIds.filter(
                            (v) => v !== id,
                          ),
                        })
                      }
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
            </>
          )}
          <small className="muted">
            {value.restrictedUserIds.length} selected · At least one employee
            required
          </small>
        </div>
      )}
    </fieldset>
  );
}
export function FileDetail({ file, users = [], onClose, onChanged }) {
  const { user, isAdmin } = useAuth(),
    toast = useToast();
  const detail = useResource(
    (signal) => request(`/files/${file.id}`, { signal }),
    [file.id],
  );
  const [permissions, setPermissions] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(null),
    [deleting, setDeleting] = useState(false);
  useEffect(() => {
    if (detail.data)
      setPermissions({
        visibility: detail.data.visibility,
        restrictedUserIds: detail.data.restrictedUserIds,
      });
  }, [detail.data]);
  const canEdit = isAdmin || file.uploaderId === user._id;
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await request(`/files/${file.id}/permissions`, {
        method: "PATCH",
        body: permissions,
      });
      toast("File access updated");
      onChanged();
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function download() {
    setBusy(true);
    setError(null);
    try {
      const blob = await request(`/files/${file.id}/download`, {
        binary: true,
      });
      const url = URL.createObjectURL(blob),
        anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.originalFilename;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Modal title="File details" onClose={onClose} busy={busy}>
        <div className="detail-file">
          <FileIcon type={file.fileType} />
          <div>
            <h3>{file.originalFilename}</h3>
            <p>
              {bytes(file.size)} · Added {date(file.createdAt)}
            </p>
          </div>
        </div>
        <Alert>{error?.message}</Alert>
        {detail.loading ? (
          <Loading label="Loading file access" />
        ) : detail.error ? (
          <ErrorState error={detail.error} retry={detail.reload} />
        ) : (
          <>
            <div className="detail-meta">
              <span>Last updated</span>
              <strong>{date(detail.data.updatedAt)}</strong>
              <span>Visibility</span>
              <Visibility value={detail.data.visibility} />
            </div>
            {canEdit && permissions && (
              <Permissions
                value={permissions}
                onChange={setPermissions}
                users={users}
                isAdmin={isAdmin}
                user={user}
              />
            )}
            <div className="modal-actions">
              <Button busy={busy} variant="secondary" onClick={download}>
                <ArrowDownToLine size={16} />
                Download
              </Button>
              {canEdit && (
                <Button
                  busy={busy}
                  disabled={
                    !permissions ||
                    (permissions.visibility === "restricted" &&
                      !permissions.restrictedUserIds.length)
                  }
                  onClick={save}
                >
                  Save access
                </Button>
              )}
            </div>
            {canEdit && (
              <button className="danger-link" onClick={() => setDeleting(true)}>
                <Trash2 size={15} />
                Delete file
              </button>
            )}
          </>
        )}
      </Modal>
      {deleting && (
        <Confirm
          title="Delete this file?"
          description={`“${file.originalFilename}” will be permanently removed from your company’s vault. This cannot be undone.`}
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            await request(`/files/${file.id}`, { method: "DELETE" });
            toast("File deleted");
            onChanged();
            onClose();
          }}
        />
      )}
    </>
  );
}
function UploadDialog({ users, onClose, onUploaded }) {
  const { user, isAdmin } = useAuth(),
    { subscription } = useWorkspace(),
    toast = useToast();
  const [files, setFiles] = useState([]),
    [permissions, setPermissions] = useState({
      visibility: "company_wide",
      restrictedUserIds: [],
    }),
    [progress, setProgress] = useState(0),
    [activeId, setActiveId] = useState(null),
    [activeNumber, setActiveNumber] = useState(0),
    [activeTotal, setActiveTotal] = useState(0),
    [uploadedCount, setUploadedCount] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(null),
    [dragging, setDragging] = useState(false);
  const controller = useRef(null),
    input = useRef(null),
    stopped = useRef(false),
    nextId = useRef(0),
    initialStored = useRef(fileUsage(subscription));
  useEffect(() => () => controller.current?.abort(), []);
  function choose(selected) {
    const picked = Array.from(selected || []);
    if (!picked.length) return;
    const invalid = picked.find(
      (file) => !/\.(csv|xlsx?)$/i.test(file.name) || !file.size,
    );
    if (invalid) {
      setError(
        new Error(
          `“${invalid.name}” is empty or unsupported. Choose non-empty CSV, XLS, or XLSX files.`,
        ),
      );
      return;
    }
    if (
      remainingSlots !== null &&
      pending.length + picked.length > remainingSlots
    ) {
      setError(
        new Error(
          `Only ${Math.max(0, remainingSlots - pending.length)} more ${remainingSlots - pending.length === 1 ? "file fits" : "files fit"} on your current plan. Nothing from this selection was added.`,
        ),
      );
      return;
    }
    setError(null);
    setFiles((current) => [
      ...current,
      ...picked.map((file) => ({
        id: ++nextId.current,
        file,
        status: "ready",
        message: "",
      })),
    ]);
  }
  async function send() {
    const candidates = files.filter(
      (item) => item.status === "ready" || item.status === "failed",
    );
    if (!candidates.length) return;
    setBusy(true);
    setError(null);
    setProgress(0);
    setActiveTotal(candidates.length);
    stopped.current = false;
    let succeeded = 0,
      failed = 0,
      interrupted = false;
    try {
      // The workspace summary can be stale if another person just uploaded a file.
      const current = await request("/subscriptions/current");
      if (
        current.plan.extraFilePriceCents === null &&
        candidates.length >
          Math.max(0, current.plan.includedFilesPerMonth - fileUsage(current))
      ) {
        setError(
          new Error(
            "Your available file slots changed. Refresh the vault or remove files from this batch before trying again.",
          ),
        );
        onUploaded();
        return;
      }
      for (const [index, item] of candidates.entries()) {
        if (stopped.current) {
          interrupted = true;
          break;
        }
        const activeController = new AbortController();
        controller.current = activeController;
        setActiveId(item.id);
        setActiveNumber(index + 1);
        setProgress(0);
        setFiles((currentFiles) =>
          currentFiles.map((entry) =>
            entry.id === item.id ? { ...entry, status: "uploading" } : entry,
          ),
        );
        try {
          await upload(
            item.file,
            permissions,
            setProgress,
            activeController.signal,
          );
          succeeded++;
          setUploadedCount((count) => count + 1);
          setFiles((currentFiles) =>
            currentFiles.map((entry) =>
              entry.id === item.id ? { ...entry, status: "success" } : entry,
            ),
          );
        } catch (uploadError) {
          const uncertain =
            stopped.current ||
            activeController.signal.aborted ||
            uploadError.status === 0;
          setFiles((currentFiles) =>
            currentFiles.map((entry) =>
              entry.id === item.id
                ? {
                    ...entry,
                    status: uncertain ? "uncertain" : "failed",
                    message: uncertain
                      ? "Check the vault before retrying; this file may already have been saved."
                      : uploadError.message,
                  }
                : entry,
            ),
          );
          if (stopped.current || activeController.signal.aborted)
            interrupted = true;
          else failed++;
          // Capacity, storage, or connection failures usually affect the rest too.
          if (uncertain || [401, 403, 429, 503].includes(uploadError.status))
            break;
        } finally {
          controller.current = null;
        }
      }
    } catch (e) {
      setError(e);
    } finally {
      if (succeeded || failed || interrupted) onUploaded();
      if (interrupted)
        setError(
          new Error(
            "Upload stopped. The vault has been refreshed; check it before retrying the interrupted file.",
          ),
        );
      else if (failed)
        setError(
          new Error(
            `${succeeded} ${succeeded === 1 ? "file was" : "files were"} uploaded; ${failed} ${failed === 1 ? "file needs" : "files need"} attention. Review the list below.`,
          ),
        );
      else if (succeeded === candidates.length) {
        toast(
          succeeded === 1
            ? "File added to your vault"
            : `${succeeded} files added to your vault`,
        );
        onClose();
      }
      setBusy(false);
      setActiveId(null);
      setActiveNumber(0);
      setActiveTotal(0);
    }
  }
  const stored = Math.max(
      fileUsage(subscription),
      initialStored.current + uploadedCount,
    ),
    hardLimit = subscription?.plan.extraFilePriceCents === null,
    allowance = subscription?.plan.includedFilesPerMonth,
    remainingSlots =
      hardLimit && allowance != null ? Math.max(0, allowance - stored) : null,
    pending = files.filter(
      (item) => item.status === "ready" || item.status === "failed",
    ),
    overLimit = remainingSlots !== null && pending.length > remainingSlots;
  return (
    <Modal title="Add files to your vault" onClose={onClose} busy={busy} wide>
      <Alert>{error?.message}</Alert>
      <div
        className={`dropzone ${dragging ? "dragging" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!busy) choose(e.dataTransfer.files);
        }}
      >
        <FileUp size={30} />
        <h3>Drop your files here</h3>
        <p>CSV, XLS, or XLSX · Select multiple files at once</p>
        <input
          ref={input}
          type="file"
          multiple
          accept=".csv,.xls,.xlsx"
          className="sr-only"
          aria-label="Choose files"
          disabled={busy}
          onChange={(e) => {
            choose(e.target.files);
            e.target.value = "";
          }}
        />
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => input.current.click()}
        >
          {files.length ? "Add more files" : "Browse files"}
        </Button>
      </div>
      {files.length > 0 && (
        <section
          className="upload-queue"
          aria-label="Files selected for upload"
        >
          <div className="upload-queue-heading">
            <strong>{files.length} selected</strong>
            <span>{pending.length} ready to upload</span>
          </div>
          <ul>
            {files.map((item) => (
              <li
                key={item.id}
                className={
                  item.status === "failed" || item.status === "uncertain"
                    ? "has-error"
                    : ""
                }
              >
                <FileIcon
                  type={item.file.name.split(".").pop().toLowerCase()}
                />
                <span className="upload-queue-details">
                  <strong>{item.file.name}</strong>
                  <small>
                    {bytes(item.file.size)} ·{" "}
                    {item.status === "uploading"
                      ? `Uploading ${progress}%`
                      : item.status === "success"
                        ? "Uploaded"
                        : item.status === "failed" ||
                            item.status === "uncertain"
                          ? item.message
                          : "Ready"}
                  </small>
                </span>
                {item.status === "success" ? (
                  <Check
                    size={18}
                    className="upload-queue-success"
                    aria-label="Uploaded"
                  />
                ) : (
                  !busy && (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Remove ${item.file.name}`}
                      onClick={() => {
                        setFiles((current) =>
                          current.filter((entry) => entry.id !== item.id),
                        );
                        setError(null);
                      }}
                    >
                      <X size={16} />
                    </button>
                  )
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="small muted">
        {stored} / {allowance ?? "—"} files stored. Deleting a file frees a
        slot.{" "}
        {remainingSlots === null
          ? "Files above the included allowance may have a plan charge."
          : `${remainingSlots} ${remainingSlots === 1 ? "slot" : "slots"} available.`}
      </p>
      {remainingSlots === 0 && (
        <Alert>
          Your vault is full. Delete a file or change your plan to add another.
        </Alert>
      )}
      {overLimit && (
        <Alert>
          This batch exceeds your available file slots. Remove files before
          uploading.
        </Alert>
      )}
      <p className="small muted">
        Visibility below applies to every file in this batch.
      </p>
      <Permissions
        value={permissions}
        onChange={setPermissions}
        users={users}
        isAdmin={isAdmin}
        user={user}
        legend="Who can access these files?"
      />
      {busy && (
        <div role="status" aria-live="polite">
          <Progress value={progress} max={100} label="Upload progress" />
          <p className="small muted">
            {activeId
              ? `File ${activeNumber} of ${activeTotal} · ${progress === 100 ? "Transferred; waiting for the server…" : `Uploading ${progress}%`}`
              : "Checking your available file slots…"}
          </p>
          <Button
            variant="secondary"
            onClick={() => {
              stopped.current = true;
              controller.current?.abort();
            }}
          >
            Stop uploads
          </Button>
        </div>
      )}
      <div className="modal-actions">
        <Button
          busy={busy}
          disabled={
            !pending.length ||
            overLimit ||
            !subscription ||
            (permissions.visibility === "restricted" &&
              !permissions.restrictedUserIds.length)
          }
          onClick={send}
        >
          <Upload size={16} />
          {pending.length === 0
            ? "Upload files"
            : pending.length === 1
              ? "Upload file"
              : `Upload ${pending.length} files`}
        </Button>
      </div>
    </Modal>
  );
}
export default function FilesPage() {
  const { isAdmin } = useAuth(),
    { reload: reloadWorkspace } = useWorkspace();
  const files = useResource(
    (signal) => collection("/files", "files", signal),
    [],
  );
  const people = useResource(
    (signal) =>
      isAdmin ? collection("/users", "users", signal) : Promise.resolve([]),
    [isAdmin],
  );
  const [filters, setFilters] = useState({
      search: "",
      type: "",
      visibility: "",
      sort: "newest",
    }),
    [selected, setSelected] = useState(null),
    [uploading, setUploading] = useState(false);
  useEffect(() => {
    setFilters((f) => ({
      ...f,
      search: new URLSearchParams(window.location.search).get("q") || "",
    }));
  }, []);
  const change = (key, value) => setFilters((f) => ({ ...f, [key]: value }));
  const visible = filterFiles(files.data || [], filters);
  const reload = () => {
    files.reload();
    reloadWorkspace();
  };
  return (
    <>
      <PageHeading
        eyebrow="YOUR COMPANY’S KNOWLEDGE, TOGETHER"
        title="The file vault"
        description="A single home for the data that keeps your business moving."
        action={
          <Button onClick={() => setUploading(true)}>
            <Upload size={17} />
            Upload file
          </Button>
        }
      />
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>
              All files{" "}
              <span className="count">{files.data?.length ?? "—"}</span>
            </h2>
            <p>Only files you have access to appear here.</p>
          </div>
          <SlidersHorizontal size={18} />
        </div>
        <div className="file-filters">
          <div className="search-field">
            <Search size={17} />
            <input
              placeholder="Search file names…"
              aria-label="Search file names"
              value={filters.search}
              onChange={(e) => change("search", e.target.value)}
            />
          </div>
          <select
            aria-label="File type"
            value={filters.type}
            onChange={(e) => change("type", e.target.value)}
          >
            <option value="">All formats</option>
            <option value="csv">CSV</option>
            <option value="xls">XLS</option>
            <option value="xlsx">XLSX</option>
          </select>
          <select
            aria-label="Visibility"
            value={filters.visibility}
            onChange={(e) => change("visibility", e.target.value)}
          >
            <option value="">All access</option>
            <option value="company_wide">Company-wide</option>
            <option value="restricted">Restricted</option>
          </select>
          <select
            aria-label="Sort files"
            value={filters.sort}
            onChange={(e) => change("sort", e.target.value)}
          >
            <option value="newest">Newest first</option>
            <option value="name">Name A–Z</option>
            <option value="size">Largest first</option>
          </select>
        </div>
        {files.loading ? (
          <Loading label="Loading your files" />
        ) : files.error ? (
          <ErrorState error={files.error} retry={files.reload} />
        ) : visible.length ? (
          <FileTable
            files={visible}
            users={people.data || []}
            onSelect={setSelected}
          />
        ) : files.data?.length ? (
          <Empty
            title="No matching files"
            description="Try a different name, format, or visibility filter."
          >
            <Button
              variant="secondary"
              onClick={() =>
                setFilters({
                  search: "",
                  type: "",
                  visibility: "",
                  sort: "newest",
                })
              }
            >
              Clear filters
            </Button>
          </Empty>
        ) : (
          <Empty>
            <Button onClick={() => setUploading(true)}>
              Upload your first file
            </Button>
          </Empty>
        )}
        <div className="table-footer">
          <span>
            {visible.length} files{" "}
            {filters.search || filters.type || filters.visibility
              ? "matching your filters"
              : "in your view"}
          </span>
          <span>CSV / XLS / XLSX</span>
        </div>
      </section>
      {selected && (
        <FileDetail
          file={selected}
          users={people.data || []}
          onClose={() => setSelected(null)}
          onChanged={reload}
        />
      )}{" "}
      {uploading && (
        <UploadDialog
          users={people.data || []}
          onClose={() => setUploading(false)}
          onUploaded={reload}
        />
      )}
    </>
  );
}
