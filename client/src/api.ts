const apiBase = String(import.meta.env.VITE_API_BASE || "/api").replace(/\/$/, "");

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

