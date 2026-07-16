import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Express, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';

const ADMIN_FILE = path.join(process.cwd(), 'data', 'admin.json');
const SESSIONS_FILE = path.join(process.cwd(), 'data', 'admin-sessions.json');
const MIN_PASSWORD_LENGTH = 6;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

interface AdminStore {
  salt: string;
  hash: string;
}

interface AdminSession {
  token: string;
  expiresAt: number;
}

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function loadAdminStore(): AdminStore {
  if (fs.existsSync(ADMIN_FILE)) {
    return JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8')) as AdminStore;
  }
  const initial = process.env.ADMIN_PASSWORD || 'admin123';
  const salt = crypto.randomBytes(16).toString('hex');
  const store: AdminStore = { salt, hash: hashPassword(initial, salt) };
  fs.mkdirSync(path.dirname(ADMIN_FILE), { recursive: true });
  fs.writeFileSync(ADMIN_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
  return store;
}

function saveAdminStore(store: AdminStore) {
  fs.mkdirSync(path.dirname(ADMIN_FILE), { recursive: true });
  fs.writeFileSync(ADMIN_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

function verifyPassword(password: string, store: AdminStore): boolean {
  const hash = hashPassword(password, store.salt);
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(store.hash, 'hex'));
  } catch {
    return false;
  }
}

function loadSessions(): AdminSession[] {
  if (!fs.existsSync(SESSIONS_FILE)) return [];
  try {
    const list = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')) as AdminSession[];
    const now = Date.now();
    const valid = list.filter((s) => s.expiresAt > now);
    if (valid.length !== list.length) saveSessions(valid);
    return valid;
  } catch {
    return [];
  }
}

function saveSessions(sessions: AdminSession[]) {
  fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2), { mode: 0o600 });
}

export function createAdminSession(): string {
  const token = crypto.randomBytes(32).toString('hex');
  const sessions = loadSessions();
  sessions.push({ token, expiresAt: Date.now() + SESSION_TTL_MS });
  saveSessions(sessions);
  return token;
}

export function revokeAdminSession(token: string) {
  const sessions = loadSessions().filter((s) => s.token !== token);
  saveSessions(sessions);
}

function getTokenFromRequest(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  const bodyToken = (req.body as { adminToken?: string })?.adminToken;
  return typeof bodyToken === 'string' ? bodyToken : null;
}

export function requireAdminAuth(req: Request, res: Response, next: NextFunction) {
  const token = getTokenFromRequest(req);
  if (!token) return res.status(401).json({ error: 'Chưa đăng nhập admin' });
  const session = loadSessions().find((s) => s.token === token);
  if (!session || session.expiresAt < Date.now()) {
    return res.status(401).json({ error: 'Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại.' });
  }
  next();
}

export function registerAdminRoutes(app: Express) {
  const adminLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Quá nhiều lần thử. Vui lòng thử lại sau.' },
  });

  app.post('/api/admin/login', adminLimiter, (req: Request, res: Response) => {
    const { password } = req.body as { password?: string };
    if (!password || typeof password !== 'string') {
      return res.status(400).json({ error: 'Mật khẩu không hợp lệ' });
    }
    const store = loadAdminStore();
    if (verifyPassword(password, store)) {
      const token = createAdminSession();
      return res.json({ ok: true, token, expiresInHours: 12 });
    }
    return res.status(401).json({ error: 'Mật khẩu quản trị viên không chính xác!' });
  });

  app.post('/api/admin/logout', (req: Request, res: Response) => {
    const token = getTokenFromRequest(req);
    if (token) revokeAdminSession(token);
    res.json({ ok: true });
  });

  app.post('/api/admin/change-password', adminLimiter, requireAdminAuth, (req: Request, res: Response) => {
    const { currentPassword, newPassword } = req.body as {
      currentPassword?: string;
      newPassword?: string;
    };
    if (
      !currentPassword ||
      !newPassword ||
      typeof currentPassword !== 'string' ||
      typeof newPassword !== 'string'
    ) {
      return res.status(400).json({ error: 'Thiếu thông tin mật khẩu' });
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: 'Mật khẩu mới tối thiểu 6 ký tự' });
    }
    const store = loadAdminStore();
    if (!verifyPassword(currentPassword, store)) {
      return res.status(401).json({ error: 'Mật khẩu hiện tại không đúng' });
    }
    const salt = crypto.randomBytes(16).toString('hex');
    saveAdminStore({ salt, hash: hashPassword(newPassword, salt) });
    return res.json({ ok: true });
  });
}
