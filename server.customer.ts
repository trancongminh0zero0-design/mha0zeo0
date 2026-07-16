import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Express, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { readStoreSnapshot } from './server.store';

const CUSTOMERS_FILE = path.join(process.cwd(), 'data', 'store', 'customers.json');
const SESSIONS_FILE = path.join(process.cwd(), 'data', 'customer-sessions.json');
const MIN_PASSWORD_LENGTH = 6;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface CustomerRecord {
  phone: string;
  name: string;
  email?: string;
  bankName: string;
  bankNumber: string;
  bankAccountName: string;
  salt: string;
  hash: string;
  createdAt: string;
}

export interface CustomerProfile {
  name: string;
  phone: string;
  email?: string;
  bankName: string;
  bankNumber: string;
  bankAccountName: string;
  createdAt: string;
}

interface CustomerSession {
  token: string;
  phone: string;
  expiresAt: number;
}

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function loadCustomers(): CustomerRecord[] {
  if (!fs.existsSync(CUSTOMERS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(CUSTOMERS_FILE, 'utf8')) as CustomerRecord[];
  } catch {
    return [];
  }
}

function saveCustomers(customers: CustomerRecord[]) {
  fs.mkdirSync(path.dirname(CUSTOMERS_FILE), { recursive: true });
  const tmp = `${CUSTOMERS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(customers, null, 2), 'utf8');
  fs.renameSync(tmp, CUSTOMERS_FILE);
}

function toProfile(record: CustomerRecord): CustomerProfile {
  return {
    name: record.name,
    phone: record.phone,
    email: record.email,
    bankName: record.bankName,
    bankNumber: record.bankNumber,
    bankAccountName: record.bankAccountName,
    createdAt: record.createdAt,
  };
}

function loadSessions(): CustomerSession[] {
  if (!fs.existsSync(SESSIONS_FILE)) return [];
  try {
    const list = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')) as CustomerSession[];
    const now = Date.now();
    const valid = list.filter((s) => s.expiresAt > now);
    if (valid.length !== list.length) saveSessions(valid);
    return valid;
  } catch {
    return [];
  }
}

function saveSessions(sessions: CustomerSession[]) {
  fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2), { mode: 0o600 });
}

function createSession(phone: string): string {
  const token = crypto.randomBytes(32).toString('hex');
  const sessions = loadSessions();
  sessions.push({ token, phone, expiresAt: Date.now() + SESSION_TTL_MS });
  saveSessions(sessions);
  return token;
}

function revokeSession(token: string) {
  saveSessions(loadSessions().filter((s) => s.token !== token));
}

function getTokenFromRequest(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  const bodyToken = (req.body as { token?: string })?.token;
  return typeof bodyToken === 'string' ? bodyToken : null;
}

function requireCustomerAuth(req: Request, res: Response, next: NextFunction) {
  const token = getTokenFromRequest(req);
  if (!token) return res.status(401).json({ error: 'Chưa đăng nhập' });
  const session = loadSessions().find((s) => s.token === token);
  if (!session || session.expiresAt < Date.now()) {
    return res.status(401).json({ error: 'Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại.' });
  }
  const customer = loadCustomers().find((c) => c.phone === session.phone);
  if (!customer) return res.status(401).json({ error: 'Tài khoản không tồn tại' });
  (req as Request & { customer: CustomerRecord }).customer = customer;
  next();
}

export function registerCustomerRoutes(app: Express) {
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 40,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Quá nhiều lần thử. Vui lòng thử lại sau.' },
  });

  app.post('/api/customer/register', authLimiter, (req: Request, res: Response) => {
    const { name, phone, password, email, bankName, bankNumber, bankAccountName } = req.body as {
      name?: string;
      phone?: string;
      password?: string;
      email?: string;
      bankName?: string;
      bankNumber?: string;
      bankAccountName?: string;
    };

    if (!name?.trim() || !phone?.trim() || !password?.trim()) {
      return res.status(400).json({ error: 'Vui lòng điền họ tên, số điện thoại và mật khẩu' });
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: 'Mật khẩu tối thiểu 6 ký tự' });
    }

    const normalizedPhone = phone.trim();
    const customers = loadCustomers();
    if (customers.some((c) => c.phone === normalizedPhone)) {
      return res.status(409).json({ error: 'Số điện thoại đã được đăng ký' });
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const record: CustomerRecord = {
      phone: normalizedPhone,
      name: name.trim(),
      email: email?.trim() || undefined,
      bankName: bankName?.trim() || '',
      bankNumber: bankNumber?.trim() || '',
      bankAccountName: bankAccountName?.trim() || name.trim(),
      salt,
      hash: hashPassword(password, salt),
      createdAt: new Date().toLocaleString('vi-VN'),
    };
    customers.unshift(record);
    saveCustomers(customers);

    const token = createSession(normalizedPhone);
    return res.json({
      ok: true,
      token,
      profile: toProfile(record),
    });
  });

  app.post('/api/customer/login', authLimiter, (req: Request, res: Response) => {
    const { phone, password } = req.body as { phone?: string; password?: string };
    if (!phone?.trim() || !password?.trim()) {
      return res.status(400).json({ error: 'Vui lòng nhập số điện thoại và mật khẩu' });
    }

    const customer = loadCustomers().find((c) => c.phone === phone.trim());
    if (!customer) {
      return res.status(401).json({ error: 'Số điện thoại chưa đăng ký' });
    }

    const hash = hashPassword(password, customer.salt);
    try {
      if (!crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(customer.hash, 'hex'))) {
        return res.status(401).json({ error: 'Mật khẩu không chính xác' });
      }
    } catch {
      return res.status(401).json({ error: 'Mật khẩu không chính xác' });
    }

    const token = createSession(customer.phone);
    return res.json({
      ok: true,
      token,
      profile: toProfile(customer),
    });
  });

  app.post('/api/customer/logout', (req: Request, res: Response) => {
    const token = getTokenFromRequest(req);
    if (token) revokeSession(token);
    res.json({ ok: true });
  });

  app.get('/api/customer/me', requireCustomerAuth, (req: Request, res: Response) => {
    const customer = (req as Request & { customer: CustomerRecord }).customer;
    const snap = readStoreSnapshot();
    const orders = (snap.orders as Array<{ phone: string }>).filter(
      (o) => o.phone?.trim() === customer.phone
    );
    res.json({
      profile: toProfile(customer),
      orders,
    });
  });

  app.put('/api/customer/profile', authLimiter, requireCustomerAuth, (req: Request, res: Response) => {
    const customer = (req as Request & { customer: CustomerRecord }).customer;
    const { name, email, bankName, bankNumber, bankAccountName } = req.body as {
      name?: string;
      email?: string;
      bankName?: string;
      bankNumber?: string;
      bankAccountName?: string;
    };

    const customers = loadCustomers();
    const idx = customers.findIndex((c) => c.phone === customer.phone);
    if (idx < 0) return res.status(404).json({ error: 'Không tìm thấy tài khoản' });

    const updated: CustomerRecord = {
      ...customers[idx],
      name: name?.trim() || customers[idx].name,
      email: email?.trim() || customers[idx].email,
      bankName: bankName?.trim() ?? customers[idx].bankName,
      bankNumber: bankNumber?.trim() ?? customers[idx].bankNumber,
      bankAccountName: bankAccountName?.trim() ?? customers[idx].bankAccountName,
    };
    customers[idx] = updated;
    saveCustomers(customers);
    res.json({ ok: true, profile: toProfile(updated) });
  });
}
