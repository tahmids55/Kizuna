import { Capacitor } from '@capacitor/core';
import type { Attachment } from './types';

export const isNative = Capacitor.isNativePlatform();

const SERVER_KEY = 'kizuna-server';
const TOKEN_KEY = 'kizuna-token';

const FALLBACK_SERVER = 'https://kizuna-rb1z.onrender.com';

export const defaultServer = () => {
  const stored = localStorage.getItem(SERVER_KEY);
  if (stored && /(?:192\.168\.|10\.\d+\.|172\.(?:1[6-9]|2\d|3[01])\.|localhost|127\.0\.0\.1)/.test(stored)) {
    localStorage.removeItem(SERVER_KEY);
    return (import.meta.env.VITE_DEFAULT_SERVER as string | undefined) || FALLBACK_SERVER;
  }
  return (
    stored ||
    (import.meta.env.VITE_DEFAULT_SERVER as string | undefined) ||
    FALLBACK_SERVER
  );
};

/** On web the API is same-origin; on native it defaults to the configured backend without manual user input. */
export const serverUrl = () => {
  if (!isNative) return '';
  return defaultServer();
};

export function setServerUrl(url: string) {
  let u = url.trim().replace(/\/+$/, '');
  if (u && !/^https?:\/\//i.test(u)) u = `http://${u}`;
  localStorage.setItem(SERVER_KEY, u);
  return u;
}

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string | null) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));

/** Absolute URL for server-relative paths like /api/files/… (needed inside the Android app). */
export const fileUrl = (path: string | null | undefined) =>
  path ? (/^https?:\/\//i.test(path) ? path : `${serverUrl()}${path}`) : '';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const hasBody = opts.body !== undefined;
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(`${serverUrl()}/api${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: hasBody ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError(isNative ? 'Can’t reach the server. Check the address and your Wi-Fi.' : 'You appear to be offline.', 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) onUnauthorized();
    throw new ApiError(data.error || `Request failed (${res.status})`, res.status);
  }
  return data as T;
}

/** Upload files with progress (fetch can't report upload progress). */
export function uploadFiles(conversationId: number, files: File[], onProgress?: (pct: number) => void) {
  return new Promise<Attachment[]>((resolve, reject) => {
    const form = new FormData();
    files.forEach((f) => form.append('files', f, f.name));
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${serverUrl()}/api/conversations/${conversationId}/uploads`);
    const token = getToken();
    if (token) xhr.setRequestHeader('authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      const data = JSON.parse(xhr.responseText || '{}');
      if (xhr.status >= 200 && xhr.status < 300) resolve(data.attachments);
      else reject(new ApiError(data.error || 'Upload failed', xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('Upload failed — check your connection', 0));
    xhr.send(form);
  });
}

export async function uploadAvatar(file: File) {
  const form = new FormData();
  form.append('file', file, file.name);
  const res = await fetch(`${serverUrl()}/api/uploads/avatar`, { method: 'POST', headers: { authorization: `Bearer ${getToken()}` }, body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || 'Upload failed', res.status);
  return data.url as string;
}
