import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { DELETE, GET, PATCH, POST } from "../app/backend/[...path]/route.js";

const handlers = { DELETE, GET, PATCH, POST };

async function gatewayStatus(method, resource) {
  const original = process.env.NEXT_PUBLIC_API_URL;
  delete process.env.NEXT_PUBLIC_API_URL;
  try {
    const request = new Request(`http://localhost:3000/backend/${resource}`, {
      method,
    });
    const response = await handlers[method](request, {
      params: Promise.resolve({ path: resource.split("/") }),
    });
    return response.status;
  } finally {
    if (original === undefined) delete process.env.NEXT_PUBLIC_API_URL;
    else process.env.NEXT_PUBLIC_API_URL = original;
  }
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(path)
      : entry.name.endsWith(".js")
        ? [path]
        : [];
  });
}

test("downgrade endpoints pass the gateway only with POST", async () => {
  for (const resource of [
    "subscriptions/downgrade-preview",
    "subscriptions/downgrade-cleanup",
  ]) {
    expect(await gatewayStatus("POST", resource)).toBe(503);
    expect(await gatewayStatus("GET", resource)).toBe(404);
  }
});

test("literal frontend API paths are present in the gateway allowlist", async () => {
  const files = ["app", "components", "lib"].flatMap((directory) =>
    sourceFiles(join(process.cwd(), directory)),
  );
  const paths = new Set();
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(
      /(?:request|collection)\(\s*["']\/(?!backend\/)([^"'?]+)["']/g,
    ))
      paths.add(match[1]);
  }
  for (const resource of paths) {
    const statuses = await Promise.all(
      Object.keys(handlers).map((method) => gatewayStatus(method, resource)),
    );
    expect(statuses, resource).toContain(503);
  }
});
