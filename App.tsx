import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Trophy, Wallet, Ticket, BookOpen, Settings, Play, Users,
  Clock, CheckCircle2, ArrowUpRight, ArrowDownLeft, ShieldCheck,
  Sparkles, AlertCircle, RefreshCw, Smartphone, Bot, ChevronRight,
  Hash, Flame, Volume2, VolumeX, Mic, MicOff, FastForward, Star,
  LogIn, Loader2, Check, X, Clock3
} from 'lucide-react';

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

interface Room {
  id: number;
  name: string;
  stake: number;
  maxCards: number;
  status: 'SELECTING_CARDS' | 'RUNNING' | 'COMPLETED';
  timerSeconds: number;
  gameId: string;
  calledNumbers: number[];
  confirmedCardsCount: number;
  confirmedCardsList: { cardId: number; userId: string; username: string }[];
  prizePool: number;
  commission: number;
  winners: { cardId: number; userId: string; username: string; prize: number }[];
}

interface CardDefinition {
  cardId: number;
  grid: number[][];
}

interface Transaction {
  id: string;
  userId?: string;
  username?: string;
  userBalance?: number;
  type: string;
  amount: number;
  status: 'PENDING' | 'COMPLETED' | 'REJECTED';
  reference: string;
  method?: string;
  paymentRef?: string;
  destination?: string;
  createdAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  note?: string;
}

interface AppConfig {
  devLogin: boolean;
  paymentInfo: string;
  depositMethods: string[];
  minDeposit: number;
  maxDeposit: number;
  minWithdraw: number;
  minCards: number;
  maxCardsPerUser: number;
}

const INITIAL_ROOMS: Room[] = [
  { id: 1, name: 'Room 1 (Standard)', stake: 10, maxCards: 100, status: 'SELECTING_CARDS', timerSeconds: 60, gameId: 'init', calledNumbers: [], confirmedCardsCount: 0, confirmedCardsList: [], prizePool: 0, commission: 0, winners: [] },
  { id: 2, name: 'Room 2 (VIP)', stake: 20, maxCards: 100, status: 'SELECTING_CARDS', timerSeconds: 60, gameId: 'init', calledNumbers: [], confirmedCardsCount: 0, confirmedCardsList: [], prizePool: 0, commission: 0, winners: [] },
  { id: 3, name: 'Room 3 (High Roller)', stake: 30, maxCards: 100, status: 'SELECTING_CARDS', timerSeconds: 60, gameId: 'init', calledNumbers: [], confirmedCardsCount: 0, confirmedCardsList: [], prizePool: 0, commission: 0, winners: [] },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getBingoLetterInfo(num: number): { letter: 'B'|'I'|'N'|'G'|'O'; label: string; badgeBg: string; headerBg: string; textColor: string; ringColor: string } {
  if (num <= 15) return { letter: 'B', label: 'B', badgeBg: 'bg-blue-600', headerBg: 'bg-blue-600/90 text-white', textColor: 'text-blue-400', ringColor: 'ring-blue-500' };
  if (num <= 30) return { letter: 'I', label: 'I', badgeBg: 'bg-rose-600', headerBg: 'bg-rose-600/90 text-white', textColor: 'text-rose-400', ringColor: 'ring-rose-500' };
  if (num <= 45) return { letter: 'N', label: 'N', badgeBg: 'bg-amber-500', headerBg: 'bg-amber-500/90 text-slate-950 font-black', textColor: 'text-amber-400', ringColor: 'ring-amber-500' };
  if (num <= 60) return { letter: 'G', label: 'G', badgeBg: 'bg-emerald-600', headerBg: 'bg-emerald-600/90 text-white', textColor: 'text-emerald-400', ringColor: 'ring-emerald-500' };
  return { letter: 'O', label: 'O', badgeBg: 'bg-purple-600', headerBg: 'bg-purple-600/90 text-white', textColor: 'text-purple-400', ringColor: 'ring-purple-500' };
}

function generateFallbackCard(cardId: number): number[][] {
  const seed = cardId * 1013;
  const pr = (max: number, offset: number) => ((seed * (offset + 1) * 31) % max) + 1;
  const bPool = Array.from({ length: 15 }, (_, i) => i + 1).sort(() => (pr(100, 1) % 2) - 0.5);
  const iPool = Array.from({ length: 15 }, (_, i) => i + 16).sort(() => (pr(100, 2) % 2) - 0.5);
  const nPool = Array.from({ length: 15 }, (_, i) => i + 31).sort(() => (pr(100, 3) % 2) - 0.5);
  const gPool = Array.from({ length: 15 }, (_, i) => i + 46).sort(() => (pr(100, 4) % 2) - 0.5);
  const oPool = Array.from({ length: 15 }, (_, i) => i + 61).sort(() => (pr(100, 5) % 2) - 0.5);
  const grid: number[][] = [];
  for (let r = 0; r < 5; r++) {
    grid.push([bPool[r], iPool[r], r === 2 ? 0 : nPool[r < 2 ? r : r - 1], gPool[r], oPool[r]]);
  }
  return grid;
}

// ---------------------------------------------------------------------------
// Main App
// ---------------------------------------------------------------------------
export default function App() {
  // Auth
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('bingo_token'));
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [devUsername, setDevUsername] = useState('');
  const [devAdminPw, setDevAdminPw] = useState('');
  const [appConfig, setAppConfig] = useState<AppConfig | null>(null);

  // Game state
  const [activeTab, setActiveTab] = useState<'rooms' | 'wallet' | 'my_cards' | 'rules' | 'admin'>('rooms');
  const [selectedRoomId, setSelectedRoomId] = useState<number>(1);
  const [rooms, setRooms] = useState<Room[]>(INITIAL_ROOMS);
  const [cardDefinitions, setCardDefinitions] = useState<CardDefinition[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [adminStats, setAdminStats] = useState<any>(null);
  const [pendingTxs, setPendingTxs] = useState<Transaction[]>([]);
  const [adminTxFilter, setAdminTxFilter] = useState<'PENDING' | 'COMPLETED' | 'REJECTED'>('PENDING');

  // Card selection
  const [selectedCards, setSelectedCards] = useState<number[]>([]);

  // UI
  const [viewMode, setViewMode] = useState<'miniapp' | 'bot'>('miniapp');
  const [notification, setNotification] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [speechEnabled, setSpeechEnabled] = useState(true);
  const [simulating, setSimulating] = useState(false);

  // Deposit modal
  const [showDepositModal, setShowDepositModal] = useState(false);
  const [depositAmount, setDepositAmount] = useState('250');
  const [depositMethod, setDepositMethod] = useState('');
  const [depositRef, setDepositRef] = useState('');

  // Withdraw modal
  const [showWithdrawModal, setShowWithdrawModal] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawDest, setWithdrawDest] = useState('');

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const prevCalledCountRef = useRef<number>(0);
  const prevGameStatusRef = useRef<string>('SELECTING_CARDS');

  // ---------------------------------------------------------------------------
  // Auth helpers
  // ---------------------------------------------------------------------------
  const authHeaders = useCallback((): Record<string, string> => {
    if (!token) return { 'Content-Type': 'application/json' };
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  }, [token]);

  const showNotification = useCallback((message: string, type: 'success' | 'error') => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 5000);
  }, []);

  // Load config + card definitions (public endpoints)
  useEffect(() => {
    fetch('/api/config').then(r => r.json()).then((cfg: AppConfig) => {
      setAppConfig(cfg);
      if (cfg.depositMethods?.length) setDepositMethod(cfg.depositMethods[0]);
    }).catch(() => {});
    fetch('/api/cards').then(r => r.json()).then(d => {
      if (d.cardDefinitions?.length) setCardDefinitions(d.cardDefinitions);
    }).catch(() => {});
    fetch('/api/state').then(r => r.json()).then(d => {
      if (d.rooms?.length) setRooms(d.rooms);
      if (d.history) setHistory(d.history);
    }).catch(() => {});
  }, []);

  // Try to restore session from stored token
  useEffect(() => {
    if (!token) {
      // Try Telegram WebApp auto-login
      const tg = (window as any).Telegram?.WebApp;
      if (tg?.initData) {
        fetch('/api/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ initData: tg.initData }),
        }).then(r => r.json()).then(data => {
          if (data.token) {
            localStorage.setItem('bingo_token', data.token);
            setToken(data.token);
            setUser(data.user);
          }
          setAuthLoading(false);
        }).catch(() => setAuthLoading(false));
      } else {
        setAuthLoading(false);
      }
      return;
    }
    // Validate stored token
    fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(data => {
        setUser(data.user);
        setTransactions(data.transactions || []);
        setAuthLoading(false);
      })
      .catch((status) => {
        if (status === 401) {
          localStorage.removeItem('bingo_token');
          setToken(null);
        }
        setAuthLoading(false);
      });
  }, [token]);

  // Fetch admin data when admin tab opens
  useEffect(() => {
    if (activeTab === 'admin' && user?.isAdmin && token) {
      fetch('/api/admin/stats', { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.json()).then(setAdminStats).catch(() => {});
      fetch(`/api/admin/transactions?status=${adminTxFilter}`, { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.json()).then(d => setPendingTxs(d.transactions || [])).catch(() => {});
    }
  }, [activeTab, user, token, adminTxFilter]);

  // WebSocket real-time updates
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}`);
    wsRef.current = ws;
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'STATE_UPDATE' && data.rooms) setRooms(data.rooms);
      } catch {}
    };
    return () => ws.close();
  }, []);

  // Re-fetch user balance after transactions
  const refreshMe = useCallback(() => {
    if (!token) return;
    fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(data => {
        setUser(data.user);
        setTransactions(data.transactions || []);
      }).catch(() => {});
  }, [token]);

  // ---------------------------------------------------------------------------
  // Dev login handler
  // ---------------------------------------------------------------------------
  const handleDevLogin = async () => {
    if (!devUsername.trim()) { showNotification('Enter a username', 'error'); return; }
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: devUsername.trim(), firstName: devUsername.trim(), adminPassword: devAdminPw || undefined }),
      });
      const data = await res.json();
      if (data.error) { showNotification(data.error, 'error'); return; }
      localStorage.setItem('bingo_token', data.token);
      setToken(data.token);
      setUser(data.user);
    } catch { showNotification('Login failed', 'error'); }
  };

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------
  const currentRoom = useMemo(() => rooms.find(r => r.id === selectedRoomId) || rooms[0] || INITIAL_ROOMS[0], [rooms, selectedRoomId]);
  const calledSet = useMemo(() => new Set(currentRoom?.calledNumbers || []), [currentRoom?.calledNumbers]);
  const currentDraw = useMemo(() => { const l = currentRoom?.calledNumbers || []; return l.length > 0 ? l[l.length - 1] : null; }, [currentRoom?.calledNumbers]);
  const drawLetterInfo = useMemo(() => currentDraw ? getBingoLetterInfo(currentDraw) : null, [currentDraw]);

  // Live cards to display under draw board — no fake bots
  const cardsToDisplay = useMemo(() => {
    const confirmedList = currentRoom?.confirmedCardsList || [];
    const myCards = confirmedList.filter(c => c.userId === user?.id);
    const opponentCards = confirmedList.filter(c => c.userId !== user?.id);
    const list: { cardId: number; userId: string; username: string; isUser: boolean }[] = [];
    if (myCards.length > 0) {
      list.push({ ...myCards[0], isUser: true });
      if (myCards.length > 1) list.push({ ...myCards[1], isUser: true });
      else if (opponentCards.length > 0) list.push({ ...opponentCards[0], isUser: false });
    } else if (opponentCards.length >= 2) {
      list.push({ ...opponentCards[0], isUser: false });
      list.push({ ...opponentCards[1], isUser: false });
    } else if (opponentCards.length === 1) {
      list.push({ ...opponentCards[0], isUser: false });
    }
    return list;
  }, [currentRoom?.confirmedCardsList, user?.id]);

  const getCardGrid = (cardId: number) => cardDefinitions.find(c => c.cardId === cardId)?.grid ?? generateFallbackCard(cardId);

  const getCardProgress = (grid: number[][]) => {
    let maxMarked = 0, completedLine = false;
    const ok = (r: number, c: number) => grid[r][c] === 0 || calledSet.has(grid[r][c]);
    for (let r = 0; r < 5; r++) {
      const n = [0,1,2,3,4].filter(c => ok(r,c)).length;
      if (n > maxMarked) maxMarked = n;
      if (n === 5) completedLine = true;
    }
    for (let c = 0; c < 5; c++) {
      const n = [0,1,2,3,4].filter(r => ok(r,c)).length;
      if (n > maxMarked) maxMarked = n;
      if (n === 5) completedLine = true;
    }
    const d1 = [0,1,2,3,4].filter(i => ok(i,i)).length;
    const d2 = [0,1,2,3,4].filter(i => ok(i,4-i)).length;
    if (d1 > maxMarked) maxMarked = d1;
    if (d2 > maxMarked) maxMarked = d2;
    if (d1 === 5 || d2 === 5) completedLine = true;
    return { maxMarked, completedLine };
  };

  // ---------------------------------------------------------------------------
  // Audio
  // ---------------------------------------------------------------------------
  const playBallSound = (num: number) => {
    if (!soundEnabled) return;
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!audioCtxRef.current) audioCtxRef.current = new AudioCtx();
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') ctx.resume();
      const baseFreq = num <= 15 ? 330 : num <= 30 ? 392 : num <= 45 ? 440 : num <= 60 ? 523 : 587;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'sine'; osc.frequency.setValueAtTime(baseFreq * 1.4, now); osc.frequency.exponentialRampToValueAtTime(baseFreq, now + 0.12);
      gain.gain.setValueAtTime(0.25, now); gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
      osc.connect(gain); gain.connect(ctx.destination); osc.start(now); osc.stop(now + 0.3);
    } catch {}
    if (speechEnabled && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(`${getBingoLetterInfo(num).letter} ${num}`);
        u.rate = 1.05; window.speechSynthesis.speak(u);
      } catch {}
    }
  };

  const playWinCelebration = () => {
    if (!soundEnabled) return;
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!audioCtxRef.current) audioCtxRef.current = new AudioCtx();
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') ctx.resume();
      [523.25, 659.25, 783.99, 1046.50].forEach((freq, idx) => {
        const osc = ctx.createOscillator(), gain = ctx.createGain();
        const start = ctx.currentTime + idx * 0.1;
        osc.type = 'triangle'; osc.frequency.setValueAtTime(freq, start);
        gain.gain.setValueAtTime(0.2, start); gain.gain.exponentialRampToValueAtTime(0.001, start + 0.4);
        osc.connect(gain); gain.connect(ctx.destination); osc.start(start); osc.stop(start + 0.4);
      });
    } catch {}
    if (speechEnabled && 'speechSynthesis' in window) {
      try { window.speechSynthesis.speak(new SpeechSynthesisUtterance("Bingo! We have a winner!")); } catch {}
    }
  };

  useEffect(() => {
    if (!currentRoom) return;
    const called = currentRoom.calledNumbers || [];
    if (currentRoom.status === 'RUNNING' && called.length > prevCalledCountRef.current) {
      const latest = called[called.length - 1];
      if (latest) playBallSound(latest);
    }
    if (currentRoom.status === 'COMPLETED' && prevGameStatusRef.current !== 'COMPLETED') playWinCelebration();
    prevCalledCountRef.current = called.length;
    prevGameStatusRef.current = currentRoom.status;
  }, [currentRoom?.calledNumbers, currentRoom?.status]);

  // ---------------------------------------------------------------------------
  // Card purchase
  // ---------------------------------------------------------------------------
  const toggleCardSelection = (cardId: number) => {
    if (!currentRoom || currentRoom.status !== 'SELECTING_CARDS') return;
    if (currentRoom.confirmedCardsList?.some(c => c.cardId === cardId)) return;
    const max = appConfig?.maxCardsPerUser ?? 10;
    if (selectedCards.includes(cardId)) {
      setSelectedCards(selectedCards.filter(id => id !== cardId));
    } else {
      if (selectedCards.length >= max) { showNotification(`Maximum ${max} cards per purchase batch`, 'error'); return; }
      setSelectedCards([...selectedCards, cardId]);
    }
  };

  const handlePurchaseCards = async () => {
    if (!user || !token || selectedCards.length === 0) return;
    const totalCost = selectedCards.length * currentRoom.stake;
    if (user.balance < totalCost) { showNotification('Insufficient wallet balance. Please deposit funds.', 'error'); return; }
    try {
      const res = await fetch('/api/cards/purchase', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ roomId: currentRoom.id, cardIds: selectedCards }) });
      const data = await res.json();
      if (data.error) { showNotification(data.error, 'error'); return; }
      setUser(prev => prev ? { ...prev, balance: data.newBalance } : null);
      setSelectedCards([]);
      showNotification(`Purchased ${selectedCards.length} card(s)!`, 'success');
      refreshMe();
    } catch { showNotification('Purchase failed. Try again.', 'error'); }
  };

  // Admin-only simulate
  const handleSimulateGame = async () => {
    if (!user?.isAdmin || !token) { showNotification('Admin only', 'error'); return; }
    setSimulating(true);
    try {
      const res = await fetch('/api/rooms/simulate', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ roomId: currentRoom.id }) });
      const data = await res.json();
      if (data.success) showNotification('Game started with 50 cards!', 'success');
      else showNotification(data.error || 'Failed', 'error');
    } catch { showNotification('Failed to start simulation', 'error'); }
    finally { setSimulating(false); }
  };

  // ---------------------------------------------------------------------------
  // Deposit — submit for admin approval
  // ---------------------------------------------------------------------------
  const handleDeposit = async () => {
    if (!user || !token) return;
    const amt = parseFloat(depositAmount);
    const min = appConfig?.minDeposit ?? 10;
    const max = appConfig?.maxDeposit ?? 100000;
    if (isNaN(amt) || amt < min || amt > max) { showNotification(`Amount must be ${min}–${max} ETB`, 'error'); return; }
    if (!depositMethod) { showNotification('Select a payment method', 'error'); return; }
    if (!depositRef.trim() || depositRef.trim().length < 4) { showNotification('Enter the transaction reference from your receipt (min 4 characters)', 'error'); return; }
    try {
      const res = await fetch('/api/wallet/deposit', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ amount: amt, method: depositMethod, reference: depositRef.trim().toUpperCase() }) });
      const data = await res.json();
      if (data.error) { showNotification(data.error, 'error'); return; }
      setShowDepositModal(false);
      setDepositRef('');
      showNotification('Deposit request submitted! Awaiting admin approval.', 'success');
      refreshMe();
    } catch { showNotification('Deposit request failed', 'error'); }
  };

  // ---------------------------------------------------------------------------
  // Withdrawal — funds held, pending admin payout
  // ---------------------------------------------------------------------------
  const handleWithdraw = async () => {
    if (!user || !token) return;
    const amt = parseFloat(withdrawAmount);
    const min = appConfig?.minWithdraw ?? 50;
    if (isNaN(amt) || amt < min) { showNotification(`Minimum withdrawal is ${min} ETB`, 'error'); return; }
    if (amt > user.balance) { showNotification('Insufficient balance', 'error'); return; }
    if (!withdrawDest.trim() || withdrawDest.trim().length < 5) { showNotification('Enter your payout account details', 'error'); return; }
    try {
      const res = await fetch('/api/wallet/withdraw', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ amount: amt, destination: withdrawDest.trim() }) });
      const data = await res.json();
      if (data.error) { showNotification(data.error, 'error'); return; }
      setUser(prev => prev ? { ...prev, balance: data.newBalance } : null);
      setShowWithdrawModal(false);
      setWithdrawAmount('');
      setWithdrawDest('');
      showNotification(`Withdrawal of ${amt} ETB submitted. Funds held until admin approves payout.`, 'success');
      refreshMe();
    } catch { showNotification('Withdrawal request failed', 'error'); }
  };

  // ---------------------------------------------------------------------------
  // Admin actions
  // ---------------------------------------------------------------------------
  const handleAdminAction = async (txId: string, action: 'approve' | 'reject', note?: string) => {
    if (!token) return;
    try {
      const res = await fetch(`/api/admin/transactions/${txId}/${action}`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ note }) });
      const data = await res.json();
      if (data.error) { showNotification(data.error, 'error'); return; }
      showNotification(`Request ${action}d.`, 'success');
      // Refresh pending list
      fetch(`/api/admin/transactions?status=${adminTxFilter}`, { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.json()).then(d => setPendingTxs(d.transactions || [])).catch(() => {});
      fetch('/api/admin/stats', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()).then(setAdminStats).catch(() => {});
    } catch { showNotification('Action failed', 'error'); }
  };

  // ---------------------------------------------------------------------------
  // Login screen
  // ---------------------------------------------------------------------------
  if (authLoading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center text-slate-100">
        <Loader2 className="w-8 h-8 text-amber-400 animate-spin" />
      </div>
    );
  }

  if (!user) {
    const isTg = !!(window as any).Telegram?.WebApp?.initData;
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-6 space-y-6">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-tr from-amber-500 to-yellow-300 flex items-center justify-center text-slate-950 font-black text-3xl shadow-xl shadow-amber-500/30">B</div>
        <div className="text-center space-y-1">
          <h1 className="text-2xl font-black text-amber-400">BEEKAA BINGO</h1>
          <p className="text-xs text-slate-400">Ethiopia's Premier 75-ball Bingo</p>
        </div>
        {isTg ? (
          <div className="text-center space-y-3">
            <p className="text-xs text-slate-300">Verifying your Telegram identity…</p>
            <Loader2 className="w-6 h-6 text-amber-400 animate-spin mx-auto" />
          </div>
        ) : appConfig?.devLogin ? (
          <div className="w-full max-w-xs space-y-3">
            <p className="text-[11px] text-amber-400/80 text-center bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-2">
              ⚠️ Dev mode — no Telegram verification
            </p>
            <input
              type="text" value={devUsername} onChange={e => setDevUsername(e.target.value)}
              placeholder="Username (letters / digits / _)"
              className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-sm text-slate-100 focus:outline-none focus:border-amber-500"
              onKeyDown={e => e.key === 'Enter' && handleDevLogin()}
            />
            <input
              type="password" value={devAdminPw} onChange={e => setDevAdminPw(e.target.value)}
              placeholder="Admin password (optional)"
              className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-sm text-slate-100 focus:outline-none focus:border-amber-500"
              onKeyDown={e => e.key === 'Enter' && handleDevLogin()}
            />
            <button onClick={handleDevLogin} className="w-full bg-amber-500 hover:bg-amber-400 text-slate-950 font-black py-3 rounded-xl text-sm flex items-center justify-center gap-2 shadow-lg">
              <LogIn className="w-4 h-4" /> Login
            </button>
          </div>
        ) : (
          <div className="text-center space-y-2">
            <AlertCircle className="w-10 h-10 text-rose-400 mx-auto" />
            <p className="text-sm text-slate-300">Open this app inside Telegram to log in.</p>
          </div>
        )}
        {notification && (
          <div className={`fixed top-6 max-w-sm w-[90%] px-4 py-3 rounded-xl shadow-2xl flex items-center space-x-3 border ${notification.type === 'success' ? 'bg-emerald-950/90 border-emerald-500/50 text-emerald-200' : 'bg-rose-950/90 border-rose-500/50 text-rose-200'}`}>
            {notification.type === 'success' ? <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" /> : <AlertCircle className="w-5 h-5 text-rose-400 shrink-0" />}
            <span className="text-xs font-medium">{notification.message}</span>
          </div>
        )}
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Main UI (authenticated)
  // ---------------------------------------------------------------------------
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-start pb-24 selection:bg-amber-500 selection:text-black">

      {/* Header */}
      <header className="w-full max-w-md bg-slate-900 border-b border-slate-800 px-4 py-3 sticky top-0 z-50 shadow-lg flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-amber-500 to-yellow-300 flex items-center justify-center shadow-md shadow-amber-500/20 text-slate-950 font-black text-lg">B</div>
          <div>
            <h1 className="font-bold text-sm tracking-wide text-amber-400 flex items-center gap-1">
              BEEKAA BINGO <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">BOT</span>
            </h1>
            <p className="text-xs text-slate-400">@{user.username}</p>
          </div>
        </div>
        <div className="flex items-center space-x-2">
          <button onClick={() => setViewMode(viewMode === 'miniapp' ? 'bot' : 'miniapp')} className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 px-2.5 py-1.5 rounded-lg border border-slate-700 flex items-center gap-1 transition">
            {viewMode === 'miniapp' ? <Bot className="w-3.5 h-3.5 text-indigo-400" /> : <Smartphone className="w-3.5 h-3.5 text-amber-400" />}
            {viewMode === 'miniapp' ? 'Bot' : 'Mini App'}
          </button>
          <div className="flex items-center gap-1.5 bg-amber-500/10 border border-amber-500/30 px-2.5 py-1 rounded-lg text-amber-300 font-semibold text-xs">
            <Wallet className="w-3.5 h-3.5 text-amber-400" />
            <span>{user.balance.toFixed(2)} ETB</span>
          </div>
        </div>
      </header>

      {/* Notification Toast */}
      {notification && (
        <div className={`fixed top-16 z-50 max-w-sm w-[90%] mx-auto px-4 py-3 rounded-xl shadow-2xl flex items-center space-x-3 border animate-bounce ${notification.type === 'success' ? 'bg-emerald-950/90 border-emerald-500/50 text-emerald-200' : 'bg-rose-950/90 border-rose-500/50 text-rose-200'}`}>
          {notification.type === 'success' ? <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" /> : <AlertCircle className="w-5 h-5 text-rose-400 shrink-0" />}
          <span className="text-xs font-medium">{notification.message}</span>
        </div>
      )}

      <main className="w-full max-w-md flex-1 flex flex-col px-3 py-3 space-y-4">

        {/* Telegram Bot Chat View */}
        {viewMode === 'bot' ? (
          <div className="flex-1 flex flex-col space-y-3 bg-slate-900/60 border border-slate-800 rounded-2xl p-4 shadow-inner">
            <div className="bg-slate-800/80 rounded-2xl p-3 max-w-[85%] self-start border border-slate-700/50 text-xs space-y-2">
              <p className="font-semibold text-amber-400">👋 Welcome, {user.firstName}!</p>
              <p className="text-slate-300">Ethiopia's premier 75-ball Bingo. Win 80% of the prize pool!</p>
              <div className="grid grid-cols-2 gap-2 pt-2">
                <button onClick={() => { setViewMode('miniapp'); setActiveTab('rooms'); }} className="bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold py-2 px-3 rounded-xl text-center shadow transition flex items-center justify-center gap-1.5">
                  <Play className="w-3.5 h-3.5 fill-current" /> Play Bingo
                </button>
                <button onClick={() => { setViewMode('miniapp'); setActiveTab('wallet'); }} className="bg-slate-700 hover:bg-slate-600 text-slate-200 font-semibold py-2 px-3 rounded-xl text-center transition flex items-center justify-center gap-1.5">
                  <Wallet className="w-3.5 h-3.5 text-amber-400" /> Wallet
                </button>
                <button onClick={() => { setViewMode('miniapp'); setActiveTab('my_cards'); }} className="bg-slate-700 hover:bg-slate-600 text-slate-200 font-semibold py-2 px-3 rounded-xl text-center transition flex items-center justify-center gap-1.5">
                  <Ticket className="w-3.5 h-3.5 text-indigo-400" /> My Cards
                </button>
                <button onClick={() => { setViewMode('miniapp'); setActiveTab('rules'); }} className="bg-slate-700 hover:bg-slate-600 text-slate-200 font-semibold py-2 px-3 rounded-xl text-center transition flex items-center justify-center gap-1.5">
                  <BookOpen className="w-3.5 h-3.5 text-emerald-400" /> Rules
                </button>
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* ==================== ROOMS TAB ==================== */}
            {activeTab === 'rooms' && (
              <div className="space-y-3">
                {/* Room switcher */}
                <div className="grid grid-cols-3 gap-1.5 bg-slate-900 p-1 rounded-2xl border border-slate-800 shadow">
                  {rooms.map(room => (
                    <button key={room.id} onClick={() => { setSelectedRoomId(room.id); setSelectedCards([]); }}
                      className={`py-2 px-1 rounded-xl text-xs font-bold transition flex flex-col items-center justify-center gap-0.5 ${selectedRoomId === room.id ? 'bg-amber-500 text-slate-950 shadow-md shadow-amber-500/20' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'}`}>
                      <span>Room {room.id}</span>
                      <span className={`text-[10px] ${selectedRoomId === room.id ? 'text-slate-900 font-extrabold' : 'text-amber-400'}`}>{room.stake} Birr</span>
                    </button>
                  ))}
                </div>

                {/* Room info */}
                <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-3 shadow-md space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className={`w-2.5 h-2.5 rounded-full ${currentRoom.status === 'RUNNING' ? 'bg-emerald-400 animate-ping' : 'bg-amber-400'}`}></span>
                      <h2 className="font-extrabold text-xs text-slate-200 tracking-wide">{currentRoom.name}</h2>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button onClick={() => setSoundEnabled(!soundEnabled)} title={soundEnabled ? 'Mute' : 'Sound on'} className={`p-1.5 rounded-lg border text-xs transition ${soundEnabled ? 'bg-amber-500/20 border-amber-500/40 text-amber-400' : 'bg-slate-800 border-slate-700 text-slate-500'}`}>
                        {soundEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
                      </button>
                      <button onClick={() => setSpeechEnabled(!speechEnabled)} title={speechEnabled ? 'Mute voice' : 'Voice on'} className={`p-1.5 rounded-lg border text-xs transition ${speechEnabled ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-400' : 'bg-slate-800 border-slate-700 text-slate-500'}`}>
                        {speechEnabled ? <Mic className="w-3.5 h-3.5" /> : <MicOff className="w-3.5 h-3.5" />}
                      </button>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider ${currentRoom.status === 'SELECTING_CARDS' ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' : currentRoom.status === 'RUNNING' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-purple-500/20 text-purple-400 border border-purple-500/30'}`}>
                        {currentRoom.status === 'SELECTING_CARDS' ? `Selection (${currentRoom.timerSeconds}s)` : currentRoom.status === 'RUNNING' ? 'Live Draw' : 'Game Over'}
                      </span>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center text-xs">
                    <div className="bg-slate-950/70 border border-slate-800/80 rounded-xl p-1.5">
                      <div className="text-[9px] text-slate-400">Sold Cards</div>
                      <div className="text-xs font-bold text-amber-400">{currentRoom.confirmedCardsCount} / 100</div>
                    </div>
                    <div className="bg-slate-950/70 border border-slate-800/80 rounded-xl p-1.5">
                      <div className="text-[9px] text-slate-400">Prize (80%)</div>
                      <div className="text-xs font-bold text-emerald-400">{(currentRoom.confirmedCardsCount * currentRoom.stake * 0.8).toFixed(0)} ETB</div>
                    </div>
                    <div className="bg-slate-950/70 border border-slate-800/80 rounded-xl p-1.5">
                      <div className="text-[9px] text-slate-400">Calls Drawn</div>
                      <div className="text-xs font-bold text-indigo-400">{currentRoom.calledNumbers.length} / 75</div>
                    </div>
                  </div>
                </div>

                {/* Draw Board */}
                <div className="bg-gradient-to-b from-slate-900 via-slate-900 to-slate-950 border border-slate-800 rounded-3xl p-4 shadow-xl relative overflow-hidden">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-1.5 text-xs font-extrabold text-slate-300">
                      <Flame className="w-4 h-4 text-amber-500" /> <span>CURRENT DRAW BOARD</span>
                    </div>
                    {currentRoom.status === 'RUNNING' && (
                      <span className="text-[10px] font-bold text-emerald-400 bg-emerald-950/60 border border-emerald-500/40 px-2 py-0.5 rounded-full flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping"></span> Calling every 3s
                      </span>
                    )}
                  </div>
                  <div className="flex flex-col items-center justify-center py-2">
                    {currentDraw && drawLetterInfo ? (
                      <div key={currentDraw} className="animate-ball-pop relative flex items-center justify-center">
                        <div className={`w-28 h-28 rounded-full ${drawLetterInfo.badgeBg} opacity-20 blur-xl absolute inset-0 -m-2 animate-pulse`}></div>
                        <div className="w-24 h-24 rounded-full bg-gradient-to-br from-slate-800 via-slate-900 to-slate-950 border-4 border-amber-400 shadow-2xl flex flex-col items-center justify-center relative ring-4 ring-amber-400/20">
                          <div className="absolute top-1.5 left-3 w-5 h-2.5 bg-white/30 rounded-full blur-[1px]"></div>
                          <div className={`px-2 py-0.5 rounded-full ${drawLetterInfo.badgeBg} text-white font-black text-xs uppercase tracking-wider shadow-sm mb-0.5`}>{drawLetterInfo.letter}</div>
                          <div className="text-3xl font-black text-slate-100 tracking-tighter drop-shadow-md">{currentDraw}</div>
                        </div>
                      </div>
                    ) : (
                      <div className="w-24 h-24 rounded-full bg-slate-900 border-2 border-dashed border-slate-800 flex flex-col items-center justify-center text-slate-600">
                        <Hash className="w-6 h-6 stroke-1 mb-1" /><span className="text-[10px] font-semibold">Waiting draw</span>
                      </div>
                    )}
                    <div className="text-center mt-2">
                      {currentRoom.status === 'RUNNING' ? (
                        <p className="text-xs font-bold text-amber-400">{currentDraw ? `Ball #${currentRoom.calledNumbers.length}: ${drawLetterInfo?.letter}-${currentDraw}` : 'Preparing first draw...'}</p>
                      ) : currentRoom.status === 'COMPLETED' ? (
                        <p className="text-xs font-bold text-purple-400">Game Completed — Winning line verified!</p>
                      ) : (
                        <p className="text-xs text-slate-400">Draw begins when minimum cards are confirmed.</p>
                      )}
                    </div>
                  </div>
                  {currentRoom.calledNumbers.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-slate-800/80 flex items-center justify-between">
                      <span className="text-[10px] font-semibold text-slate-400">Recent:</span>
                      <div className="flex gap-1.5">
                        {currentRoom.calledNumbers.slice(-6, -1).reverse().map((num, i) => {
                          const info = getBingoLetterInfo(num);
                          return <span key={i} className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md ${info.badgeBg} text-white shadow-sm flex items-center gap-0.5`}><span className="text-[9px] opacity-80">{info.letter}</span><span>{num}</span></span>;
                        })}
                      </div>
                    </div>
                  )}
                  {currentRoom.status === 'COMPLETED' && currentRoom.winners?.length > 0 && (
                    <div className="mt-3 bg-gradient-to-r from-amber-500/20 via-yellow-500/20 to-amber-500/20 border border-amber-500/50 rounded-2xl p-3 text-center space-y-1 animate-pulse">
                      <div className="flex items-center justify-center gap-1.5 text-amber-300 font-black text-sm"><Trophy className="w-5 h-5 text-amber-400" /> BINGO WINNER!</div>
                      {currentRoom.winners.map((w, idx) => (
                        <p key={idx} className="text-xs text-slate-200">Card <strong className="text-amber-300">#{w.cardId}</strong> · <span className="font-bold text-white">@{w.username}</span> won <span className="text-emerald-400 font-black">{w.prize.toFixed(2)} ETB</span></p>
                      ))}
                    </div>
                  )}
                </div>

                {/* Flashboard */}
                <div className="bg-slate-900 border border-slate-800 rounded-3xl p-3 shadow-xl space-y-2">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-bold text-slate-200 flex items-center gap-1"><Hash className="w-3.5 h-3.5 text-indigo-400" /> MASTER FLASHBOARD (1–75)</span>
                    <span className="text-[10px] text-slate-400">Called: <strong className="text-amber-400 font-bold">{calledSet.size}</strong> / 75</span>
                  </div>
                  <div className="space-y-1 bg-slate-950 p-2 rounded-2xl border border-slate-800">
                    {[
                      { letter: 'B', min: 1, max: 15, bg: 'bg-blue-600', text: 'text-white' },
                      { letter: 'I', min: 16, max: 30, bg: 'bg-rose-600', text: 'text-white' },
                      { letter: 'N', min: 31, max: 45, bg: 'bg-amber-500', text: 'text-slate-950' },
                      { letter: 'G', min: 46, max: 60, bg: 'bg-emerald-600', text: 'text-white' },
                      { letter: 'O', min: 61, max: 75, bg: 'bg-purple-600', text: 'text-white' },
                    ].map(row => (
                      <div key={row.letter} className="flex items-center gap-1">
                        <div className={`w-5 h-5 rounded-md ${row.bg} ${row.text} font-black text-[10px] flex items-center justify-center shrink-0 shadow-sm`}>{row.letter}</div>
                        <div className="grid gap-0.5 flex-1" style={{ gridTemplateColumns: 'repeat(15, minmax(0, 1fr))' }}>
                          {Array.from({ length: 15 }, (_, i) => row.min + i).map(num => {
                            const isCalled = calledSet.has(num), isCurrent = currentDraw === num;
                            return (
                              <div key={num} className={`aspect-square rounded text-[9px] font-bold flex items-center justify-center transition-all ${isCurrent ? 'bg-yellow-300 text-slate-950 ring-2 ring-yellow-400 ring-offset-1 ring-offset-slate-900 font-black animate-pulse scale-110 z-10 shadow-md' : isCalled ? 'bg-amber-400 text-slate-950 font-black shadow-sm' : 'bg-slate-900/80 text-slate-600 border border-slate-800/60'}`}>
                                {num}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Live cards */}
                {cardsToDisplay.length > 0 && (
                  <div className="bg-slate-900 border border-slate-800 rounded-3xl p-3 shadow-xl space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5"><Ticket className="w-4 h-4 text-amber-400" /><span className="text-xs font-bold text-slate-200">LIVE PLAYERS' CARDS</span></div>
                      <span className="text-[10px] bg-slate-800 px-2 py-0.5 rounded-full text-slate-400">Showing {cardsToDisplay.length} active</span>
                    </div>
                    <div className="space-y-4">
                      {cardsToDisplay.map(cardInfo => {
                        const grid = getCardGrid(cardInfo.cardId);
                        const progress = getCardProgress(grid);
                        return (
                          <div key={cardInfo.cardId} className={`bg-slate-950 rounded-2xl p-3 border transition-all ${progress.completedLine ? 'border-amber-400 shadow-xl shadow-amber-500/20 ring-2 ring-amber-400/50' : cardInfo.isUser ? 'border-amber-500/40 shadow-md' : 'border-slate-800'}`}>
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-black text-amber-400">Card #{cardInfo.cardId}</span>
                                <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${cardInfo.isUser ? 'bg-amber-500 text-slate-950' : 'bg-slate-800 text-slate-300'}`}>{cardInfo.isUser ? '🌟 YOUR CARD' : `👤 @${cardInfo.username}`}</span>
                              </div>
                              <div className="text-[10px] font-semibold">
                                {progress.completedLine ? <span className="text-emerald-400 font-black animate-pulse flex items-center gap-1"><Trophy className="w-3 h-3" /> BINGO!</span> : <span className="text-slate-400">{progress.maxMarked}/5</span>}
                              </div>
                            </div>
                            <div className="rounded-xl overflow-hidden border border-slate-800">
                              <div className="grid grid-cols-5 text-center font-black text-[11px] py-1 border-b border-slate-800 bg-slate-900">
                                <div className="text-blue-400">B</div><div className="text-rose-400">I</div><div className="text-amber-400">N</div><div className="text-emerald-400">G</div><div className="text-purple-400">O</div>
                              </div>
                              <div className="grid grid-cols-5 gap-0.5 bg-slate-900 p-0.5">
                                {grid.map((row, rIdx) => row.map((cellNum, cIdx2) => {
                                  const isFree = rIdx === 2 && cIdx2 === 2, isMarked = isFree || calledSet.has(cellNum), isCurr = cellNum === currentDraw;
                                  return (
                                    <div key={`${rIdx}-${cIdx2}`} className={`aspect-square flex flex-col items-center justify-center rounded text-xs font-black transition-all ${isFree ? 'bg-amber-500 text-slate-950 ring-1 ring-amber-300' : isCurr ? 'bg-yellow-300 text-slate-950 ring-2 ring-yellow-400 font-extrabold animate-chip-stamp scale-105 z-10 shadow-md' : isMarked ? 'bg-gradient-to-tr from-amber-400 to-yellow-300 text-slate-950 shadow-sm border border-yellow-200' : 'bg-slate-950 text-slate-200 border border-slate-800/80 font-bold'}`}>
                                      {isFree ? <div className="flex flex-col items-center"><Star className="w-3 h-3 fill-current text-slate-950" /><span className="text-[7px] font-black uppercase">FREE</span></div> : <span>{cellNum}</span>}
                                    </div>
                                  );
                                }))}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Card selection */}
                {currentRoom.status === 'SELECTING_CARDS' ? (
                  <div className="bg-slate-900 border border-slate-800 rounded-3xl p-4 shadow-xl space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-200">Buy Cards ({currentRoom.stake} ETB each)</span>
                      <span className="text-xs font-black text-amber-400">Selected: {selectedCards.length} ({selectedCards.length * currentRoom.stake} ETB)</span>
                    </div>
                    <div className="grid grid-cols-10 gap-1 bg-slate-950 p-2 rounded-2xl border border-slate-800 max-h-48 overflow-y-auto">
                      {Array.from({ length: 100 }, (_, i) => i + 1).map(cardId => {
                        const isTaken = currentRoom.confirmedCardsList?.some(c => c.cardId === cardId);
                        const isSelected = selectedCards.includes(cardId);
                        return (
                          <button key={cardId} disabled={isTaken} onClick={() => toggleCardSelection(cardId)}
                            className={`aspect-square rounded-md text-[10px] font-bold flex items-center justify-center transition ${isTaken ? 'bg-slate-800 text-slate-600 cursor-not-allowed line-through' : isSelected ? 'bg-amber-500 text-slate-950 shadow-md shadow-amber-500/30 scale-105 z-10' : 'bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800'}`}>
                            {cardId}
                          </button>
                        );
                      })}
                    </div>
                    <button disabled={selectedCards.length === 0} onClick={handlePurchaseCards}
                      className={`w-full py-3 rounded-2xl font-black text-xs uppercase tracking-wider transition flex items-center justify-center gap-2 shadow-lg ${selectedCards.length > 0 ? 'bg-gradient-to-r from-amber-500 to-yellow-400 text-slate-950 hover:brightness-115 shadow-amber-500/20 cursor-pointer' : 'bg-slate-800 text-slate-500 cursor-not-allowed'}`}>
                      <Ticket className="w-4 h-4" /> Confirm & Pay {selectedCards.length * currentRoom.stake} ETB ({selectedCards.length} Cards)
                    </button>
                    {/* Simulate button — admin only */}
                    {user.isAdmin && (
                      <button onClick={handleSimulateGame} disabled={simulating} className="w-full py-2.5 bg-indigo-600/20 hover:bg-indigo-600/30 border border-indigo-500/40 text-indigo-300 rounded-xl font-bold text-xs flex items-center justify-center gap-1.5 transition">
                        <FastForward className="w-3.5 h-3.5 text-indigo-400" />
                        {simulating ? 'Starting...' : '⚡ [Admin] Fast Fill (50 Cards) & Start'}
                      </button>
                    )}
                  </div>
                ) : (
                  user.isAdmin && (
                    <div className="pt-1">
                      <button onClick={handleSimulateGame} disabled={simulating} className="w-full py-3 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 rounded-2xl font-bold text-xs flex items-center justify-center gap-2 transition">
                        <RefreshCw className="w-3.5 h-3.5 text-amber-400" /> [Admin] Restart / Launch New Game
                      </button>
                    </div>
                  )
                )}
              </div>
            )}

            {/* ==================== WALLET TAB ==================== */}
            {activeTab === 'wallet' && (
              <div className="space-y-4">
                <div className="bg-gradient-to-br from-amber-500/20 via-slate-900 to-slate-900 border border-amber-500/30 rounded-3xl p-5 shadow-xl relative overflow-hidden">
                  <div className="text-xs text-amber-300 font-semibold uppercase tracking-wider mb-1">Available Balance</div>
                  <div className="text-3xl font-black text-amber-400 mb-4">{user.balance.toFixed(2)} <span className="text-sm font-normal text-slate-400">ETB</span></div>
                  <div className="grid grid-cols-2 gap-3">
                    <button onClick={() => setShowDepositModal(true)} className="bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold py-2.5 px-4 rounded-xl text-xs flex items-center justify-center gap-2 shadow transition">
                      <ArrowDownLeft className="w-4 h-4 stroke-[3]" /> Deposit
                    </button>
                    <button onClick={() => setShowWithdrawModal(true)} className="bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold py-2.5 px-4 rounded-xl text-xs flex items-center justify-center gap-2 border border-slate-700 transition">
                      <ArrowUpRight className="w-4 h-4 stroke-[3]" /> Withdraw
                    </button>
                  </div>
                </div>

                {/* Ledger */}
                <div className="bg-slate-900 border border-slate-800 rounded-3xl p-4 space-y-3">
                  <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                    <ShieldCheck className="w-4 h-4 text-emerald-400" /> Transaction Ledger
                  </h3>
                  <div className="space-y-2 max-h-80 overflow-y-auto">
                    {transactions.length === 0 ? (
                      <p className="text-xs text-slate-500 text-center py-6">No transactions recorded yet.</p>
                    ) : (
                      transactions.map(tx => (
                        <div key={tx.id} className="bg-slate-950/60 border border-slate-800/80 rounded-xl p-3 flex items-center justify-between text-xs">
                          <div className="flex items-center gap-2.5">
                            <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${tx.type === 'DEPOSIT' ? 'bg-emerald-500/20 text-emerald-400' : tx.type === 'WINNING_PAYOUT' || tx.type === 'REFUND' ? 'bg-amber-500/20 text-amber-400' : tx.type === 'CARD_PURCHASE' ? 'bg-indigo-500/20 text-indigo-400' : 'bg-rose-500/20 text-rose-400'}`}>
                              {tx.type === 'DEPOSIT' ? <ArrowDownLeft className="w-4 h-4" /> : tx.type === 'WINNING_PAYOUT' || tx.type === 'REFUND' ? <Trophy className="w-4 h-4" /> : tx.type === 'CARD_PURCHASE' ? <Ticket className="w-4 h-4" /> : <ArrowUpRight className="w-4 h-4" />}
                            </div>
                            <div>
                              <div className="font-bold text-slate-200 flex items-center gap-1">
                                {tx.type.replace(/_/g, ' ')}
                                {tx.status === 'PENDING' && <span className="text-[9px] bg-amber-500/20 text-amber-400 border border-amber-500/30 px-1.5 py-0.5 rounded-full font-bold uppercase ml-1">Pending</span>}
                                {tx.status === 'REJECTED' && <span className="text-[9px] bg-rose-500/20 text-rose-400 border border-rose-500/30 px-1.5 py-0.5 rounded-full font-bold uppercase ml-1">Rejected</span>}
                              </div>
                              <div className="text-[10px] text-slate-400">{tx.reference}</div>
                            </div>
                          </div>
                          <div className={`font-black text-right ${tx.type === 'DEPOSIT' || tx.type === 'WINNING_PAYOUT' || tx.type === 'REFUND' ? (tx.status === 'PENDING' ? 'text-slate-400' : 'text-emerald-400') : 'text-rose-400'}`}>
                            {tx.type === 'DEPOSIT' || tx.type === 'WINNING_PAYOUT' || tx.type === 'REFUND' ? '+' : '-'}{tx.amount.toFixed(2)} ETB
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* ==================== MY CARDS TAB ==================== */}
            {activeTab === 'my_cards' && (
              <div className="space-y-4">
                <div className="bg-slate-900 border border-slate-800 rounded-3xl p-4 space-y-3">
                  <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                    <Ticket className="w-4 h-4 text-indigo-400" /> My Confirmed Cards
                  </h3>
                  <div className="space-y-3">
                    {rooms.every(r => !r.confirmedCardsList?.some(c => c.userId === user.id)) ? (
                      <div className="text-center py-10 space-y-2">
                        <Ticket className="w-10 h-10 text-slate-600 mx-auto" />
                        <p className="text-xs text-slate-400">You have no active cards in current rooms.</p>
                        <button onClick={() => setActiveTab('rooms')} className="text-xs bg-amber-500 text-slate-950 font-bold px-4 py-2 rounded-xl mt-2">Select Cards Now</button>
                      </div>
                    ) : (
                      rooms.map(r => {
                        const myCardsInRoom = r.confirmedCardsList?.filter(c => c.userId === user.id) || [];
                        if (myCardsInRoom.length === 0) return null;
                        return (
                          <div key={r.id} className="bg-slate-950/70 border border-slate-800 rounded-2xl p-3 space-y-2">
                            <div className="flex justify-between items-center text-xs font-bold text-amber-400">
                              <span>{r.name}</span><span className="text-[10px] text-slate-400">{myCardsInRoom.length} card(s)</span>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              {myCardsInRoom.map(c => (
                                <div key={c.cardId} className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-2.5 text-center min-w-[70px]">
                                  <div className="text-[10px] text-slate-400">Card #</div>
                                  <div className="text-sm font-black text-amber-300">{c.cardId}</div>
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* ==================== RULES TAB ==================== */}
            {activeTab === 'rules' && (
              <div className="bg-slate-900 border border-slate-800 rounded-3xl p-5 space-y-4 text-xs text-slate-300">
                <h3 className="font-bold text-sm text-amber-400 flex items-center gap-1.5"><BookOpen className="w-4 h-4" /> Beekaa Bingo Game Rules</h3>
                <div className="space-y-3 leading-relaxed">
                  <p><strong className="text-slate-200">Traditional 75-ball Bingo:</strong> Columns B (1-15), I (16-30), N (31-45, center free space), G (46-60), and O (61-75).</p>
                  <p><strong className="text-slate-200">Three Rooms:</strong> Room 1 (10 ETB), Room 2 (20 ETB), Room 3 (30 ETB).</p>
                  <p><strong className="text-slate-200">60s Countdown:</strong> A room waits up to 60 seconds per round for cards to be confirmed. The game extends twice if not enough players join, then issues refunds.</p>
                  <p><strong className="text-slate-200">Automatic 3s Number Caller:</strong> Numbers are drawn every 3 seconds without repetition. First complete horizontal, vertical, or diagonal line wins!</p>
                  <p><strong className="text-slate-200">80% Winner Share:</strong> 80% goes to the winner(s), 20% platform commission.</p>
                  <p><strong className="text-slate-200">Deposits &amp; Withdrawals:</strong> All transactions are reviewed and approved by an admin before funds are credited or paid out.</p>
                </div>
              </div>
            )}

            {/* ==================== ADMIN TAB ==================== */}
            {activeTab === 'admin' && user.isAdmin && (
              <div className="space-y-4">
                {/* Stats overview */}
                <div className="bg-slate-900 border border-slate-800 rounded-3xl p-4 space-y-3">
                  <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                    <Settings className="w-4 h-4 text-amber-400" /> Admin Dashboard
                  </h3>
                  {adminStats ? (
                    <div className="grid grid-cols-2 gap-2">
                      {[
                        { label: 'Games Played', value: adminStats.totalGamesPlayed, color: 'text-amber-400' },
                        { label: 'Commission Earned', value: `${adminStats.totalCommissionEarned?.toFixed(2)} ETB`, color: 'text-emerald-400' },
                        { label: 'Total Deposited', value: `${adminStats.totalDeposited?.toFixed(2)} ETB`, color: 'text-blue-400' },
                        { label: 'Total Withdrawn', value: `${adminStats.totalWithdrawn?.toFixed(2)} ETB`, color: 'text-rose-400' },
                        { label: 'Pending Deposits', value: adminStats.pendingDeposits, color: adminStats.pendingDeposits > 0 ? 'text-amber-400 animate-pulse' : 'text-slate-400' },
                        { label: 'Pending Withdrawals', value: adminStats.pendingWithdrawals, color: adminStats.pendingWithdrawals > 0 ? 'text-amber-400 animate-pulse' : 'text-slate-400' },
                      ].map(s => (
                        <div key={s.label} className="bg-slate-950 border border-slate-800 rounded-2xl p-3 text-center">
                          <div className="text-[10px] text-slate-400">{s.label}</div>
                          <div className={`text-base font-black ${s.color}`}>{s.value}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-slate-500 text-center py-4">Loading stats…</p>
                  )}
                </div>

                {/* Active rooms */}
                {adminStats?.activeRooms && (
                  <div className="bg-slate-900 border border-slate-800 rounded-3xl p-4 space-y-2">
                    <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Active Rooms</h4>
                    {adminStats.activeRooms.map((r: any) => (
                      <div key={r.id} className="flex items-center justify-between bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs">
                        <span className="font-semibold text-slate-200">{r.name}</span>
                        <div className="flex gap-3">
                          <span className="text-slate-400">{r.cardsSold} cards</span>
                          <span className={`font-bold uppercase text-[10px] px-1.5 py-0.5 rounded-full ${r.status === 'RUNNING' ? 'bg-emerald-500/20 text-emerald-400' : r.status === 'COMPLETED' ? 'bg-purple-500/20 text-purple-400' : 'bg-amber-500/20 text-amber-400'}`}>{r.status}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Approval queue */}
                <div className="bg-slate-900 border border-slate-800 rounded-3xl p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                      <Clock3 className="w-4 h-4 text-amber-400" /> Transaction Requests
                    </h4>
                    <button onClick={() => {
                      fetch(`/api/admin/transactions?status=${adminTxFilter}`, { headers: { Authorization: `Bearer ${token}` } })
                        .then(r => r.json()).then(d => setPendingTxs(d.transactions || [])).catch(() => {});
                    }} className="p-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-400 hover:text-slate-200 transition">
                      <RefreshCw className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {/* Filter tabs */}
                  <div className="flex gap-1.5">
                    {(['PENDING', 'COMPLETED', 'REJECTED'] as const).map(f => (
                      <button key={f} onClick={() => setAdminTxFilter(f)}
                        className={`px-3 py-1 rounded-lg text-[10px] font-bold uppercase border transition ${adminTxFilter === f ? 'bg-amber-500 text-slate-950 border-amber-500' : 'bg-slate-950 text-slate-400 border-slate-800 hover:bg-slate-800'}`}>
                        {f}
                      </button>
                    ))}
                  </div>

                  <div className="space-y-3 max-h-96 overflow-y-auto">
                    {pendingTxs.length === 0 ? (
                      <p className="text-xs text-slate-500 text-center py-6">No {adminTxFilter.toLowerCase()} requests.</p>
                    ) : (
                      pendingTxs.map(tx => (
                        <div key={tx.id} className="bg-slate-950 border border-slate-800 rounded-2xl p-3 space-y-2">
                          <div className="flex items-start justify-between gap-2">
                            <div className="space-y-0.5">
                              <div className="flex items-center gap-2">
                                <span className={`text-[10px] font-black uppercase px-2 py-0.5 rounded-full ${tx.type === 'DEPOSIT' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'}`}>{tx.type}</span>
                                <span className="text-xs font-black text-slate-100">{tx.amount.toFixed(2)} ETB</span>
                              </div>
                              <div className="text-[11px] text-amber-300 font-semibold">@{tx.username}</div>
                              <div className="text-[10px] text-slate-400">{tx.reference}</div>
                              {tx.method && <div className="text-[10px] text-slate-500">via {tx.method}{tx.paymentRef ? ` · Ref: ${tx.paymentRef}` : ''}</div>}
                              {tx.destination && <div className="text-[10px] text-slate-500">→ {tx.destination}</div>}
                              <div className="text-[9px] text-slate-600">{new Date(tx.createdAt).toLocaleString()}</div>
                              {tx.userBalance !== undefined && <div className="text-[10px] text-slate-400">User balance: <span className="font-bold text-slate-200">{tx.userBalance.toFixed(2)} ETB</span></div>}
                            </div>
                          </div>
                          {tx.status === 'PENDING' && (
                            <div className="flex gap-2 pt-1">
                              <button onClick={() => handleAdminAction(tx.id, 'approve')} className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2 rounded-xl text-xs flex items-center justify-center gap-1.5 transition shadow">
                                <Check className="w-3.5 h-3.5" /> Approve
                              </button>
                              <button onClick={() => handleAdminAction(tx.id, 'reject')} className="flex-1 bg-rose-700/80 hover:bg-rose-600 text-white font-bold py-2 rounded-xl text-xs flex items-center justify-center gap-1.5 transition">
                                <X className="w-3.5 h-3.5" /> Reject
                              </button>
                            </div>
                          )}
                          {tx.status !== 'PENDING' && tx.reviewedBy && (
                            <div className="text-[9px] text-slate-500 pt-1 border-t border-slate-800">
                              {tx.status} by @{tx.reviewedBy} · {tx.reviewedAt ? new Date(tx.reviewedAt).toLocaleString() : ''}
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </main>

      {/* Bottom nav */}
      <nav className="w-full max-w-md bg-slate-900 border-t border-slate-800 px-4 py-2.5 fixed bottom-0 z-50 flex items-center justify-around shadow-2xl">
        {[
          { tab: 'rooms' as const, icon: <Play className="w-4 h-4" />, label: 'Game' },
          { tab: 'wallet' as const, icon: <Wallet className="w-4 h-4" />, label: 'Wallet' },
          { tab: 'my_cards' as const, icon: <Ticket className="w-4 h-4" />, label: 'Cards' },
          { tab: 'rules' as const, icon: <BookOpen className="w-4 h-4" />, label: 'Rules' },
        ].map(({ tab, icon, label }) => (
          <button key={tab} onClick={() => { setActiveTab(tab); setViewMode('miniapp'); }}
            className={`flex flex-col items-center gap-1 transition ${activeTab === tab && viewMode === 'miniapp' ? 'text-amber-400' : 'text-slate-400 hover:text-slate-200'}`}>
            {icon}<span className="text-[10px] font-bold">{label}</span>
          </button>
        ))}
        {user.isAdmin && (
          <button onClick={() => { setActiveTab('admin'); setViewMode('miniapp'); }}
            className={`flex flex-col items-center gap-1 transition relative ${activeTab === 'admin' && viewMode === 'miniapp' ? 'text-amber-400' : 'text-slate-400 hover:text-slate-200'}`}>
            <Settings className="w-4 h-4" />
            {adminStats && (adminStats.pendingDeposits > 0 || adminStats.pendingWithdrawals > 0) && (
              <span className="absolute -top-1 -right-1 w-3 h-3 bg-rose-500 rounded-full border border-slate-900 text-[7px] text-white flex items-center justify-center font-black">
                {(adminStats.pendingDeposits || 0) + (adminStats.pendingWithdrawals || 0)}
              </span>
            )}
            <span className="text-[10px] font-bold">Admin</span>
          </button>
        )}
      </nav>

      {/* ==================== DEPOSIT MODAL ==================== */}
      {showDepositModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl p-5 max-w-sm w-full space-y-4 shadow-2xl">
            <h3 className="text-sm font-bold text-amber-400 flex items-center gap-2"><ArrowDownLeft className="w-4 h-4" /> Deposit Funds (ETB)</h3>

            {/* Payment info */}
            {appConfig?.paymentInfo && (
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-2 text-[11px] text-amber-300">
                {appConfig.paymentInfo}
              </div>
            )}

            <div className="space-y-3">
              <div>
                <label className="text-[10px] text-slate-400 block mb-1">Select Payment Provider</label>
                <div className="grid grid-cols-2 gap-2">
                  {(appConfig?.depositMethods || ['Telebirr', 'CBE Birr', 'Awash Bank']).map(method => (
                    <button key={method} onClick={() => setDepositMethod(method)}
                      className={`py-2 px-3 rounded-xl text-xs font-bold border transition ${depositMethod === method ? 'bg-amber-500 text-slate-950 border-amber-500' : 'bg-slate-950 text-slate-300 border-slate-800 hover:bg-slate-800'}`}>
                      {method}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-[10px] text-slate-400 block mb-1">Amount (ETB)</label>
                <input type="number" value={depositAmount} onChange={e => setDepositAmount(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-100 font-bold focus:outline-none focus:border-amber-500" placeholder="Enter amount" />
              </div>
              <div className="grid grid-cols-4 gap-1.5">
                {['100', '250', '500', '1000'].map(amt => (
                  <button key={amt} onClick={() => setDepositAmount(amt)} className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold py-1.5 rounded-lg border border-slate-700">{amt}</button>
                ))}
              </div>
              <div>
                <label className="text-[10px] text-slate-400 block mb-1">Transaction Reference (from your receipt)</label>
                <input type="text" value={depositRef} onChange={e => setDepositRef(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-100 font-bold focus:outline-none focus:border-amber-500 uppercase" placeholder="e.g. TX1234567890" />
                <p className="text-[10px] text-slate-500 mt-1">Copy the transaction ID from your payment app receipt.</p>
              </div>
            </div>

            <div className="bg-slate-800/60 border border-slate-700 rounded-xl px-3 py-2 text-[10px] text-slate-400 flex items-start gap-2">
              <Clock3 className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
              Your balance will be credited after an admin verifies your payment. This usually takes a few minutes.
            </div>

            <div className="flex gap-2 pt-1">
              <button onClick={() => { setShowDepositModal(false); setDepositRef(''); }} className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold py-2.5 rounded-xl text-xs">Cancel</button>
              <button onClick={handleDeposit} className="flex-1 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold py-2.5 rounded-xl text-xs shadow-lg shadow-amber-500/20">Submit Request</button>
            </div>
          </div>
        </div>
      )}

      {/* ==================== WITHDRAW MODAL ==================== */}
      {showWithdrawModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl p-5 max-w-sm w-full space-y-4 shadow-2xl">
            <h3 className="text-sm font-bold text-amber-400 flex items-center gap-2"><ArrowUpRight className="w-4 h-4" /> Withdraw Funds (ETB)</h3>
            <div className="space-y-3">
              <div>
                <label className="text-[10px] text-slate-400 block mb-1">Amount (ETB) — Available: {user.balance.toFixed(2)}</label>
                <input type="number" value={withdrawAmount} onChange={e => setWithdrawAmount(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-100 font-bold focus:outline-none focus:border-amber-500" placeholder={`Min ${appConfig?.minWithdraw ?? 50} ETB`} />
              </div>
              <div>
                <label className="text-[10px] text-slate-400 block mb-1">Payout Account (Bank / Mobile)</label>
                <input type="text" value={withdrawDest} onChange={e => setWithdrawDest(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-100 font-bold focus:outline-none focus:border-amber-500" placeholder="e.g. Telebirr 0911234567" />
              </div>
            </div>
            <div className="bg-rose-950/40 border border-rose-500/30 rounded-xl px-3 py-2 text-[10px] text-rose-300 flex items-start gap-2">
              <AlertCircle className="w-3.5 h-3.5 text-rose-400 shrink-0 mt-0.5" />
              The requested amount will be held from your balance immediately. Funds are released once an admin completes the payout.
            </div>
            <div className="flex gap-2 pt-1">
              <button onClick={() => setShowWithdrawModal(false)} className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold py-2.5 rounded-xl text-xs">Cancel</button>
              <button onClick={handleWithdraw} className="flex-1 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold py-2.5 rounded-xl text-xs shadow-lg shadow-amber-500/20">Submit Withdrawal</button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
