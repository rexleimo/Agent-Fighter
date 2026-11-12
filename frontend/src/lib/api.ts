export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!res.ok) {
    let message = res.statusText || `HTTP ${res.status}`;
    if (data && typeof data === 'object') {
      const record = data as Record<string, unknown>;
      if (typeof record.message === 'string') message = record.message;
      else if (typeof record.error === 'string') message = record.error;
      else if (record.error && typeof record.error === 'object' && 'message' in record.error) {
        message = String((record.error as { message: unknown }).message);
      }
    }
    throw new ApiError(res.status, message);
  }
  return data as T;
}

export function post<T>(path: string, body: unknown = {}): Promise<T> {
  return api<T>(path, { method: 'POST', body: JSON.stringify(body) });
}
