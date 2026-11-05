import dotenv from 'dotenv';
dotenv.config({ path: ['.env.local', '.env'] });

import express, { Request, Response, NextFunction } from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const IS_PROD = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const DEV_LOGIN = !BOT_TOKEN && (!IS_PROD || process.env.ALLOW_DEV_LOGIN === 'true');
const ADMIN_IDS = new Set(
  (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(s => s.trim()).filter(Boolean).map(id => `tg_${id}`)
);
const ALLOW_SELF_APPROVAL = process.env.ALLOW_SELF_APPROVAL === 'true';
const DATA_FILE = path.resolve(process.env.DATA_FILE || path.join(process.cwd(), 'data', 'db.json'));

const MIN_CARDS = Number(process.env.MIN_CARDS) || 10; // minimum cards sold for a game to start
const MAX_CARDS_PER_USER = Number(process.env.MAX_CARDS_PER_USER) || 10; // per room per game
const MAX_EXTENSIONS = 2; // extra 60s selection periods before a room is cancelled & refunded
const COMMISSION_RATE = 0.2;
const MIN_DEPOSIT = Number(process.env.MIN_DEPOSIT) || 10;
const MAX_DEPOSIT = Number(process.env.MAX_DEPOSIT) || 100000;
const MIN_WITHDRAW = Number(process.env.MIN_WITHDRAW) || 50;
const MAX_PENDING_PER_USER = 5;
const DEPOSIT_METHODS = (process.env.DEPOSIT_METHODS || 'Telebirr,CBE Birr,Awash Bank,Bank of Abyssinia')
  .split(',').map(s => s.trim()).filter(Boolean);
const PAYMENT_INFO = process.env.PAYMENT_INFO || 'Ask the admin for the account to send your deposit to.';

if (!BOT_TOKEN && IS_PROD && process.env.ALLOW_DEV_LOGIN !== 'true') {
  console.error('FATAL: BOT_TOKEN is required in production (needed to verify Telegram logins).');
  process.exit(1);
}
let SESSION_SECRET = process.env.SESSION_SECRET || '';
if (!SESSION_SECRET) {
  if (IS_PROD) {
    console.error('FATAL: SESSION_SECRET is required in production.');
    process.exit(1);
  }
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[warn] SESSION_SECRET not set - using a random one (sessions reset on restart).');
}
let DEV_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
if (DEV_LOGIN && !DEV_ADMIN_PASSWORD) {
  DEV_ADMIN_PASSWORD = crypto.randomBytes(6).toString('hex');
  console.warn(`[dev] ADMIN_PASSWORD not set. Temporary dev admin password: ${DEV_ADMIN_PASSWORD}`);
}
if (DEV_LOGIN) console.warn('[dev] Dev login is ENABLED (no Telegram verification). Never use this with real money.');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface User {
  id: string;
  username: string;
  firstName: string;
  balance: number;
  isAdmin: boolean;
}

type TxType = 'DEPOSIT' | 'WITHDRAWAL' | 'CARD_PURCHASE' | 'WINNING_PAYOUT' | 'REFUND';
type TxStatus = 'PENDING' | 'COMPLETED' | 'REJECTED';

interface Transaction {
  id: string;
  userId: string;
  type: TxType;
  amount: number;
  status: TxStatus;
  reference: string; // human readable description
  method?: string; // deposit provider
  paymentRef?: string; // provider transaction id (deposits)
  destination?: string; // payout destination (withdrawals)
  createdAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  note?: string;
}

interface Winner { cardId: number; userId: string; username: string; prize: number }

interface Room {
  id: number;
  name: string;
  stake: number;
  maxCards: number;
  status: 'SELECTING_CARDS' | 'RUNNING' | 'COMPLETED';
  timerSeconds: number;
  extensions: number;
  gameId: string;
  calledNumbers: number[];
  availableNumbers: number[]; // SERVER ONLY - never sent to clients
  confirmedCards: Map<number, string>; // cardId -> userId
  cardOwners: Record<number, { userId: string; username: string }>;
  prizePool: number;
  commission: number;
  winners: Winner[];
  completedAt?: string;
}

interface GameHistoryItem {
  gameId: string;
  roomId: number;
  stake: number;
  totalCards: number;
  prizePool: number;
  commission: number;
  winners: { cardId: number; username: string; prize: number }[];
  calledNumbers: number[];
  createdAt: string;
}

interface PersistedRoom extends Omit<Room, 'confirmedCards'> {
  confirmedCards: [number, string][];
}

interface DB {
  users: User[];
  transactions: Transaction[];
  history: GameHistoryItem[];
  rooms: PersistedRoom[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const newId = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;

function secureShuffle<T>(array: T[]): T[] {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function seededRng(seed: number) {
  // mulberry32 - deterministic so card layouts survive restarts
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededPick(rand: () => number, start: number, count: number): number[] {
  const pool = Array.from({ length: 15 }, (_, i) => i + start);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

interface BingoCardDefinition { cardId: number; grid: number[][] }

function generateCardDefinitions(): BingoCardDefinition[] {
  const cards: BingoCardDefinition[] = [];
  for (let cId = 1; cId <= 100; cId++) {
    const rand = seededRng(7919 * cId + 17);
    const b = seededPick(rand, 1, 5);
    const i = seededPick(rand, 16, 5);
    const n = seededPick(rand, 31, 4);
    const g = seededPick(rand, 46, 5);
    const o = seededPick(rand, 61, 5);
    const grid: number[][] = [];
    for (let row = 0; row < 5; row++) {
      grid.push([b[row], i[row], row === 2 ? 0 : n[row < 2 ? row : row - 1], g[row], o[row]]);
    }
    cards.push({ cardId: cId, grid });
  }
  return cards;
}

const cardDefinitions = generateCardDefinitions();
const cardById = new Map(cardDefinitions.map(c => [c.cardId, c]));

function checkWinningCard(grid: number[][], called: Set<number>): boolean {
  const ok = (r: number, c: number) => grid[r][c] === 0 || called.has(grid[r][c]);
  for (let r = 0; r < 5; r++) if ([0, 1, 2, 3, 4].every(c => ok(r, c))) return true;
  for (let c = 0; c < 5; c++) if ([0, 1, 2, 3, 4].every(r => ok(r, c))) return true;
  if ([0, 1, 2, 3, 4].every(i => ok(i, i))) return true;
  if ([0, 1, 2, 3, 4].every(i => ok(i, 4 - i))) return true;
  return false;
}

// ---------------------------------------------------------------------------
// State + persistence (JSON file, atomic writes)
// ---------------------------------------------------------------------------
const users = new Map<string, User>();
let transactions: Transaction[] = [];
let gameHistory: GameHistoryItem[] = [];
const rooms = new Map<number, Room>();

const roomConfigs = [
  { id: 1, name: 'Room 1 (Standard)', stake: 10 },
  { id: 2, name: 'Room 2 (VIP)', stake: 20 },
  { id: 3, name: 'Room 3 (High Roller)', stake: 30 },
];

function freshRoom(cfg: { id: number; name: string; stake: number }): Room {
  return {
    id: cfg.id, name: cfg.name, stake: cfg.stake, maxCards: 100,
    status: 'SELECTING_CARDS', timerSeconds: 60, extensions: 0,
    gameId: newId(`game_${cfg.id}`),
    calledNumbers: [], availableNumbers: [],
    confirmedCards: new Map(), cardOwners: {},
    prizePool: 0, commission: 0, winners: [],
  };
}

function loadDb() {
  let db: Partial<DB> = {};
  try {
    if (fs.existsSync(DATA_FILE)) db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    console.error('FATAL: could not read data file', DATA_FILE, err);
    process.exit(1); // never silently start empty over a corrupted ledger
  }
  (db.users || []).forEach(u => users.set(u.id, u));
  transactions = db.transactions || [];
  gameHistory = db.history || [];
  roomConfigs.forEach(cfg => {
    const saved = (db.rooms || []).find(r => r.id === cfg.id);
    if (saved) {
      rooms.set(cfg.id, { ...freshRoom(cfg), ...saved, confirmedCards: new Map(saved.confirmedCards) });
    } else {
      rooms.set(cfg.id, freshRoom(cfg));
    }
  });
}

let dirty = false;
const markDirty = () => { dirty = true; };

function saveDb() {
  if (!dirty) return;
  dirty = false;
  const db: DB = {
    users: Array.from(users.values()),
    transactions,
    history: gameHistory.slice(0, 500),
    rooms: Array.from(rooms.values()).map(r => ({ ...r, confirmedCards: Array.from(r.confirmedCards.entries()) })),
  };
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    dirty = true;
    console.error('Failed to save database:', err);
  }
}

loadDb();
setInterval(saveDb, 1000);
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { saveDb(); process.exit(0); });
}

function credit(user: User, amount: number) {
  user.balance = round2(user.balance + amount);
}

function addTx(tx: Omit<Transaction, 'id' | 'createdAt'>): Transaction {
  const full: Transaction = { id: newId('tx'), createdAt: new Date().toISOString(), ...tx };
  transactions.push(full);
  markDirty();
  return full;
}

// ---------------------------------------------------------------------------
// Express / WebSocket setup
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : process.env.TRUST_PROXY);
app.use(express.json({ limit: '10kb' }));
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

const server = createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 1024 });

// Tiny in-memory rate limiter
function rateLimit(max: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  setInterval(() => { const now = Date.now(); hits.forEach((v, k) => v.reset < now && hits.delete(k)); }, windowMs).unref();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${req.ip}`;
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) { hits.set(key, { n: 1, reset: now + windowMs }); return next(); }
    if (++h.n > max) return res.status(429).json({ error: 'Too many requests. Slow down.' });
    next();
  };
}

// ---------------------------------------------------------------------------
// Auth: Telegram initData verification + signed session tokens
// ---------------------------------------------------------------------------
function verifyTelegramInitData(initData: string): { id: number; username?: string; first_name?: string } | null {
  if (!BOT_TOKEN || typeof initData !== 'string' || initData.length > 4096) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheckString = Array.from(params.entries())
    .map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const expected = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > 24 * 3600) return null; // stale
  try {
    const u = JSON.parse(params.get('user') || '');
    return typeof u?.id === 'number' ? u : null;
  } catch { return null; }
}

const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000;
function signToken(uid: string): string {
  const body = Buffer.from(JSON.stringify({ uid, exp: Date.now() + TOKEN_TTL_MS })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyToken(token: string): string | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const { uid, exp } = JSON.parse(Buffer.from(body, 'base64url').toString());
    return typeof uid === 'string' && exp > Date.now() ? uid : null;
  } catch { return null; }
}

interface AuthedRequest extends Request { user: User }

function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization || '';
  const uid = header.startsWith('Bearer ') ? verifyToken(header.slice(7)) : null;
  const user = uid ? users.get(uid) : undefined;
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });
  (req as AuthedRequest).user = user;
  next();
}
function requireAdmin(req: Request, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    if (!(req as AuthedRequest).user.isAdmin) return res.status(403).json({ error: 'Admin only.' });
    next();
  });
}

const safeEqual = (a: string, b: string) => {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
};

function upsertUser(id: string, username: string, firstName: string, isAdmin: boolean): User {
  let user = users.get(id);
  if (!user) {
    user = { id, username, firstName, balance: 0, isAdmin };
    users.set(id, user);
  } else {
    user.username = username;
    user.firstName = firstName;
    user.isAdmin = isAdmin;
  }
  markDirty();
  return user;
}

const cleanStr = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// ---------------------------------------------------------------------------
// Public serialisation (never leak availableNumbers / internal maps)
// ---------------------------------------------------------------------------
function publicRoom(r: Room) {
  return {
    id: r.id, name: r.name, stake: r.stake, maxCards: r.maxCards, status: r.status,
    timerSeconds: r.timerSeconds, gameId: r.gameId, calledNumbers: r.calledNumbers,
    prizePool: r.prizePool, commission: 0, winners: r.winners,
    confirmedCardsCount: r.confirmedCards.size,
    confirmedCardsList: Array.from(r.confirmedCards.entries()).map(([cardId, userId]) => ({
      cardId, userId, username: r.cardOwners[cardId]?.username || 'Player',
    })),
  };
}

function broadcastState() {
  if (wss.clients.size === 0) return;
  const payload = JSON.stringify({ type: 'STATE_UPDATE', rooms: Array.from(rooms.values()).map(publicRoom) });
  wss.clients.forEach((client: WebSocket) => {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  });
}

// ---------------------------------------------------------------------------
// Game engine
// ---------------------------------------------------------------------------
function resetRoom(room: Room) {
  room.gameId = newId(`game_${room.id}`);
  room.status = 'SELECTING_CARDS';
  room.timerSeconds = 60;
  room.extensions = 0;
  room.calledNumbers = [];
  room.availableNumbers = [];
  room.confirmedCards.clear();
  room.cardOwners = {};
  room.prizePool = 0;
  room.commission = 0;
  room.winners = [];
  room.completedAt = undefined;
  markDirty();
}

function refundRoom(room: Room) {
  const perUser = new Map<string, number[]>();
  room.confirmedCards.forEach((uid, cid) => perUser.set(uid, [...(perUser.get(uid) || []), cid]));
  perUser.forEach((cards, uid) => {
    const u = users.get(uid);
    if (!u) return;
    const amount = round2(cards.length * room.stake);
    credit(u, amount);
    addTx({
      userId: uid, type: 'REFUND', amount, status: 'COMPLETED',
      reference: `Room ${room.id} cancelled (not enough players) - cards #${cards.join(', #')}`,
    });
  });
  resetRoom(room);
}

function startGame(room: Room) {
  room.status = 'RUNNING';
  room.calledNumbers = [];
  room.availableNumbers = secureShuffle(Array.from({ length: 75 }, (_, i) => i + 1));
  room.winners = [];
  room.prizePool = round2(room.confirmedCards.size * room.stake * (1 - COMMISSION_RATE));
  markDirty();
}

function callNextNumber(room: Room) {
  const next = room.availableNumbers.shift();
  if (next === undefined) return;
  room.calledNumbers.push(next);
  markDirty();

  const called = new Set(room.calledNumbers);
  const found: Winner[] = [];
  room.confirmedCards.forEach((userId, cardId) => {
    const def = cardById.get(cardId);
    if (def && checkWinningCard(def.grid, called)) {
      found.push({ cardId, userId, username: room.cardOwners[cardId]?.username || 'Player', prize: 0 });
    }
  });
  if (found.length === 0) return;

  room.status = 'COMPLETED';
  room.completedAt = new Date().toISOString();
  const totalStakes = round2(room.confirmedCards.size * room.stake);
  const winnerPool = round2(totalStakes * (1 - COMMISSION_RATE));
  const individual = Math.floor((winnerPool / found.length) * 100) / 100;
  room.prizePool = winnerPool;
  room.commission = round2(totalStakes - individual * found.length); // includes rounding dust

  found.forEach(w => {
    w.prize = individual;
    const u = users.get(w.userId);
    if (u) {
      credit(u, individual);
      addTx({
        userId: w.userId, type: 'WINNING_PAYOUT', amount: individual, status: 'COMPLETED',
        reference: `Room ${room.id} Win - Card #${w.cardId}`,
      });
    }
  });
  room.winners = found;
  gameHistory.unshift({
    gameId: room.gameId, roomId: room.id, stake: room.stake, totalCards: room.confirmedCards.size,
    prizePool: room.prizePool, commission: room.commission,
    winners: found.map(w => ({ cardId: w.cardId, username: w.username, prize: w.prize })),
    calledNumbers: [...room.calledNumbers], createdAt: room.completedAt,
  });
}

let tickCount = 0;
setInterval(() => {
  tickCount++;
  rooms.forEach(room => {
    if (room.status === 'SELECTING_CARDS') {
      room.timerSeconds -= 1;
      if (room.timerSeconds <= 0) {
        if (room.confirmedCards.size >= MIN_CARDS) startGame(room);
        else if (room.confirmedCards.size > 0 && room.extensions < MAX_EXTENSIONS) {
          room.extensions++;
          room.timerSeconds = 60;
        } else if (room.confirmedCards.size > 0) refundRoom(room);
        else room.timerSeconds = 60;
      }
    } else if (room.status === 'RUNNING') {
      if (tickCount % 3 === 0) callNextNumber(room);
    } else if (room.status === 'COMPLETED') {
      if (!room.completedAt || Date.now() - new Date(room.completedAt).getTime() >= 15000) resetRoom(room);
    }
  });
  broadcastState();
}, 1000);

// ---------------------------------------------------------------------------
// Public routes
// ---------------------------------------------------------------------------
app.get('/api/config', (_req, res) => {
  res.json({
    devLogin: DEV_LOGIN,
    paymentInfo: PAYMENT_INFO,
    depositMethods: DEPOSIT_METHODS,
    minDeposit: MIN_DEPOSIT, maxDeposit: MAX_DEPOSIT, minWithdraw: MIN_WITHDRAW,
    minCards: MIN_CARDS, maxCardsPerUser: MAX_CARDS_PER_USER,
  });
});

app.get('/api/state', (_req, res) => {
  res.json({ rooms: Array.from(rooms.values()).map(publicRoom), history: gameHistory.slice(0, 20) });
});

app.get('/api/cards', (_req, res) => {
  res.json({ cardDefinitions });
});

app.post('/api/auth', rateLimit(20, 60_000), (req, res) => {
  const { initData, username, firstName, adminPassword } = req.body || {};

  if (typeof initData === 'string' && initData) {
    const tg = verifyTelegramInitData(initData);
    if (!tg) return res.status(401).json({ error: 'Invalid Telegram login.' });
    const id = `tg_${tg.id}`;
    const user = upsertUser(id, cleanStr(tg.username, 64) || `user${tg.id}`, cleanStr(tg.first_name, 64) || 'Player', ADMIN_IDS.has(id));
    return res.json({ token: signToken(id), user });
  }

  if (!DEV_LOGIN) return res.status(401).json({ error: 'Open this app from Telegram to log in.' });
  const uname = cleanStr(username, 32).toLowerCase();
  if (!/^[a-z0-9_]{3,32}$/.test(uname)) {
    return res.status(400).json({ error: 'Username must be 3-32 letters, digits or underscores.' });
  }
  const isAdmin = typeof adminPassword === 'string' && adminPassword.length > 0 && safeEqual(adminPassword, DEV_ADMIN_PASSWORD);
  const id = `dev_${uname}`;
  const user = upsertUser(id, uname, cleanStr(firstName, 64) || uname, isAdmin);
  res.json({ token: signToken(id), user });
});

// ---------------------------------------------------------------------------
// Authenticated user routes
// ---------------------------------------------------------------------------
app.get('/api/me', requireAuth, (req, res) => {
  const user = (req as AuthedRequest).user;
  res.json({ user, transactions: transactions.filter(t => t.userId === user.id).slice(-100).reverse() });
});

app.post('/api/cards/purchase', requireAuth, rateLimit(60, 60_000), (req, res) => {
  const user = (req as AuthedRequest).user;
  const { roomId, cardIds } = req.body || {};
  const room = rooms.get(Number(roomId));
  if (!room) return res.status(400).json({ error: 'Invalid room.' });
  if (room.status !== 'SELECTING_CARDS') return res.status(400).json({ error: 'Card selection is closed for this game.' });

  if (!Array.isArray(cardIds) || cardIds.length === 0 || cardIds.length > MAX_CARDS_PER_USER) {
    return res.status(400).json({ error: `Choose between 1 and ${MAX_CARDS_PER_USER} cards.` });
  }
  if (!cardIds.every(c => Number.isInteger(c) && c >= 1 && c <= room.maxCards) || new Set(cardIds).size !== cardIds.length) {
    return res.status(400).json({ error: 'Invalid card selection.' });
  }
  let owned = 0;
  room.confirmedCards.forEach(uid => { if (uid === user.id) owned++; });
  if (owned + cardIds.length > MAX_CARDS_PER_USER) {
    return res.status(400).json({ error: `You can hold at most ${MAX_CARDS_PER_USER} cards per game in this room.` });
  }
  const taken = cardIds.find((c: number) => room.confirmedCards.has(c));
  if (taken !== undefined) return res.status(400).json({ error: `Card #${taken} is already taken in this room.` });

  const totalCost = round2(cardIds.length * room.stake);
  if (user.balance < totalCost) return res.status(400).json({ error: 'Insufficient wallet balance.' });

  user.balance = round2(user.balance - totalCost);
  cardIds.forEach((cId: number) => {
    room.confirmedCards.set(cId, user.id);
    room.cardOwners[cId] = { userId: user.id, username: user.username };
  });
  room.prizePool = round2(room.confirmedCards.size * room.stake * (1 - COMMISSION_RATE));
  addTx({
    userId: user.id, type: 'CARD_PURCHASE', amount: totalCost, status: 'COMPLETED',
    reference: `Room ${room.id} - ${cardIds.length} card(s): #${cardIds.join(', #')}`,
  });
  broadcastState();
  res.json({ success: true, newBalance: user.balance });
});

function pendingCount(userId: string) {
  return transactions.filter(t => t.userId === userId && t.status === 'PENDING').length;
}

// Deposit REQUEST: the user pays the platform account outside the app, then submits the
// provider's transaction reference. Balance is only credited when an admin approves it.
app.post('/api/wallet/deposit', requireAuth, rateLimit(20, 60_000), (req, res) => {
  const user = (req as AuthedRequest).user;
  const amount = round2(Number(req.body?.amount));
  const method = cleanStr(req.body?.method, 40);
  const paymentRef = cleanStr(req.body?.reference, 40).toUpperCase();

  if (!Number.isFinite(amount) || amount < MIN_DEPOSIT || amount > MAX_DEPOSIT) {
    return res.status(400).json({ error: `Deposit must be between ${MIN_DEPOSIT} and ${MAX_DEPOSIT} ETB.` });
  }
  if (!DEPOSIT_METHODS.includes(method)) return res.status(400).json({ error: 'Unsupported payment method.' });
  if (!/^[A-Z0-9\-_.]{4,40}$/.test(paymentRef)) {
    return res.status(400).json({ error: 'Enter the transaction reference from your payment receipt (4-40 letters/digits).' });
  }
  if (pendingCount(user.id) >= MAX_PENDING_PER_USER) {
    return res.status(400).json({ error: 'You have too many pending requests. Wait for the admin to review them.' });
  }
  const duplicate = transactions.some(t =>
    t.type === 'DEPOSIT' && t.status !== 'REJECTED' && t.method === method && t.paymentRef === paymentRef);
  if (duplicate) return res.status(409).json({ error: 'This transaction reference was already submitted.' });

  const tx = addTx({
    userId: user.id, type: 'DEPOSIT', amount, status: 'PENDING',
    reference: `${method} - Ref: ${paymentRef}`, method, paymentRef,
  });
  res.json({ success: true, transaction: tx, newBalance: user.balance });
});

// Withdrawal REQUEST: funds are held (deducted) immediately, an admin pays out manually and approves.
app.post('/api/wallet/withdraw', requireAuth, rateLimit(20, 60_000), (req, res) => {
  const user = (req as AuthedRequest).user;
  const amount = round2(Number(req.body?.amount));
  const destination = cleanStr(req.body?.destination, 100);

  if (!Number.isFinite(amount) || amount < MIN_WITHDRAW) {
    return res.status(400).json({ error: `Minimum withdrawal is ${MIN_WITHDRAW} ETB.` });
  }
  if (amount > user.balance) return res.status(400).json({ error: 'Insufficient balance.' });
  if (destination.length < 5) return res.status(400).json({ error: 'Enter your payout account details.' });
  if (pendingCount(user.id) >= MAX_PENDING_PER_USER) {
    return res.status(400).json({ error: 'You have too many pending requests. Wait for the admin to review them.' });
  }

  user.balance = round2(user.balance - amount);
  const tx = addTx({
    userId: user.id, type: 'WITHDRAWAL', amount, status: 'PENDING',
    reference: `Payout to ${destination}`, destination,
  });
  res.json({ success: true, transaction: tx, newBalance: user.balance });
});

// ---------------------------------------------------------------------------
// Admin routes
// ---------------------------------------------------------------------------
// Admin-only testing aid: fills a room with synthetic (non-wallet) cards and
// starts the draw immediately, for demoing/testing without real players.
app.post('/api/rooms/simulate', requireAdmin, rateLimit(30, 60_000), (req, res) => {
  const room = rooms.get(Number(req.body?.roomId));
  if (!room) return res.status(400).json({ error: 'Invalid room.' });
  if (room.status !== 'SELECTING_CARDS') return res.status(400).json({ error: 'Room is not accepting cards right now.' });

  const target = Math.min(room.maxCards, Math.max(MIN_CARDS, 50));
  const free = Array.from({ length: room.maxCards }, (_, i) => i + 1).filter(id => !room.confirmedCards.has(id));
  const need = Math.max(0, target - room.confirmedCards.size);
  secureShuffle(free).slice(0, need).forEach((cardId, idx) => {
    const botId = `sim_bot_${cardId}`;
    room.confirmedCards.set(cardId, botId);
    room.cardOwners[cardId] = { userId: botId, username: `player_${1000 + idx}` };
  });
  room.prizePool = round2(room.confirmedCards.size * room.stake * (1 - COMMISSION_RATE));
  room.timerSeconds = 0; // let the next game tick start the draw
  markDirty();
  broadcastState();
  res.json({ success: true, cardsSold: room.confirmedCards.size });
});

app.get('/api/admin/stats', requireAdmin, (_req, res) => {
  const sum = (f: (t: Transaction) => boolean) => round2(transactions.filter(f).reduce((a, t) => a + t.amount, 0));
  res.json({
    totalGamesPlayed: gameHistory.length,
    totalCommissionEarned: round2(gameHistory.reduce((a, h) => a + (h.commission || 0), 0)),
    totalUserBalances: round2(Array.from(users.values()).reduce((a, u) => a + u.balance, 0)),
    totalDeposited: sum(t => t.type === 'DEPOSIT' && t.status === 'COMPLETED'),
    totalWithdrawn: sum(t => t.type === 'WITHDRAWAL' && t.status === 'COMPLETED'),
    pendingDeposits: transactions.filter(t => t.type === 'DEPOSIT' && t.status === 'PENDING').length,
    pendingWithdrawals: transactions.filter(t => t.type === 'WITHDRAWAL' && t.status === 'PENDING').length,
    activeRooms: Array.from(rooms.values()).map(r => ({
      id: r.id, name: r.name, status: r.status, cardsSold: r.confirmedCards.size, prizePool: r.prizePool,
    })),
  });
});

app.get('/api/admin/transactions', requireAdmin, (req, res) => {
  const status = cleanStr(req.query.status, 20) || 'PENDING';
  const list = transactions
    .filter(t => (t.type === 'DEPOSIT' || t.type === 'WITHDRAWAL') && (status === 'ALL' || t.status === status))
    .slice(-200)
    .reverse()
    .map(t => {
      const u = users.get(t.userId);
      return { ...t, username: u?.username || 'unknown', userBalance: u?.balance ?? 0 };
    });
  res.json({ transactions: list });
});

app.post('/api/admin/transactions/:id/:action', requireAdmin, rateLimit(120, 60_000), (req, res) => {
  const admin = (req as AuthedRequest).user;
  const { id, action } = req.params;
  if (action !== 'approve' && action !== 'reject') return res.status(400).json({ error: 'Invalid action.' });

  const tx = transactions.find(t => t.id === id);
  if (!tx || (tx.type !== 'DEPOSIT' && tx.type !== 'WITHDRAWAL')) return res.status(404).json({ error: 'Request not found.' });
  if (tx.status !== 'PENDING') return res.status(409).json({ error: `Already ${tx.status.toLowerCase()}.` });
  if (tx.userId === admin.id && !ALLOW_SELF_APPROVAL) {
    return res.status(403).json({ error: 'You cannot review your own request. Ask another admin.' });
  }
  const owner = users.get(tx.userId);
  if (!owner) return res.status(404).json({ error: 'User not found.' });

  if (action === 'approve') {
    if (tx.type === 'DEPOSIT') credit(owner, tx.amount); // withdrawal funds were already held
    tx.status = 'COMPLETED';
  } else {
    if (tx.type === 'WITHDRAWAL') credit(owner, tx.amount); // release the held funds
    tx.status = 'REJECTED';
  }
  tx.reviewedBy = admin.username;
  tx.reviewedAt = new Date().toISOString();
  tx.note = cleanStr(req.body?.note, 200) || undefined;
  markDirty();
  console.log(`[admin] ${admin.username} ${action}d ${tx.type} ${tx.id} (${tx.amount} ETB) for ${owner.username}`);
  res.json({ success: true, transaction: tx });
});

// ---------------------------------------------------------------------------
// Errors + static / vite
// ---------------------------------------------------------------------------
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
    return res.status(400).json({ error: 'Bad request body.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Server error.' });
});

async function startServer() {
  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({ server: { middlewareMode: true, hmr: false }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));
  }
  server.listen(PORT, '0.0.0.0', () => console.log(`Beekaa Bingo backend running on port ${PORT}`));
}

startServer();
