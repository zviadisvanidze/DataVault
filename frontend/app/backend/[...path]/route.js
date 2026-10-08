// A fixed upstream and explicit route allowlist prevent this from becoming an open proxy.
const routes = [
  ["POST", /^admin\/auth\/login$/],
  ["POST", /^admin\/auth\/(forgot-password|reset-password)$/],
  ["POST", /^admin\/access\/(request|verify|setup)$/],
  ["GET", /^admin\/access-requests$/],
  [
    "POST",
    /^admin\/access-requests\/[a-f\d]{24}\/(decision|resend-setup|resend-rejection)$/i,
  ],
  ["GET", /^admin\/(dashboard|companies|users|files|audit-logs)$/],
  ["GET", /^admin\/companies\/[a-f\d]{24}$/i],
  ["POST", /^admin\/companies\/[a-f\d]{24}\/(suspend|reactivate)$/i],
  ["GET", /^payments\/current$/],
  ["POST", /^payments\/(checkout|portal|plan|cancel|reconcile)$/],
  ["POST", /^subscriptions\/(downgrade-preview|downgrade-cleanup)$/],
  ["POST", /^ai\/chat$/],
  ["GET", /^ai\/conversations$/],
  ["GET", /^ai\/conversations\/[a-f\d]{24}$/i],
  ["DELETE", /^ai\/conversations\/[a-f\d]{24}$/i],
  ["GET", /^auth\/current-user$/],
  [
    "POST",
    /^auth\/(sign-in|sign-up|verify-account|resend-verification|forgot-password|reset-password|google\/(exchange|register))$/,
  ],
  [
    "GET",
    /^(plans|companies\/current|subscriptions\/current|subscriptions\/current\/billing|statistics\/current)$/,
  ],
  [
    "PATCH",
    /^(companies\/current|subscriptions\/current|users\/me\/password)$/,
  ],
  ["GET", /^(users|invitations|files)$/],
  ["POST", /^(invitations|invitations\/accept|files)$/],
  ["POST", /^invitations\/[a-f\d]{24}\/resend$/i],
  ["GET", /^(users|files)\/[a-f\d]{24}$/i],
  ["GET", /^files\/[a-f\d]{24}\/download$/i],
  ["PATCH", /^users\/[a-f\d]{24}$/i],
  ["PATCH", /^files\/[a-f\d]{24}\/permissions$/i],
  ["DELETE", /^(users|invitations|files)\/[a-f\d]{24}$/i],
];
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function forward(request, context) {
  const { path } = await context.params;
  const resource = path.join("/");
  if (
    !routes.some(
      ([method, pattern]) =>
        method === request.method && pattern.test(resource),
    )
  )
    return Response.json({ message: "Not found" }, { status: 404 });
  const base = process.env.NEXT_PUBLIC_API_URL;
  if (!base)
    return Response.json({ message: "Service unavailable" }, { status: 503 });
  const url = new URL(
    resource + new URL(request.url).search,
    base.replace(/\/$/, "") + "/",
  );
  const headers = new Headers();
  for (const key of ["authorization", "content-type", "accept"]) {
    const value = request.headers.get(key);
    if (value) headers.set(key, value);
  }
  try {
    const upstream = await fetch(url, {
      method: request.method,
      headers,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(90000)]),
      ...(["POST", "PATCH"].includes(request.method)
        ? { body: request.body, duplex: "half" }
        : {}),
    });
    const output = new Headers({
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    for (const key of ["content-type", "content-disposition", "retry-after"]) {
      const value = upstream.headers.get(key);
      if (value) output.set(key, value);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: output,
    });
  } catch {
    return Response.json(
      { message: "Service unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
export { forward as GET, forward as POST, forward as PATCH, forward as DELETE };
