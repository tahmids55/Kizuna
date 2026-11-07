import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { Router } from 'express';
import { get, insert, run, tx } from './db.js';
import { HttpError, badRequest, field, pickColor } from './util.js';

const SESSION_DAYS = 60;
const scrypt = promisify(crypto.scrypt);

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export const publicUser = (u) =>
  u && {
    id: u.id,
    name: u.name,
    email: u.email,
    title: u.title,
    color: u.color,
    avatar: u.avatar,
    status_emoji: u.status_emoji,
    status_text: u.status_text,
    last_seen_at: u.last_seen_at,
  };

export async function createSession(userId, device = '') {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  await run('INSERT INTO sessions (token_hash, user_id, device, expires_at) VALUES (?, ?, ?, ?)', sha256(token), userId, String(device ?? '').slice(0, 120), expires);
  return token;
}

/** Resolve a bearer token to a user row (or undefined). Used by HTTP and WebSocket auth. */
export async function userForToken(token) {
  if (!token || typeof token !== 'string') return undefined;
  return get(
    `SELECT u.*, s.token_hash AS session_hash FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`,
    sha256(token),
    new Date().toISOString(),
  );
}

export async function attachUser(req, _res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  try {
    const user = await userForToken(token);
    if (user) {
      req.user = user;
      req.sessionHash = user.session_hash;
    }
    next();
  } catch (e) {
    next(e);
  }
}

export function requireUser(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Please sign in'));
  next();
}

const attempts = new Map();
function throttle(key) {
  const t = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.reset < t) {
    attempts.set(key, { count: 1, reset: t + 15 * 60e3 });
    return;
  }
  entry.count += 1;
  if (entry.count > 10) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
}

function validatePassword(pw, label = 'Password') {
  if (typeof pw !== 'string' || pw.length < 8) throw badRequest(`${label} must be at least 8 characters`);
  if (pw.length > 200) throw badRequest(`${label} is too long`);
  return pw;
}

function validateEmail(body) {
  const email = field.text(body, 'email', { label: 'Email', required: true, max: 200 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('Enter a valid email address');
  return email;
}

/** Every user gets a private "My space" for personal tasks, ideas and goals. */
export async function ensureSelfConversation(userId) {
  const existing = await get(
    `SELECT c.id FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id WHERE c.type = 'self' AND m.user_id = ?`,
    userId,
  );
  if (existing) return existing.id;
  return tx(async () => {
    const id = await insert(`INSERT INTO conversations (type, name, emoji, color, created_by) VALUES ('self', 'My space', '✨', '#0d9488', ?)`, userId);
    await run(`INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, 'owner')`, id, userId);
    return id;
  });
}

export const authRouter = Router();

/** Liveness for Render's health checks. Deliberately does not touch the database, so a
 *  scale-to-zero Postgres (Neon) can sleep while nobody is using the app. */
authRouter.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()) });
});

authRouter.get('/meta', async (_req, res) => {
  res.json({
    name: 'Kizuna',
    version: '1.1.0',
    inviteRequired: Boolean(process.env.KIZUNA_INVITE_CODE),
    demo: Boolean(await get(`SELECT 1 FROM users WHERE email = 'demo@kizuna.app'`)),
  });
});

authRouter.post('/auth/register', async (req, res) => {
  const name = field.text(req.body, 'name', { label: 'Name', required: true, max: 80 });
  const email = validateEmail(req.body);
  const password = validatePassword(req.body.password);
  const title = field.text(req.body, 'title', { label: 'Role', max: 80 }) ?? '';
  const invite = process.env.KIZUNA_INVITE_CODE;
  if (invite && req.body.invite_code !== invite) throw new HttpError(403, 'That invite code is not valid');
  if (await get('SELECT 1 FROM users WHERE email = ?', email)) throw new HttpError(409, 'An account with that email already exists');
  const id = await insert('INSERT INTO users (name, email, title, password_hash, color) VALUES (?, ?, ?, ?, ?)', name, email, title, await hashPassword(password), pickColor(email));
  await ensureSelfConversation(id);
  const token = await createSession(id, req.get('user-agent'));
  res.status(201).json({ token, user: publicUser(await get('SELECT * FROM users WHERE id = ?', id)) });
});

authRouter.post('/auth/login', async (req, res) => {
  const email = validateEmail(req.body);
  throttle(`${req.ip}|${email}`);
  const user = await get('SELECT * FROM users WHERE email = ?', email);
  if (!user || typeof req.body.password !== 'string' || !(await verifyPassword(req.body.password, user.password_hash))) {
    throw new HttpError(401, 'Incorrect email or password');
  }
  attempts.delete(`${req.ip}|${email}`);
  await ensureSelfConversation(user.id);
  await purgeExpiredSessions(); // housekeeping piggybacks on logins instead of a timer
  res.json({ token: await createSession(user.id, req.get('user-agent')), user: publicUser(user) });
});

authRouter.post('/auth/logout', async (req, res) => {
  if (req.sessionHash) await run('DELETE FROM sessions WHERE token_hash = ?', req.sessionHash);
  res.json({ ok: true });
});

authRouter.get('/auth/me', requireUser, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

/** Profile, status and password. Returns the updated user; callers broadcast the change. */
export async function updateProfile(req) {
  const b = req.body;
  const sets = {};
  const name = field.text(b, 'name', { label: 'Name', required: 'name' in b, max: 80 });
  if (name !== undefined) sets.name = name;
  const title = field.text(b, 'title', { label: 'Role', max: 80 });
  if (title !== undefined) sets.title = title;
  const color = field.color(b, 'color', { label: 'Color' });
  if (color !== undefined) sets.color = color;
  const statusEmoji = field.text(b, 'status_emoji', { label: 'Status emoji', max: 16 });
  if (statusEmoji !== undefined) sets.status_emoji = statusEmoji;
  const statusText = field.text(b, 'status_text', { label: 'Status', max: 100 });
  if (statusText !== undefined) sets.status_text = statusText;
  if ('avatar' in b) {
    if (b.avatar !== null && (typeof b.avatar !== 'string' || (!/^\/api\/files\/[A-Za-z0-9_-]+\/[^/]+$/.test(b.avatar) && !/^https:\/\/(?:res\.cloudinary\.com|[a-z0-9.-]+\.cloudinary\.com)\//.test(b.avatar)))) {
      throw badRequest('Invalid avatar');
    }
    sets.avatar = b.avatar;
  }
  if (b.new_password !== undefined) {
    if (typeof b.current_password !== 'string' || !(await verifyPassword(b.current_password, req.user.password_hash))) {
      throw badRequest('Current password is incorrect');
    }
    sets.password_hash = await hashPassword(validatePassword(b.new_password, 'New password'));
    await run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', req.user.id, req.sessionHash);
  }
  const cols = Object.keys(sets);
  if (cols.length) await run(`UPDATE users SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...cols.map((c) => sets[c]), req.user.id);
  return publicUser(await get('SELECT * FROM users WHERE id = ?', req.user.id));
}

export async function purgeExpiredSessions() {
  await run('DELETE FROM sessions WHERE expires_at < ?', new Date().toISOString());
}
