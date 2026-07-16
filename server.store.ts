import fs from 'fs';
import path from 'path';
import type { Express, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAdminAuth } from './server.admin';

const STORE_DIR = path.join(process.cwd(), 'data', 'store');
const SEED_FILE = path.join(process.cwd(), 'data', 'store.seed.json');

export interface PlatformCommissionRow {
  id: string;
  name: string;
  clicks: number;
  commission: number;
  apiStatus: string;
  lastUpdatedAt?: string;
}

export interface BridgeChatMsg {
  id: string;
  sender: 'customer' | 'shop';
  senderName: string;
  text: string;
  timestamp: string;
}

export interface BridgeChatThread {
  id: string;
  customerName: string;
  customerPhone: string;
  shopName: string;
  lastMessage: string;
  lastTimestamp: string;
  hasWarning: boolean;
  messages: BridgeChatMsg[];
}

export interface StoreSnapshot {
  products: unknown[];
  orders: unknown[];
  shops: unknown[];
  config: Record<string, unknown>;
  aiInquiries: unknown[];
  bridgeChats: BridgeChatThread[];
  commissionLedger: unknown[];
  withdrawals: unknown[];
  platformCommissions: PlatformCommissionRow[];
}

const FILE_KEYS: (keyof StoreSnapshot)[] = [
  'products',
  'orders',
  'shops',
  'config',
  'aiInquiries',
  'bridgeChats',
  'commissionLedger',
  'withdrawals',
  'platformCommissions',
];

const DEFAULT_PLATFORM: PlatformCommissionRow[] = [
  { id: 'shopee', name: 'Shopee Affiliate', clicks: 0, commission: 0, apiStatus: 'Chưa nhập số liệu' },
  { id: 'lazada', name: 'Lazada Partner', clicks: 0, commission: 0, apiStatus: 'Chưa nhập số liệu' },
  { id: 'tiktok', name: 'TikTok Shop Partner', clicks: 0, commission: 0, apiStatus: 'Chưa nhập số liệu' },
  { id: 'tiki', name: 'Tiki Affiliate', clicks: 0, commission: 0, apiStatus: 'Chưa nhập số liệu' },
  { id: 'sendo', name: 'Sendo Affiliate', clicks: 0, commission: 0, apiStatus: 'Chưa nhập số liệu' },
];

function filePath(key: keyof StoreSnapshot) {
  return path.join(STORE_DIR, `${key}.json`);
}

function readJson<T>(key: keyof StoreSnapshot, fallback: T): T {
  const fp = filePath(key);
  if (!fs.existsSync(fp)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: keyof StoreSnapshot, data: unknown) {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  const fp = filePath(key);
  const tmp = `${fp}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, fp);
}

function loadSeed(): Partial<StoreSnapshot> | null {
  if (!fs.existsSync(SEED_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')) as Partial<StoreSnapshot>;
  } catch {
    return null;
  }
}

export function initStoreFiles() {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  const seed = loadSeed();
  const defaults: StoreSnapshot = {
    products: seed?.products ?? [],
    orders: seed?.orders ?? [],
    shops: seed?.shops ?? [],
    config: seed?.config ?? { siteName: 'TiviTapHoa', slogan: 'Mua sắm thông minh' },
    aiInquiries: seed?.aiInquiries ?? [],
    bridgeChats: seed?.bridgeChats ?? [],
    commissionLedger: seed?.commissionLedger ?? [],
    withdrawals: seed?.withdrawals ?? [],
    platformCommissions: seed?.platformCommissions ?? DEFAULT_PLATFORM,
  };
  for (const key of FILE_KEYS) {
    if (!fs.existsSync(filePath(key))) {
      writeJson(key, defaults[key]);
    }
  }
}

export function readStoreSnapshot(): StoreSnapshot {
  initStoreFiles();
  return {
    products: readJson('products', []),
    orders: readJson('orders', []),
    shops: readJson('shops', []),
    config: readJson('config', {}),
    aiInquiries: readJson('aiInquiries', []),
    bridgeChats: readJson('bridgeChats', []),
    commissionLedger: readJson('commissionLedger', []),
    withdrawals: readJson('withdrawals', []),
    platformCommissions: readJson('platformCommissions', DEFAULT_PLATFORM),
  };
}

export function writeStoreSnapshot(patch: Partial<StoreSnapshot>) {
  initStoreFiles();
  for (const key of FILE_KEYS) {
    if (patch[key] !== undefined) {
      writeJson(key, patch[key]);
    }
  }
}

export function readPublicStore() {
  const snap = readStoreSnapshot();
  const shops = (snap.shops as Array<{ name: string; status: string; isLive?: boolean }>).map((s) => ({
    name: s.name,
    status: s.status,
    isLive: s.isLive,
  }));
  return {
    products: snap.products,
    config: snap.config,
    shops,
  };
}

const FRAUD_KEYWORDS = [
  'giao dịch ngoài',
  'chuyển khoản riêng',
  'zalo',
  'sđt riêng',
  'bớt giá',
  'ck riêng',
  'không qua sàn',
  'bán lẻ riêng',
  'ck ngoài',
  'hủy đơn',
  'kết bạn zalo',
];

function detectFraud(text: string) {
  const lower = text.toLowerCase();
  return FRAUD_KEYWORDS.some((kw) => lower.includes(kw));
}

function calcCommission(amount: number, ratePercent: number) {
  const rate = Math.min(100, Math.max(0, ratePercent)) / 100;
  const fee = Math.round(amount * rate);
  const net = amount - fee;
  return { fee, net };
}

function getOrderShopTotal(
  order: { items: Array<{ id: number; price: number; qty: number }> },
  shopName: string,
  products: Array<{ id: number; shop: string }>
): number {
  return order.items
    .filter((item) => products.find((p) => p.id === item.id)?.shop === shopName)
    .reduce((sum, item) => sum + item.price * item.qty, 0);
}

function recordCommissionsForOrder(
  order: {
    code: string;
    items: Array<{ id: number; price: number; qty: number }>;
    createdAt: string;
  },
  products: Array<{ id: number; shop: string }>,
  shops: Array<{
    name: string;
    phone: string;
    ownerRealName: string;
    commissionRate?: number;
    status: string;
  }>,
  ledger: unknown[]
) {
  const existing = ledger as Array<{ orderCode: string; shopName: string }>;
  const known = new Set(existing.map((e) => `${e.orderCode}:${e.shopName}`));
  const additions: unknown[] = [];

  for (const shop of shops) {
    const orderAmount = getOrderShopTotal(order, shop.name, products);
    if (orderAmount <= 0) continue;
    const key = `${order.code}:${shop.name}`;
    if (known.has(key)) continue;
    const rate = shop.commissionRate ?? 10;
    const { fee, net } = calcCommission(orderAmount, rate);
    additions.push({
      orderCode: order.code,
      shopName: shop.name,
      shopPhone: shop.phone,
      partnerName: shop.ownerRealName,
      orderAmount,
      fee,
      net,
      rate,
      createdAt: order.createdAt,
      held: shop.status === 'Tạm khóa',
    });
  }

  if (additions.length > 0) {
    writeJson('commissionLedger', [...additions, ...existing]);
  }
}

export function registerStoreRoutes(app: Express) {
  initStoreFiles();

  const publicWriteLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Quá nhiều yêu cầu. Vui lòng thử lại sau.' },
  });

  app.get('/api/store', (_req, res) => {
    res.json(readPublicStore());
  });

  app.get('/api/store/full', requireAdminAuth, (_req, res) => {
    res.json(readStoreSnapshot());
  });

  app.put('/api/admin/store', requireAdminAuth, (req, res) => {
    const body = req.body as Partial<StoreSnapshot>;
    const allowed: Partial<StoreSnapshot> = {};
    for (const key of FILE_KEYS) {
      if (body[key] !== undefined) allowed[key] = body[key] as never;
    }
    if (Object.keys(allowed).length === 0) {
      return res.status(400).json({ error: 'Không có dữ liệu để lưu' });
    }
    writeStoreSnapshot(allowed);
    res.json({ ok: true, store: readStoreSnapshot() });
  });

  app.post('/api/orders', publicWriteLimiter, (req, res) => {
    const order = req.body;
    if (!order?.code || !order?.phone || !Array.isArray(order?.items)) {
      return res.status(400).json({ error: 'Đơn hàng không hợp lệ' });
    }
    const snap = readStoreSnapshot();
    const orders = snap.orders as unknown[];
    if ((orders as Array<{ code: string }>).some((o) => o.code === order.code)) {
      return res.status(409).json({ error: 'Mã đơn đã tồn tại' });
    }
    orders.unshift(order);
    writeJson('orders', orders);
    recordCommissionsForOrder(
      order,
      snap.products as Array<{ id: number; shop: string }>,
      snap.shops as Array<{
        name: string;
        phone: string;
        ownerRealName: string;
        commissionRate?: number;
        status: string;
      }>,
      snap.commissionLedger
    );
    res.json({ ok: true, order });
  });

  app.post('/api/shops/apply', publicWriteLimiter, (req, res) => {
    const shop = req.body;
    if (!shop?.name || !shop?.phone || !shop?.ownerRealName) {
      return res.status(400).json({ error: 'Thiếu thông tin đăng ký gian hàng' });
    }
    const snap = readStoreSnapshot();
    const shops = snap.shops as unknown[];
    const phone = String(shop.phone).trim();
    if ((shops as Array<{ phone: string }>).some((s) => s.phone.trim() === phone)) {
      return res.status(409).json({ error: 'Số điện thoại đã đăng ký gian hàng' });
    }
    const entry = {
      ...shop,
      status: 'Chờ duyệt',
      createdAt: new Date().toLocaleString('vi-VN'),
      commissionRate: shop.commissionRate ?? 10,
      isLive: false,
    };
    shops.unshift(entry);
    writeJson('shops', shops);
    res.json({ ok: true });
  });

  app.post('/api/inquiries', publicWriteLimiter, (req, res) => {
    const { customerName, customerPhone, message } = req.body as {
      customerName?: string;
      customerPhone?: string;
      message?: string;
    };
    if (!customerName?.trim() || !customerPhone?.trim()) {
      return res.status(400).json({ error: 'Thiếu họ tên hoặc số điện thoại' });
    }
    const entry = {
      id: Date.now().toString(),
      customerName: customerName.trim(),
      customerPhone: customerPhone.trim(),
      message: (message || '').trim(),
      createdAt: new Date().toLocaleString('vi-VN', {
        hour: '2-digit',
        minute: '2-digit',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      }),
      status: 'pending',
    };
    const snap = readStoreSnapshot();
    const list = snap.aiInquiries as unknown[];
    list.unshift(entry);
    writeJson('aiInquiries', list);
    res.json({ ok: true, inquiry: entry });
  });

  app.get('/api/bridge-chat/:threadId', (req, res) => {
    const snap = readStoreSnapshot();
    const thread = snap.bridgeChats.find((t) => t.id === req.params.threadId);
    if (!thread) return res.json({ thread: null });
    res.json({ thread });
  });

  app.post('/api/bridge-chat/:threadId/messages', publicWriteLimiter, (req, res) => {
    const { sender, senderName, text, shopName, customerName, customerPhone } = req.body as {
      sender?: 'customer' | 'shop';
      senderName?: string;
      text?: string;
      shopName?: string;
      customerName?: string;
      customerPhone?: string;
    };
    if (!text?.trim() || !sender || !shopName) {
      return res.status(400).json({ error: 'Tin nhắn không hợp lệ' });
    }
    const snap = readStoreSnapshot();
    const threads = [...snap.bridgeChats];
    const threadId = req.params.threadId;
    const nowStr = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    const msg: BridgeChatMsg = {
      id: `msg-${sender}-${Date.now()}`,
      sender,
      senderName: senderName || (sender === 'shop' ? shopName : 'Khách hàng'),
      text: text.trim(),
      timestamp: nowStr,
    };
    let thread = threads.find((t) => t.id === threadId);
    const hasWarning = detectFraud(msg.text);
    if (!thread) {
      thread = {
        id: threadId,
        customerName: customerName || 'Khách hàng',
        customerPhone: customerPhone || 'Vãng lai',
        shopName,
        lastMessage: msg.text,
        lastTimestamp: nowStr,
        hasWarning,
        messages: [msg],
      };
      threads.unshift(thread);
    } else {
      thread = {
        ...thread,
        messages: [...thread.messages, msg],
        lastMessage: msg.text,
        lastTimestamp: nowStr,
        hasWarning: thread.hasWarning || hasWarning,
      };
      const idx = threads.findIndex((t) => t.id === threadId);
      threads[idx] = thread;
    }
    writeJson('bridgeChats', threads);
    res.json({ ok: true, thread });
  });

  app.post('/api/shop/session', publicWriteLimiter, (req, res) => {
    const { phone } = req.body as { phone?: string };
    if (!phone?.trim()) {
      return res.status(400).json({ error: 'Thiếu số điện thoại đăng nhập' });
    }
    const snap = readStoreSnapshot();
    const shops = snap.shops as Array<Record<string, unknown> & { phone: string; name: string; status: string }>;
    const shop = shops.find((s) => s.phone.trim() === phone.trim());
    if (!shop) {
      return res.status(404).json({ error: 'Không tìm thấy gian hàng với số điện thoại này' });
    }
    const { cccdFrontImage: _f, cccdBackImage: _b, ...safeShop } = shop;
    const products = snap.products as Array<{ id: number; shop: string }>;
    const orders = (snap.orders as Array<{ items: Array<{ id: number }> }>).filter((order) =>
      order.items.some((item) => {
        const prod = products.find((p) => p.id === item.id);
        return prod && prod.shop === shop.name;
      })
    );
    const withdrawals = (snap.withdrawals as Array<{ shopPhone: string }>).filter(
      (w) => w.shopPhone.trim() === phone.trim()
    );
    const commissionLedger = (snap.commissionLedger as Array<{ shopPhone: string }>).filter(
      (e) => e.shopPhone.trim() === phone.trim()
    );
    res.json({ shop: safeShop, orders, withdrawals, commissionLedger });
  });

  app.post('/api/shop/withdraw', publicWriteLimiter, (req, res) => {
    const { shopPhone, amount, bank, account } = req.body as {
      shopPhone?: string;
      amount?: number;
      bank?: string;
      account?: string;
    };
    if (!shopPhone || !amount || amount <= 0) {
      return res.status(400).json({ error: 'Yêu cầu rút tiền không hợp lệ' });
    }
    const snap = readStoreSnapshot();
    const shops = snap.shops as Array<{ phone: string; status: string }>;
    const shop = shops.find((s) => s.phone.trim() === shopPhone.trim());
    if (!shop || shop.status !== 'Hoạt động') {
      return res.status(403).json({ error: 'Gian hàng không hợp lệ hoặc chưa được duyệt' });
    }
    const withdrawals = snap.withdrawals as unknown[];
    const record = {
      id: `WD-${Date.now()}`,
      shopPhone: shopPhone.trim(),
      amount,
      bank: bank || '',
      account: account || '',
      date: new Date().toLocaleString('vi-VN'),
      status: 'Chờ duyệt',
    };
    withdrawals.unshift(record);
    writeJson('withdrawals', withdrawals);
    res.json({ ok: true, withdrawal: record });
  });
}
