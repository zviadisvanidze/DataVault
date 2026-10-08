export const money = (cents) =>
  typeof cents === "number"
    ? new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: cents % 100 ? 2 : 0,
      }).format(cents / 100)
    : "—";
export const date = (value) =>
  value
    ? new Date(value).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "—";
export const bytes = (value) =>
  value >= 1048576
    ? `${(value / 1048576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(value / 1024))} KB`;
export const initials = (value = "") =>
  value
    .split(/[ @]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0])
    .join("")
    .toUpperCase() || "DV";
export const fileUsage = (subscription) => subscription?.storedFiles ?? 0;
export function filterFiles(
  files,
  { search = "", type = "", visibility = "", sort = "newest" },
) {
  return files
    .filter(
      (f) =>
        f.originalFilename.toLowerCase().includes(search.toLowerCase()) &&
        (!type || f.fileType === type) &&
        (!visibility || f.visibility === visibility),
    )
    .sort((a, b) =>
      sort === "name"
        ? a.originalFilename.localeCompare(b.originalFilename)
        : sort === "size"
          ? b.size - a.size
          : new Date(b.createdAt) - new Date(a.createdAt),
    );
}
