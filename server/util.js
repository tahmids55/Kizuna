export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const badRequest = (msg) => new HttpError(400, msg);
export const notFound = (msg = 'Not found') => new HttpError(404, msg);
export const forbidden = (msg = 'You can’t do that') => new HttpError(403, msg);

export const now = () => new Date().toISOString();

const has = (obj, key) => obj != null && Object.prototype.hasOwnProperty.call(obj, key);

/** Explicit validators: return undefined when absent, throw a readable 400 when invalid. */
export const field = {
  text(body, key, { label = key, required = false, max = 200, multiline = false } = {}) {
    if (!has(body, key) || body[key] == null) {
      if (required) throw badRequest(`${label} is required`);
      return has(body, key) ? '' : undefined;
    }
    if (typeof body[key] !== 'string') throw badRequest(`${label} must be text`);
    const value = multiline ? body[key].replace(/\r\n/g, '\n').trim() : body[key].trim().replace(/\s+/g, ' ');
    if (required && !value) throw badRequest(`${label} is required`);
    if (value.length > max) throw badRequest(`${label} must be at most ${max} characters`);
    return value;
  },

  oneOf(body, key, options, { label = key } = {}) {
    if (!has(body, key)) return undefined;
    if (!options.includes(body[key])) throw badRequest(`${label} must be one of: ${options.join(', ')}`);
    return body[key];
  },

  id(body, key, { label = key, nullable = true } = {}) {
    if (!has(body, key)) return undefined;
    const v = body[key];
    if (v === null || v === '') {
      if (!nullable) throw badRequest(`${label} is required`);
      return null;
    }
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw badRequest(`${label} is invalid`);
    return n;
  },

  number(body, key, { label = key, min = -1e12, max = 1e12, nullable = true } = {}) {
    if (!has(body, key)) return undefined;
    const v = body[key];
    if (v === null || v === '') {
      if (!nullable) throw badRequest(`${label} is required`);
      return null;
    }
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw badRequest(`${label} must be a number`);
    return n;
  },

  date(body, key, { label = key } = {}) {
    if (!has(body, key)) return undefined;
    const v = body[key];
    if (v === null || v === '') return null;
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
      throw badRequest(`${label} must be a date (YYYY-MM-DD)`);
    }
    return v;
  },

  datetime(body, key, { label = key } = {}) {
    if (!has(body, key)) return undefined;
    const v = body[key];
    if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw badRequest(`${label} must be a date and time`);
    return new Date(v).toISOString();
  },

  color(body, key, { label = key } = {}) {
    if (!has(body, key)) return undefined;
    const v = body[key];
    if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) throw badRequest(`${label} must be a hex color`);
    return v.toLowerCase();
  },

  idList(body, key, { label = key, max = 100 } = {}) {
    if (!has(body, key)) return undefined;
    const v = body[key];
    if (!Array.isArray(v) || v.some((x) => !Number.isInteger(x) || x <= 0)) throw badRequest(`${label} must be a list of ids`);
    if (v.length > max) throw badRequest(`${label}: too many items`);
    return [...new Set(v)];
  },

  bool(body, key) {
    if (!has(body, key)) return undefined;
    return Boolean(body[key]);
  },
};

export const PALETTE = ['#0d9488', '#6366f1', '#e11d48', '#d97706', '#7c3aed', '#0284c7', '#db2777', '#16a34a', '#ea580c', '#475569'];
export const pickColor = (seed) =>
  PALETTE[[...String(seed)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 1000003, 7) % PALETTE.length];

export const parseJson = (s, fallback = null) => {
  if (!s) return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};

export const MAX_GROUP_MEMBERS = 10;
