const apiBase = String(import.meta.env.VITE_API_BASE || "/api").replace(/\/$/, "");

export function mcpEndpointUrl() {
  const configured = String(import.meta.env.VITE_MCP_URL || "").trim();
  if (configured) return configured;
  const url = new URL(apiBase, window.location.origin);
  url.pathname = `${url.pathname.replace(/\/api$/, "").replace(/\/$/, "")}/mcp`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, payload: { error?: string; message?: string; details?: unknown }) {
    super(payload.message || payload.error || `Request failed (${status})`);
    this.status = status;
    this.code = payload.error || "REQUEST_FAILED";
    this.details = payload.details;
  }
}

export async function api<T>(path: string, options: RequestInit = {}, token?: string | null): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, payload);
  return payload as T;
}

export async function uploadStatementPdf<T>(accountId: number, file: File, token: string): Promise<T> {
  const response = await fetch(`${apiBase}/accounts/${accountId}/statement-import-jobs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/pdf",
      "X-File-Name": encodeURIComponent(file.name),
    },
    body: file,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, payload);
  return payload as T;
}

export async function downloadEvidenceFile(path: string, fileName: string, token: string) {
  const apiPath = path.startsWith("/api/") ? path.slice(4) : path;
  const response = await fetch(`${apiBase}${apiPath}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new ApiError(response.status, payload);
  }
  const objectUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}
