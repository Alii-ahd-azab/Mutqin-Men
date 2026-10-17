import './src/lib/suppressFirestoreWarnings';
import { registerPersonalTestRoutes } from './src/server/personalTests';
import { personalTestsFirestoreStore } from './src/server/personalTestsFirestore';
import express, { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { createServer as createViteServer } from 'vite';
import { User, GroupSettings, RestDay, RecitationLog, RevisionLog, CycleInfo, TestDefinition, TestAttempt } from './src/types';
import { calculateCycleInfo, calculateMemberRequiredQuarter, formatDate, getCalendarDaysElapsed, getActiveCycleDates, calculateMemberRevisionStatus } from './src/lib/calculations';
import {
  generateTestQuestions,
  estimateRangeLines,
  isInTestAudience,
  getQuarterStartIndex,
  getQuarterEndIndex,
  getVerseIndexBySurahAyah,
  ALL_VERSES,
} from './src/lib/testGenerator';
import * as firestoreService from './src/server/firestoreService';
import firebaseConfig from './firebase-applet-config.json';

const app = express();
const PORT = 3000;

app.use(express.json());

// Do not serve API requests from the stale local snapshot while the first Firestore sync is still running.
app.use('/api', async (_req, _res, next) => {
  try {
    await Promise.race([initialSyncDone.catch(() => undefined), new Promise((r) => setTimeout(r, 12000))]);
  } catch {
    /* ignore */
  }
  next();
});

// Database storage setup
const DATA_DIR = path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'database.json');

// Default initial password hash using bcrypt
const DEFAULT_SAMPLE_PASSWORD_HASH = bcrypt.hashSync('password123', 10);

interface DatabaseSchema {
  users: (User & { password_hash: string })[];
  settings: GroupSettings;
  restDays: RestDay[];
  recitationLogs: RecitationLog[];
  revisionLogs: RevisionLog[];
  tests?: TestDefinition[];
  testAttempts?: TestAttempt[];
}

function getInitialData(): DatabaseSchema {
  // Set start_date 8 calendar days ago so that today is Day 9 (matches sample timeline)
  const today = new Date();
  const startDate = new Date(today);
  startDate.setDate(today.getDate() - 8);
  const startDateStr = formatDate(startDate);
  const todayStr = formatDate(today);

  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const yesterdayStr = formatDate(yesterday);

  return {
    settings: {
      id: 'group_main',
      start_date: '2026-09-18',
      total_quarters: 240,
      review_window: 8,
      current_cycle_number: 1,
      is_paused: false,
      paused_at: null,
      total_paused_days: 0,
    },
    users: [
      {
        id: 'user_admin_1',
        name: 'الشيخ أحمد (مشرف المقرأة)',
        phone: '01000000000',
        password_hash: DEFAULT_SAMPLE_PASSWORD_HASH,
        role: 'admin',
        is_active: true,
        created_at: new Date().toISOString(),
      },
      {
        id: 'user_member_1',
        name: 'يوسف عبد الرحمن',
        phone: '01011111111',
        password_hash: DEFAULT_SAMPLE_PASSWORD_HASH,
        role: 'member',
        is_active: true,
        created_at: new Date().toISOString(),
      },
      {
        id: 'user_member_2',
        name: 'عمر الفاروق',
        phone: '01022222222',
        password_hash: DEFAULT_SAMPLE_PASSWORD_HASH,
        role: 'member',
        is_active: true,
        created_at: new Date().toISOString(),
      },
      {
        id: 'user_member_3',
        name: 'بلال محمود',
        phone: '01033333333',
        password_hash: DEFAULT_SAMPLE_PASSWORD_HASH,
        role: 'member',
        is_active: true,
        created_at: new Date().toISOString(),
      },
      {
        id: 'user_member_4',
        name: 'أنس خالد',
        phone: '01044444444',
        password_hash: DEFAULT_SAMPLE_PASSWORD_HASH,
        role: 'member',
        is_active: true,
        created_at: new Date().toISOString(),
      },
    ],
    restDays: [],
    recitationLogs: [
      {
        id: 'rec_prev_1',
        member_id: 'user_member_1',
        member_name: 'يوسف عبد الرحمن',
        listener_id: 'user_member_2',
        listener_name: 'عمر الفاروق',
        quarter_number: 8,
        cycle_number: 1,
        date: yesterdayStr,
        notes: 'قراءة متقنة ومخارج حروف ممتازة',
        created_at: new Date(Date.now() - 86400000).toISOString(),
      },
      {
        id: 'rec_prev_2',
        member_id: 'user_member_2',
        member_name: 'عمر الفاروق',
        listener_id: 'user_member_1',
        listener_name: 'يوسف عبد الرحمن',
        quarter_number: 8,
        cycle_number: 1,
        date: yesterdayStr,
        notes: 'تمت المراجعة بتأنٍ وإتقان',
        created_at: new Date(Date.now() - 80000000).toISOString(),
      },
      {
        id: 'rec_today_1',
        member_id: 'user_member_2',
        member_name: 'عمر الفاروق',
        listener_id: 'user_member_1',
        listener_name: 'يوسف عبد الرحمن',
        quarter_number: 9,
        cycle_number: 1,
        date: todayStr,
        notes: 'تسميع ربع اليوم التاسع (سيقول السفهاء)',
        created_at: new Date().toISOString(),
      },
    ],
    revisionLogs: [
      {
        id: 'rev_prev_1',
        member_id: 'user_member_1',
        member_name: 'يوسف عبد الرحمن',
        date: yesterdayStr,
        cycle_number: 1,
        review_start_quarter: 1,
        review_end_quarter: 8,
        notes: 'مراجعة الجزء الأول كاملًا بفضل الله',
        created_at: new Date(Date.now() - 86400000).toISOString(),
      },
      {
        id: 'rev_today_1',
        member_id: 'user_member_1',
        member_name: 'يوسف عبد الرحمن',
        date: todayStr,
        cycle_number: 1,
        review_start_quarter: 2,
        review_end_quarter: 9,
        notes: 'أتممت مراجعة 8 أرباع المطلوبة اليوم',
        created_at: new Date().toISOString(),
      },
    ],
  };
}

function loadDatabase(): DatabaseSchema {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(DB_FILE)) {
      const initial = getInitialData();
      fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2), 'utf-8');
      return initial;
    }
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as any;

    if (parsed.settings) {
      parsed.settings.is_paused = !!parsed.settings.is_paused;
      parsed.settings.paused_at = parsed.settings.paused_at || null;
      parsed.settings.total_paused_days = parsed.settings.total_paused_days || 0;
      delete parsed.settings.max_errors_allowed;
      delete parsed.settings.fine_amount_per_missed_quarter;
    }

    if (Array.isArray(parsed.recitationLogs)) {
      parsed.recitationLogs.forEach((l: any) => {
        if (!l.member_id && l.reciter_id) l.member_id = l.reciter_id;
        if (!l.member_name && l.reciter_name) l.member_name = l.reciter_name;
        delete l.error_count;
        delete l.status;
      });
    }

    if (!Array.isArray(parsed.tests)) {
      parsed.tests = [];
    }
    if (!Array.isArray(parsed.testAttempts)) {
      parsed.testAttempts = [];
    }

    return parsed;
  } catch (err) {
    console.error('Error reading database, falling back to initial data:', err);
    return getInitialData();
  }
}

function saveDatabase(data: DatabaseSchema): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error writing database:', err);
  }
}

let db = loadDatabase();
const sessions = new Map<string, string>(); // legacy (kept for compatibility); tokens are now stateless signed tokens

// Stateless signed session tokens: survive server restarts / multiple instances.
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const SESSION_SECRET: string =
  process.env.SESSION_SECRET ||
  (process.env.FIREBASE_SERVER_AUTH_PASSWORD
    ? crypto.createHash('sha256').update('mutqin-session|' + process.env.FIREBASE_SERVER_AUTH_PASSWORD + '|' + firebaseConfig.projectId).digest('hex')
    : crypto.createHash('sha256').update('mutqin-session|' + firebaseConfig.projectId + '|' + (firebaseConfig as any).apiKey).digest('hex'));

function signSession(userId: string, passwordHash: string): string {
  const exp = Date.now() + SESSION_TTL_MS;
  const fp = crypto.createHash('sha256').update(passwordHash || '').digest('hex').slice(0, 12);
  const body = Buffer.from(JSON.stringify({ u: userId, e: exp, f: fp })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `st1.${body}.${sig}`;
}

function verifySession(token: string): { userId: string; fp: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'st1') return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(parts[1]).digest('base64url');
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
    if (!data.u || typeof data.e !== 'number' || data.e < Date.now()) return null;
    return { userId: data.u, fp: data.f };
  } catch {
    return null;
  }
}

// Logs written recently: kept so a concurrent sync (which may have read Firestore BEFORE the write
// committed) never wipes them from memory.
const RECENT_WRITE_TTL_MS = 3 * 60 * 1000;
const recentRevisions = new Map<string, { log: RevisionLog; ts: number }>();
const recentRecitations = new Map<string, { log: RecitationLog; ts: number }>();
const inFlightKeys = new Set<string>();

function mergeRecent<T extends { id: string }>(live: T[], recent: Map<string, { log: T; ts: number }>): T[] {
  const now = Date.now();
  const ids = new Set(live.map((l) => l.id));
  const out = [...live];
  for (const [id, v] of recent) {
    if (now - v.ts > RECENT_WRITE_TTL_MS) {
      recent.delete(id);
    } else if (!ids.has(id)) {
      out.push(v.log);
    }
  }
  return out;
}

// Single-flight: concurrent callers share one sync run.
let syncInFlight: Promise<void> | null = null;
function syncFromFirestore(): Promise<void> {
  if (!syncInFlight) {
    syncInFlight = doSyncFromFirestore().finally(() => {
      syncInFlight = null;
    });
  }
  return syncInFlight;
}

async function doSyncFromFirestore(): Promise<void> {
  try {
    const [liveUsers, liveSettings, liveRestDays, liveRecitations, liveRevisions, liveTests, liveAttempts] =
      await Promise.all([
        firestoreService.getLiveUsers(),
        firestoreService.getLiveSettings(),
        firestoreService.getLiveRestDays(),
        firestoreService.getLiveRecitations(),
        firestoreService.getLiveRevisions(),
        firestoreService.getLiveTests().catch((e) => {
          console.warn('[Firestore getLiveTests warning]', e);
          return null;
        }),
        firestoreService.getLiveTestAttempts().catch((e) => {
          console.warn('[Firestore getLiveTestAttempts warning]', e);
          return null;
        }),
      ]);

    if (liveUsers && liveUsers.length > 0) {
      db.users = liveUsers;
    }
    if (liveSettings) {
      db.settings = liveSettings;
    }
    if (liveRestDays) {
      db.restDays = liveRestDays;
    }
    if (liveRecitations) {
      db.recitationLogs = mergeRecent(liveRecitations, recentRecitations);
    }
    if (liveRevisions) {
      db.revisionLogs = mergeRecent(liveRevisions, recentRevisions);
    }
    if (liveTests !== null && Array.isArray(liveTests)) {
      db.tests = liveTests;
    }
    if (liveAttempts !== null && Array.isArray(liveAttempts)) {
      db.testAttempts = liveAttempts;
    }
    saveDatabase(db);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[Firestore Sync Warning]', msg);
  }
}

// Perform initial connection check & seed if Firestore is empty
const initialSyncDone: Promise<void> = firestoreService.testFirestoreConnection().then(async (status) => {
  if (status.success) {
    console.log(`[Firestore LIVE] Successfully connected to project: ${firebaseConfig.projectId}`);
    await firestoreService.seedFirestoreIfEmpty(db);
    await syncFromFirestore();
  } else {
    console.warn(`[Firestore Status Warning] ${status.error}`);
  }
});

function getAuthUser(req: Request): (User & { password_hash: string }) | null {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  const token = authHeader.replace('Bearer ', '').trim();
  const verified = verifySession(token);
  if (verified) {
    const u = db.users.find((x) => x.id === verified.userId) || null;
    if (!u) return null;
    const fp = crypto.createHash('sha256').update(u.password_hash || '').digest('hex').slice(0, 12);
    return fp === verified.fp ? u : null; // password change invalidates old tokens
  }
  const userId = sessions.get(token);
  if (!userId) return null;
  return db.users.find((u) => u.id === userId) || null;
}

/**
 * Resolve today's date in YYYY-MM-DD format:
 * 1. Checks client's local date sent via X-Client-Date header
 * 2. Checks client_date query param
 * 3. Falls back to Makkah time (Asia/Riyadh, UTC+3)
 */
function getTodayDate(req?: Request): string {
  const headerDate = req?.headers?.['x-client-date'] as string | undefined;
  if (headerDate && /^\d{4}-\d{2}-\d{2}$/.test(headerDate)) {
    return headerDate;
  }
  const queryDate = (req?.query?.client_date || req?.query?.date) as string | undefined;
  if (queryDate && /^\d{4}-\d{2}-\d{2}$/.test(queryDate)) {
    return queryDate;
  }
  return formatDate(new Date(), 'Asia/Riyadh');
}

// ==================== API ROUTES ====================

app.get('/api/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Firestore Live Status Diagnostic endpoint
app.get('/api/firestore/status', async (req: Request, res: Response) => {
  const result = await firestoreService.testFirestoreConnection();
  res.json({
    projectId: firebaseConfig.projectId,
    databaseId: firebaseConfig.firestoreDatabaseId,
    connected: result.success,
    error: result.error || null,
  });
});

// Authentication
app.post('/api/auth/login', async (req: Request, res: Response) => {
  const { phone, password } = req.body;
  if (!phone || !password) {
    return res.status(400).json({ error: 'يرجى إدخال رقم الهاتف وكلمة المرور' });
  }

  const normalizedPhone = String(phone).trim();
  let user = db.users.find((u) => u.phone === normalizedPhone);

  // If user is not found in local memory, sync only users from Firestore as a quick fallback
  if (!user) {
    try {
      const liveUsers = await firestoreService.getLiveUsers();
      if (liveUsers && liveUsers.length > 0) {
        db.users = liveUsers;
        saveDatabase(db);
        user = db.users.find((u) => u.phone === normalizedPhone);
      }
    } catch (uErr) {
      console.warn('[Login user lookup fallback warning]', uErr);
    }
  }

  if (!user) {
    return res.status(401).json({ error: 'رقم الهاتف أو كلمة المرور غير صحيحة' });
  }

  let isPasswordValid = false;
  const storedHash = user.password_hash || '';

  // Use bcrypt.compare if stored hash is a bcrypt hash ($2a$, $2b$, $2y$)
  if (storedHash.startsWith('$2a$') || storedHash.startsWith('$2b$') || storedHash.startsWith('$2y$')) {
    isPasswordValid = await bcrypt.compare(String(password), storedHash);
  } else {
    // Backward compatibility for legacy plain-text passwords: verify and immediately upgrade to bcrypt
    if (storedHash === String(password)) {
      isPasswordValid = true;
      try {
        const upgradedHash = await bcrypt.hash(String(password), 10);
        user.password_hash = upgradedHash;
        saveDatabase(db);
        await firestoreService.updateLiveUser(user.id, { password_hash: upgradedHash });
        console.log(`[Auth] Automatically migrated legacy password for user ${user.id} to bcrypt hash.`);
      } catch (upgradeErr) {
        console.warn('[Auth] Legacy password migration error:', upgradeErr);
      }
    }
  }

  if (!isPasswordValid) {
    return res.status(401).json({ error: 'رقم الهاتف أو كلمة المرور غير صحيحة' });
  }

  // Note: Excluded members (!user.is_active) are permitted to log in to view their status,
  // but cannot record recitation or revision.

  const token = signSession(user.id, user.password_hash);

  const { password_hash, ...safeUser } = user;
  res.json({ user: safeUser, token });
});

app.get('/api/auth/me', (req: Request, res: Response) => {
  const user = getAuthUser(req);
  if (!user) {
    return res.status(401).json({ error: 'غير مسجل الدخول' });
  }
  const { password_hash, ...safeUser } = user;
  res.json({ user: safeUser });
});

app.post('/api/auth/logout', (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const token = authHeader.replace('Bearer ', '').trim();
    sessions.delete(token);
  }
  res.json({ success: true });
});

// Change Password (Authenticated User)
app.post('/api/auth/change-password', async (req: Request, res: Response) => {
  const user = getAuthUser(req);
  if (!user) {
    return res.status(401).json({ error: 'يجب تسجيل الدخول أولاً' });
  }

  const { currentPassword, newPassword, confirmPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'يرجى إدخال كلمة المرور الحالية وكلمة المرور الجديدة' });
  }

  let isCurrentValid = false;
  const storedHash = user.password_hash || '';
  if (storedHash.startsWith('$2a$') || storedHash.startsWith('$2b$') || storedHash.startsWith('$2y$')) {
    isCurrentValid = await bcrypt.compare(String(currentPassword), storedHash);
  } else {
    isCurrentValid = (storedHash === String(currentPassword));
  }

  if (!isCurrentValid) {
    return res.status(400).json({ error: 'كلمة المرور الحالية غير صحيحة' });
  }

  const trimmedNewPassword = String(newPassword).trim();
  if (!trimmedNewPassword) {
    return res.status(400).json({ error: 'لا يمكن أن تكون كلمة المرور الجديدة فارغة' });
  }

  if (trimmedNewPassword.length < 4) {
    return res.status(400).json({ error: 'يجب ألا تقل كلمة المرور الجديدة عن 4 خانات' });
  }

  if (confirmPassword !== undefined && trimmedNewPassword !== String(confirmPassword).trim()) {
    return res.status(400).json({ error: 'كلمة المرور الجديدة وتأكيدها غير متطابقين' });
  }

  const hashedNewPassword = await bcrypt.hash(trimmedNewPassword, 10);

  // Write to Firestore FIRST - do not save locally or return success if Firestore fails!
  try {
    await firestoreService.updateLiveUser(user.id, { password_hash: hashedNewPassword });
  } catch (fsErr: unknown) {
    const msg = fsErr instanceof Error ? fsErr.message : String(fsErr);
    console.error('[Firestore Change Password Error]', msg);
    return res.status(500).json({
      error: 'فشل حفظ كلمة المرور الجديدة في قاعدة البيانات السحابية (Firestore). لم يتم تطبيق التغيير، يرجى المحاولة ثانية.',
    });
  }

  user.password_hash = hashedNewPassword;
  saveDatabase(db);

  res.json({ message: 'تم تغيير كلمة المرور بنجاح' });
});

// Bootstrap / Global State - Reads live from Firestore!
app.get('/api/bootstrap', async (req: Request, res: Response) => {
  // Sync live state from Firestore
  await syncFromFirestore();

  const todayStr = getTodayDate(req);
  const cycleInfo = calculateCycleInfo(db.settings, db.restDays, todayStr);

  const safeUsers = db.users
    .map(({ password_hash, ...u }) => u);

  const todayRecitations = db.recitationLogs.filter((r) => r.date === todayStr);
  const todayRevisions = db.revisionLogs.filter((r) => r.date === todayStr);

  const user = getAuthUser(req);
  const isAdmin = user?.role === 'admin';

  const allTests = db.tests || [];
  const rawActiveTest = allTests.find((t) => t.is_active && !t.is_finished) || null;
  const activeTest = (rawActiveTest && (isAdmin || (user && isInTestAudience(rawActiveTest, user.id))))
    ? rawActiveTest
    : null;

  let clientTests: TestDefinition[] = [];
  let clientAttempts: TestAttempt[] = [];

  if (isAdmin) {
    clientTests = allTests;
    clientAttempts = db.testAttempts || [];
  } else if (user) {
    clientTests = activeTest ? [activeTest] : [];
    clientAttempts = (db.testAttempts || []).filter(
      (a) => a.candidate_id === user.id || a.examiner_id === user.id
    );
  }

  res.json({
    cycleInfo,
    settings: db.settings,
    restDays: db.restDays,
    users: safeUsers,
    todayRecitations,
    todayRevisions,
    tests: clientTests,
    activeTest,
    testAttempts: clientAttempts,
  });
});

// Recitation logs list
app.get('/api/recitations', (req: Request, res: Response) => {
  const { member_id, reciter_id, date, limit } = req.query;
  let logs = [...db.recitationLogs];

  const targetMember = member_id || reciter_id;
  if (targetMember) {
    logs = logs.filter((l) => l.member_id === targetMember || l.reciter_id === targetMember);
  }
  if (date) {
    logs = logs.filter((l) => l.date === date);
  }

  logs.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  if (limit) {
    const num = parseInt(String(limit), 10);
    if (!isNaN(num)) logs = logs.slice(0, num);
  }

  res.json({ recitations: logs });
});

// Record a Recitation: Member registers for themselves!
app.post('/api/recitations', async (req: Request, res: Response) => {
  const currentUser = getAuthUser(req);
  if (!currentUser) {
    return res.status(401).json({ error: 'يجب تسجيل الدخول أولاً' });
  }

  if (currentUser.role === 'admin') {
    return res.status(403).json({ error: 'المشرف لا يسجل تسميعًا' });
  }

  if (!currentUser.is_active) {
    return res.status(403).json({
      error: 'حسابك مُعلّق (مُقصَى) حاليًا بقرار من المشرف، ولا يمكنك تسجيل التسميع حتى تتم إعادة تفعيلك.',
    });
  }

  const { quarter_number, listener_id, notes, date } = req.body;
  const logDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : getTodayDate(req);

  // Rule: Sequential catch-up requirement (can recite multiple missed quarters in the same day)
  const currentCycleInfo = calculateCycleInfo(db.settings, db.restDays, logDate);

  if (!currentCycleInfo.has_started) {
    return res.status(400).json({
      error: 'برنامج المقرأة لم يبدأ بعد! سيبدأ البرنامج بإذن الله يوم الجمعة 18 سبتمبر 2026 الساعة 12:00 صباحًا، وسيتاح تسجيل التسميع حينها.',
    });
  }

  const memberQuarterStatus = calculateMemberRequiredQuarter(
    currentUser.id,
    currentCycleInfo.quarter_of_day,
    db.recitationLogs
  );

  // Check if member has already completed all quarters up to the group's current quarter of day
  if (memberQuarterStatus.allCompletedUpToToday) {
    return res.status(400).json({
      error: `لقد أتممت بالفعل جميع الأرباع حتى ربع اليوم الحالي للمجموعة (الربع ${currentCycleInfo.quarter_of_day}). لا يمكن تسجيل ربع أكبر من ربع اليوم للمجموعة (لا يمكن السبق على الجدول الزمني الجماعي).`,
    });
  }

  const quarter = parseInt(String(quarter_number), 10);
  if (isNaN(quarter) || quarter !== memberQuarterStatus.requiredQuarter) {
    return res.status(400).json({
      error: `لا يمكن تخطي الربع الفائت! الربع المطلوب منك تسميعه الآن هو الربع رقم (${memberQuarterStatus.requiredQuarter}). يجب تسميع الأرباع السابقة بالترتيب أولاً.`,
    });
  }

  // Rule: Cannot advance past the group's current quarter of day
  if (quarter > currentCycleInfo.quarter_of_day) {
    return res.status(400).json({
      error: `لا يمكن تسجيل ربع أكبر من ربع اليوم الحالي للمجموعة (الربع ${currentCycleInfo.quarter_of_day}). لا يمكن السبق على الخطة الجماعية.`,
    });
  }

  // Mandatory Test Enforcement (المنع الإلزامي - القسم هـ)
  const activeMandatoryTest = (db.tests || []).find((t) => t.is_active && !t.is_finished && t.test_type === 'mandatory');
  if (activeMandatoryTest && isInTestAudience(activeMandatoryTest, currentUser.id)) {
    const hasPassedMandatory = (db.testAttempts || []).some(
      (a) =>
        a.test_id === activeMandatoryTest.id &&
        a.candidate_id === currentUser.id &&
        a.passed &&
        a.covers_full_range !== false
    );
    if (!hasPassedMandatory && quarter > activeMandatoryTest.range_end) {
      return res.status(403).json({
        error: `يجب اجتياز الاختبار الإلزامي للأرباع (${activeMandatoryTest.range_start} - ${activeMandatoryTest.range_end}) بنجاح أولاً قبل متابعة تسميع الأرباع التالية.`,
      });
    }
  }

  // Guard against duplicate records for the exact same quarter
  const alreadyCompletedQuarter = db.recitationLogs.some(
    (r) => (r.member_id === currentUser.id || r.reciter_id === currentUser.id) && r.quarter_number === quarter
  );
  if (alreadyCompletedQuarter) {
    return res.status(400).json({
      error: `الربع رقم (${quarter}) مسجل ومكتمل لديك بالفعل.`,
    });
  }

  // Required listener colleague (strictly from group members - cannot recite to outside person)
  if (!listener_id) {
    return res.status(400).json({
      error: 'يرجى اختيار الزميل المستمع من أعضاء المقرأة (لا يُسمح بالتسميع على شخص من الخارج).',
    });
  }

  const peer = db.users.find(
    (u) => u.id === listener_id && u.is_active && u.role === 'member' && u.id !== currentUser.id
  );
  if (!peer) {
    return res.status(400).json({
      error: 'الزميل المستمع المحدد غير صالح. يجب اختيار زميل نشط من أعضاء المقرأة.',
    });
  }

  const peerId = peer.id;
  const peerName = peer.name;

  const newLog: RecitationLog = {
    id: `rec_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    member_id: currentUser.id,
    member_name: currentUser.name,
    listener_id: peerId,
    listener_name: peerName,
    quarter_number: quarter,
    cycle_number: db.settings.current_cycle_number,
    date: logDate,
    created_at: new Date().toISOString(),
    reciter_id: currentUser.id,
    reciter_name: currentUser.name,
    ...(notes && String(notes).trim() ? { notes: String(notes).trim() } : {}),
  };

  // Write to Firestore FIRST - do NOT save locally or return success if Firestore fails!
  try {
    await firestoreService.addLiveRecitation(newLog);
  } catch (fsErr: unknown) {
    const msg = fsErr instanceof Error ? fsErr.message : String(fsErr);
    console.error('[Firestore Recitation Write Error]', msg);
    return res.status(500).json({
      error: 'فشل حفظ سجل التسميع في قاعدة البيانات السحابية (Firestore). يرجى التحقق من اتصال الإنترنت والمحاولة مرة أخرى.',
    });
  }

  recentRecitations.set(newLog.id, { log: newLog, ts: Date.now() });
  if (!db.recitationLogs.some((r) => r.id === newLog.id)) db.recitationLogs.push(newLog);
  saveDatabase(db);

  res.status(201).json({
    recitation: newLog,
    message: `تم تسجيل إتمام تسميع الربع ${quarter} بنجاح وتقبل الله منكم!`,
  });
});

// Revision logs list
app.get('/api/revisions', async (req: Request, res: Response) => {
  await syncFromFirestore();
  const { member_id, date } = req.query;
  let logs = [...db.revisionLogs];

  if (member_id) {
    logs = logs.filter((l) => l.member_id === member_id);
  }
  if (date) {
    logs = logs.filter((l) => l.date === date);
  }

  logs.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  res.json({ revisions: logs });
});

// Record Daily Revision (Member for themselves)
app.post('/api/revisions', async (req: Request, res: Response) => {
  const currentUser = getAuthUser(req);
  if (!currentUser) {
    return res.status(401).json({ error: 'يجب تسجيل الدخول أولاً' });
  }

  if (currentUser.role === 'admin') {
    return res.status(403).json({ error: 'المشرف لا يسجل مراجعة' });
  }

  if (!currentUser.is_active) {
    return res.status(403).json({
      error: 'حسابك مُعلّق (مُقصَى) حاليًا بقرار من المشرف، ولا يمكنك تسجيل المراجعة حتى تتم إعادة تفعيلك.',
    });
  }

  const { notes, date } = req.body;
  const todayDate = getTodayDate(req);
  const logDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : todayDate;

  // Validate date: must be within valid active cycle dates from start date up to today
  const startDate = db.settings.start_date;
  if (!startDate || logDate < startDate) {
    return res.status(400).json({
      error: 'التاريخ المحدد غير صالح: لا يمكن تسجيل مراجعة لتاريخ يسبق بداية برنامج المقرأة.',
    });
  }

  if (logDate > todayDate) {
    return res.status(400).json({
      error: 'التاريخ المحدد غير صالح: لا يمكن تسجيل مراجعة لتاريخ مستقبلي بعد اليوم الحالي.',
    });
  }

  // Rest days and paused days are allowed to be recorded (they are never counted as "missed").
  // Make sure memory reflects Firestore before the duplicate check.
  await syncFromFirestore();

  const lockKey = `rev:${currentUser.id}:${logDate}`;
  if (inFlightKeys.has(lockKey)) {
    return res.status(409).json({ error: 'جارٍ حفظ مراجعة هذا اليوم، انتظر لحظة.' });
  }
  inFlightKeys.add(lockKey);
  try {
  const cycleInfo = calculateCycleInfo(db.settings, db.restDays, logDate);

  if (!cycleInfo.has_started) {
    return res.status(400).json({
      error: 'برنامج المقرأة لم يبدأ بعد في التاريخ المحدد.',
    });
  }

  const existingIndex = db.revisionLogs.findIndex(
    (r) => r.member_id === currentUser.id && r.date === logDate
  );

  if (existingIndex >= 0) {
    // Idempotent: a retry after a lost response must look like success, not an error.
    return res.status(200).json({
      revision: db.revisionLogs[existingIndex],
      already_recorded: true,
      message: 'تم تأكيد مراجعة هذا اليوم مسبقًا.',
    });
  }

  const newRevision: RevisionLog = {
    id: `rev_${currentUser.id}_${logDate}`,
    member_id: currentUser.id,
    member_name: currentUser.name,
    date: logDate,
    cycle_number: db.settings.current_cycle_number,
    review_start_quarter: cycleInfo.review_start,
    review_end_quarter: cycleInfo.review_end,
    created_at: new Date().toISOString(),
    ...(notes && String(notes).trim() ? { notes: String(notes).trim() } : {}),
  };

  // Write to Firestore FIRST - do NOT save locally or return success if Firestore fails!
  try {
    await Promise.race([
      firestoreService.addLiveRevision(newRevision),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('Firestore write timeout')), 20000)),
    ]);
  } catch (fsErr: unknown) {
    const msg = fsErr instanceof Error ? fsErr.message : String(fsErr);
    console.error('[Firestore Revision Write Error]', msg);
    return res.status(500).json({
      error: 'فشل حفظ سجل المراجعة في قاعدة البيانات السحابية (Firestore). يرجى التحقق من اتصال الإنترنت والمحاولة مرة أخرى.',
    });
  }

  recentRevisions.set(newRevision.id, { log: newRevision, ts: Date.now() });
  if (!db.revisionLogs.some((r) => r.id === newRevision.id)) db.revisionLogs.push(newRevision);
  saveDatabase(db);

  res.status(201).json({
    revision: newRevision,
    message: `تم تسجيل إتمام مراجعة ${logDate === todayDate ? 'اليوم' : `يوم ${logDate}`} (من الربع ${cycleInfo.review_start} إلى ${cycleInfo.review_end}) بنجاح`,
  });
  } finally {
    inFlightKeys.delete(lockKey);
  }
});

// ==================== ADMIN ENDPOINTS ====================

function requireAdmin(req: Request, res: Response, next: () => void) {
  const user = getAuthUser(req);
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ error: 'هذا الإجراء مخصص للمشرف فقط' });
  }
  next();
}

// Add member (Admin only)
app.post('/api/admin/members', requireAdmin, async (req: Request, res: Response) => {
  const { name, phone, password, role } = req.body;

  if (!name || !phone || !password) {
    return res.status(400).json({ error: 'الاسم ورقم الهاتف وكلمة المرور مطلوبة' });
  }

  // Refresh from Firestore first to ensure phone uniqueness
  await syncFromFirestore();

  const normalizedPhone = String(phone).trim();
  const existingUser = db.users.find((u) => u.phone === normalizedPhone);
  if (existingUser) {
    return res.status(400).json({ error: 'رقم الهاتف هذا مسجل بالفعل لعضو آخر' });
  }

  const hashedPassword = await bcrypt.hash(String(password).trim(), 10);

  const newUser: User & { password_hash: string } = {
    id: `user_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    name: String(name).trim(),
    phone: normalizedPhone,
    password_hash: hashedPassword,
    role: role === 'admin' ? 'admin' : 'member',
    is_active: true,
    created_at: new Date().toISOString(),
  };

  // Write directly to Firestore 'users' collection FIRST - do NOT save locally if Firestore fails!
  try {
    await firestoreService.createLiveUser(newUser);
  } catch (fsErr: unknown) {
    const msg = fsErr instanceof Error ? fsErr.message : String(fsErr);
    console.error('[Firestore Member Write Error]', msg);
    return res.status(500).json({
      error: 'فشل حفظ بيانات العضو الجديد في قاعدة البيانات السحابية (Firestore). لم تتم إضافة العضو، يرجى المحاولة ثانية.',
    });
  }

  db.users.push(newUser);
  saveDatabase(db);

  const { password_hash, ...safeUser } = newUser;
  res.status(201).json({ user: safeUser, message: 'تمت إضافة العضو بنجاح' });
});

// Update member (Admin only)
app.patch('/api/admin/members/:id', requireAdmin, async (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, phone, password, role, is_active } = req.body;

  const user = db.users.find((u) => u.id === id);
  if (!user) {
    return res.status(404).json({ error: 'العضو غير موجود' });
  }

  const updates: Partial<User & { password_hash: string }> = {};

  if (name) {
    updates.name = String(name).trim();
  }
  if (phone) {
    const norm = String(phone).trim();
    const conflict = db.users.find((u) => u.phone === norm && u.id !== id);
    if (conflict) return res.status(400).json({ error: 'رقم الهاتف مستخدم لعضو آخر' });
    updates.phone = norm;
  }
  if (password) {
    const trimmedPassword = String(password).trim();
    if (trimmedPassword) {
      updates.password_hash = await bcrypt.hash(trimmedPassword, 10);
    }
  }
  if (role && (role === 'member' || role === 'admin')) {
    updates.role = role;
  }
  if (typeof is_active === 'boolean') {
    updates.is_active = is_active;
  }

  // Update directly in Firestore FIRST - do NOT save locally if Firestore fails!
  try {
    await firestoreService.updateLiveUser(id, updates);
  } catch (fsErr: unknown) {
    const msg = fsErr instanceof Error ? fsErr.message : String(fsErr);
    console.error('[Firestore Member Update Error]', msg);
    return res.status(500).json({
      error: 'فشل تحديث بيانات العضو في قاعدة البيانات السحابية (Firestore). لم يتم حفظ التعديلات، يرجى المحاولة مرة أخرى.',
    });
  }

  Object.assign(user, updates);
  saveDatabase(db);

  const { password_hash, ...safeUser } = user;
  res.json({ user: safeUser, message: 'تم تحديث بيانات العضو بنجاح' });
});

// Admin: Delete member completely and permanently with all their recitation and revision logs
app.delete('/api/admin/members/:id/completely', requireAdmin, async (req: Request, res: Response) => {
  const { id } = req.params;

  const user = db.users.find((u) => u.id === id);
  if (!user) {
    return res.status(404).json({ error: 'العضو غير موجود' });
  }

  if (user.role === 'admin') {
    return res.status(400).json({ error: 'لا يمكن حذف حساب المشرف' });
  }

  const userName = user.name;

  // Delete permanently from Firestore FIRST - do NOT mutate local state if Firestore fails!
  try {
    await firestoreService.deleteLiveUser(id);
    await firestoreService.deleteLiveRecitationsForMember(id);
    await firestoreService.deleteLiveRevisionsForMember(id);
    await firestoreService.deleteLiveTestAttemptsForMember(id);
  } catch (fsErr: unknown) {
    const msg = fsErr instanceof Error ? fsErr.message : String(fsErr);
    console.error('[Firestore Member Complete Delete Error]', msg);
    return res.status(500).json({
      error: 'فشل حذف العضو وسجلاته من قاعدة البيانات السحابية (Firestore). لم يتم حذف العضو، يرجى المحاولة مرة أخرى.',
    });
  }

  // 1. Remove user from db.users
  db.users = db.users.filter((u) => u.id !== id);

  // 2. Remove all recitation logs for this member
  const initialRecCount = db.recitationLogs.length;
  db.recitationLogs = db.recitationLogs.filter(
    (r) => r.member_id !== id && r.reciter_id !== id
  );
  const deletedRecsCount = initialRecCount - db.recitationLogs.length;

  // 3. Remove all revision logs for this member
  const initialRevCount = db.revisionLogs.length;
  db.revisionLogs = db.revisionLogs.filter((r) => r.member_id !== id);
  for (const [k, v] of recentRevisions) if (v.log.member_id === id) recentRevisions.delete(k);
  for (const [k, v] of recentRecitations) if (v.log.member_id === id || v.log.reciter_id === id) recentRecitations.delete(k);
  const deletedRevsCount = initialRevCount - db.revisionLogs.length;

  // Clean test attempts referencing this member
  if (Array.isArray(db.testAttempts)) {
    db.testAttempts = db.testAttempts.filter(
      (a) => a.candidate_id !== id && a.examiner_id !== id
    );
  }

  // 4. Invalidate any active session for this user
  for (const [token, uid] of sessions.entries()) {
    if (uid === id) {
      sessions.delete(token);
    }
  }

  saveDatabase(db);

  res.json({
    success: true,
    message: `تم حذف العضو "${userName}" نهائيًا ومسح كافة سجلات التسميع (${deletedRecsCount}) وسجلات المراجعة (${deletedRevsCount}) الخاصة به.`,
  });
});

// Rest Days: Add (Admin only)
app.post('/api/admin/rest-days', requireAdmin, async (req: Request, res: Response) => {
  const admin = getAuthUser(req)!;
  const { date, note } = req.body;

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'يرجى تحديد تاريخ صحيح ليوم الاستدراك والراحة (YYYY-MM-DD)' });
  }

  const existing = db.restDays.find((rd) => rd.date === date);
  if (existing) {
    return res.status(400).json({ error: 'هذا التاريخ مسجل بالفعل كيوم استدراك وراحة' });
  }

  const newRestDay: RestDay = {
    id: `rest_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    date,
    note: note ? String(note).trim() : 'يوم استدراك وراحة للمجموعة',
    added_by_admin_id: admin.id,
    added_by_name: admin.name,
    created_at: new Date().toISOString(),
  };

  // Save to Firestore FIRST - do NOT mutate local state if Firestore fails!
  try {
    await firestoreService.addLiveRestDay(newRestDay);
  } catch (fsErr: unknown) {
    const msg = fsErr instanceof Error ? fsErr.message : String(fsErr);
    console.error('[Firestore Rest Day Write Error]', msg);
    return res.status(500).json({
      error: 'فشل حفظ يوم الاستدراك والراحة في قاعدة البيانات السحابية (Firestore). لم يتم الحفظ، يرجى المحاولة ثانية.',
    });
  }

  db.restDays.push(newRestDay);
  saveDatabase(db);

  res.status(201).json({ restDay: newRestDay, message: 'تمت إضافة يوم الاستدراك والراحة بنجاح' });
});

// Rest Days: Delete (Admin only)
app.delete('/api/admin/rest-days/:id', requireAdmin, async (req: Request, res: Response) => {
  const { id } = req.params;
  const target = db.restDays.find((rd) => rd.id === id);

  if (!target) {
    return res.status(404).json({ error: 'يوم الاستدراك غير موجود' });
  }

  // Delete from Firestore FIRST - do NOT mutate local state if Firestore fails!
  try {
    await firestoreService.deleteLiveRestDay(id);
  } catch (fsErr: unknown) {
    const msg = fsErr instanceof Error ? fsErr.message : String(fsErr);
    console.error('[Firestore Rest Day Delete Error]', msg);
    return res.status(500).json({
      error: 'فشل حذف يوم الاستدراك من قاعدة البيانات السحابية (Firestore). لم يتم الحذف، يرجى المحاولة ثانية.',
    });
  }

  db.restDays = db.restDays.filter((rd) => rd.id !== id);
  saveDatabase(db);

  res.json({ success: true, message: 'تم حذف يوم الاستدراك والراحة' });
});

// Pause the program (Admin only)
app.post('/api/admin/pause', requireAdmin, async (req: Request, res: Response) => {
  const todayStr = getTodayDate(req);
  if (db.settings.is_paused) {
    return res.json({ settings: db.settings, message: 'البرنامج متوقف مؤقتًا بالفعل.' });
  }

  const updatedSettings: GroupSettings = {
    ...db.settings,
    is_paused: true,
    paused_at: todayStr,
  };

  // Write to Firestore FIRST
  try {
    await firestoreService.saveLiveSettings(updatedSettings);
  } catch (fsErr: unknown) {
    const msg = fsErr instanceof Error ? fsErr.message : String(fsErr);
    console.error('[Firestore Settings Write Error]', msg);
    return res.status(500).json({
      error: 'فشل حفظ تفعيل الإيقاف المؤقت في قاعدة البيانات السحابية (Firestore). يرجى المحاولة ثانية.',
    });
  }

  db.settings = updatedSettings;
  saveDatabase(db);

  const cycleInfo = calculateCycleInfo(db.settings, db.restDays, todayStr);
  res.json({
    settings: db.settings,
    cycleInfo,
    message: 'تم تفعيل الإيقاف المؤقت للبرنامج وتجميد عداد الدورة لجميع الأعضاء بنجاح.',
  });
});

// Resume the program (Admin only)
app.post('/api/admin/resume', requireAdmin, async (req: Request, res: Response) => {
  const todayStr = getTodayDate(req);
  if (!db.settings.is_paused) {
    return res.json({ settings: db.settings, message: 'البرنامج غير متوقف حاليًا.' });
  }

  // Close the pause as a dated period: paused_at .. the day BEFORE resuming (the resume day is active).
  const closedPeriods = [...(db.settings.pause_periods || [])];
  if (db.settings.paused_at) {
    const d = new Date(db.settings.paused_at + 'T00:00:00Z');
    const t = new Date(todayStr + 'T00:00:00Z');
    const prev = new Date(t.getTime() - 86400000);
    if (prev >= d) {
      closedPeriods.push({ from: db.settings.paused_at, to: prev.toISOString().slice(0, 10) });
    }
  }

  const updatedSettings: GroupSettings = {
    ...db.settings,
    pause_periods: closedPeriods,
    is_paused: false,
    paused_at: null,
  };

  // Write to Firestore FIRST
  try {
    await firestoreService.saveLiveSettings(updatedSettings);
  } catch (fsErr: unknown) {
    const msg = fsErr instanceof Error ? fsErr.message : String(fsErr);
    console.error('[Firestore Settings Write Error]', msg);
    return res.status(500).json({
      error: 'فشل حفظ استئناف البرنامج في قاعدة البيانات السحابية (Firestore). يرجى المحاولة ثانية.',
    });
  }

  db.settings = updatedSettings;
  saveDatabase(db);

  const cycleInfo = calculateCycleInfo(db.settings, db.restDays, todayStr);
  res.json({
    settings: db.settings,
    cycleInfo,
    message: 'تم استئناف البرنامج بنجاح ومواصلة الدورة.',
  });
});

// Record a past pause period whose dates were not stored (Admin only).
// Moves `days` out of the legacy total_paused_days counter into a dated period. Never touches member logs.
app.post('/api/admin/pause-periods', requireAdmin, async (req: Request, res: Response) => {
  const { from, to } = req.body || {};
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(from || '') || !re.test(to || '') || to < from) {
    return res.status(400).json({ error: 'تواريخ الإيقاف غير صالحة (من/إلى).' });
  }
  const days = getCalendarDaysElapsed(from, to);
  const legacy = db.settings.total_paused_days || 0;
  const updatedSettings: GroupSettings = {
    ...db.settings,
    total_paused_days: Math.max(0, legacy - days),
    pause_periods: [...(db.settings.pause_periods || []), { from, to }],
  };
  try {
    await firestoreService.saveLiveSettings(updatedSettings);
  } catch (fsErr: unknown) {
    console.error('[Firestore Settings Write Error]', fsErr instanceof Error ? fsErr.message : String(fsErr));
    return res.status(500).json({ error: 'فشل حفظ فترة الإيقاف في Firestore. حاول مرة أخرى.' });
  }
  db.settings = updatedSettings;
  saveDatabase(db);
  res.json({ settings: db.settings, message: 'تم تسجيل فترة الإيقاف.' });
});

// One-time admin backfill: record missing daily revisions for all active members up to `until` (inclusive).
// Only ADDS missing logs (deterministic id rev_<member>_<date>); never edits or deletes existing data. Idempotent.
app.post('/api/admin/backfill-revisions', requireAdmin, async (req: Request, res: Response) => {
  const { until } = req.body || {};
  const todayDate = getTodayDate(req);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until || '') || until > todayDate) {
    return res.status(400).json({ error: 'تاريخ النهاية غير صالح.' });
  }
  await syncFromFirestore();
  const startDate = db.settings.start_date;
  if (!startDate || until < startDate) {
    return res.status(400).json({ error: 'تاريخ النهاية يسبق بداية البرنامج.' });
  }

  const existing = new Set(db.revisionLogs.map((r) => `${r.member_id}|${r.date}`));
  const members = db.users.filter((u) => u.role === 'member' && u.is_active);
  const toCreate: RevisionLog[] = [];
  const msPerDay = 86400000;
  const startMs = new Date(startDate + 'T00:00:00Z').getTime();
  const endMs = new Date(until + 'T00:00:00Z').getTime();
  for (let t = startMs; t <= endMs; t += msPerDay) {
    const dStr = new Date(t).toISOString().slice(0, 10);
    const info = calculateCycleInfo(db.settings, db.restDays, dStr);
    if (!info.has_started) continue;
    for (const m of members) {
      if (existing.has(`${m.id}|${dStr}`)) continue;
      toCreate.push({
        id: `rev_${m.id}_${dStr}`,
        member_id: m.id,
        member_name: m.name,
        date: dStr,
        cycle_number: db.settings.current_cycle_number,
        review_start_quarter: info.review_start,
        review_end_quarter: info.review_end,
        notes: 'تسجيل إداري: تعذّر حفظ المراجعة بسبب خلل تقني',
        created_at: new Date().toISOString(),
      });
    }
  }

  let created = 0;
  try {
    for (let i = 0; i < toCreate.length; i += 25) {
      const chunk = toCreate.slice(i, i + 25);
      await Promise.all(chunk.map((l) => firestoreService.addLiveRevision(l)));
      for (const l of chunk) {
        recentRevisions.set(l.id, { log: l, ts: Date.now() });
        if (!db.revisionLogs.some((r) => r.id === l.id)) db.revisionLogs.push(l);
      }
      created += chunk.length;
    }
  } catch (fsErr: unknown) {
    saveDatabase(db);
    console.error('[Firestore Backfill Error]', fsErr instanceof Error ? fsErr.message : String(fsErr));
    return res.status(500).json({ error: `توقف الحفظ بعد إضافة ${created} سجل. أعد المحاولة (آمنة ولا تكرر).`, created });
  }
  saveDatabase(db);
  res.json({ created, members: members.length, until, message: `تمت إضافة ${created} سجل مراجعة ناقص حتى ${until}.` });
});

// Update Settings: start_date (Admin only)
app.put('/api/admin/settings', requireAdmin, async (req: Request, res: Response) => {
  const { start_date } = req.body;

  const updatedSettings: GroupSettings = {
    ...db.settings,
    ...(start_date && /^\d{4}-\d{2}-\d{2}$/.test(start_date) ? { start_date } : {}),
  };

  // Write to Firestore FIRST
  try {
    await firestoreService.saveLiveSettings(updatedSettings);
  } catch (fsErr: unknown) {
    const msg = fsErr instanceof Error ? fsErr.message : String(fsErr);
    console.error('[Firestore Settings Write Error]', msg);
    return res.status(500).json({
      error: 'فشل حفظ إعدادات المجموعة في قاعدة البيانات السحابية (Firestore). يرجى المحاولة ثانية.',
    });
  }

  db.settings = updatedSettings;
  saveDatabase(db);

  res.json({ settings: db.settings, message: 'تم تحديث إعدادات المجموعة بنجاح' });
});

// Helper for server-side HTML sanitization (Defense in depth against XSS)
function sanitizeThoughtServer(input: string): string {
  if (!input || typeof input !== 'string') return '';
  return input
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<\/?(iframe|object|embed|link|meta|style|form|input|button|applet|frame|frameset)\b[^>]*>/gi, '')
    .replace(/\s*on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:[^"'\s]*/gi, '')
    .trim();
}

// Update Daily Thought (Admin only)
app.put('/api/admin/daily-thought', requireAdmin, async (req: Request, res: Response) => {
  const admin = getAuthUser(req)!;
  const { daily_thought } = req.body;

  const clean = sanitizeThoughtServer(daily_thought || '');

  const updatedSettings: GroupSettings = {
    ...db.settings,
    daily_thought: clean,
    daily_thought_updated_at: new Date().toISOString(),
    daily_thought_updated_by: admin.name,
  };

  // Write to Firestore FIRST
  try {
    await firestoreService.saveLiveSettings(updatedSettings);
  } catch (fsErr: unknown) {
    const msg = fsErr instanceof Error ? fsErr.message : String(fsErr);
    console.error('[Firestore Daily Thought Write Error]', msg);
    return res.status(500).json({
      error: 'فشل حفظ ونشر خاطرة اليوم في قاعدة البيانات السحابية (Firestore). يرجى المحاولة ثانية.',
    });
  }

  db.settings = updatedSettings;
  saveDatabase(db);

  res.json({
    settings: db.settings,
    message: 'تم حفظ ونشر خاطرة اليوم بنجاح لجميع الأعضاء',
  });
});

// Delete Daily Thought (Admin only)
app.delete('/api/admin/daily-thought', requireAdmin, async (req: Request, res: Response) => {
  const updatedSettings: GroupSettings = {
    ...db.settings,
    daily_thought: '',
  };
  delete updatedSettings.daily_thought_updated_at;
  delete updatedSettings.daily_thought_updated_by;

  // Write to Firestore FIRST
  try {
    await firestoreService.saveLiveSettings(updatedSettings);
  } catch (fsErr: unknown) {
    const msg = fsErr instanceof Error ? fsErr.message : String(fsErr);
    console.error('[Firestore Daily Thought Delete Error]', msg);
    return res.status(500).json({
      error: 'فشل حذف خاطرة اليوم من قاعدة البيانات السحابية (Firestore). يرجى المحاولة ثانية.',
    });
  }

  db.settings = updatedSettings;
  saveDatabase(db);

  res.json({
    settings: db.settings,
    message: 'تم حذف خاطرة اليوم بالكامل ولن تظهر في لوحة الأعضاء',
  });
});

// Factory Reset (Admin only)
app.post('/api/admin/factory-reset', requireAdmin, async (req: Request, res: Response) => {
  const todayStr = getTodayDate(req);

  const resetSettings: GroupSettings = {
    ...db.settings,
    start_date: todayStr,
    current_cycle_number: 1,
    is_paused: false,
    paused_at: null,
    total_paused_days: 0,
    pause_periods: [],
  };

  // Clear Firestore collections and reset settings FIRST
  try {
    await firestoreService.saveLiveSettings(resetSettings);
    await firestoreService.clearAllLiveLogsAndRestDays();
    await firestoreService.clearAllLiveTestAttempts();
  } catch (fsErr: unknown) {
    const msg = fsErr instanceof Error ? fsErr.message : String(fsErr);
    console.error('[Firestore Factory Reset Error]', msg);
    return res.status(500).json({
      error: 'فشل تنفيذ إعادة ضبط المصنع في قاعدة البيانات السحابية (Firestore). يرجى المحاولة ثانية.',
    });
  }

  db.settings = resetSettings;
  db.recitationLogs = [];
  db.revisionLogs = [];
  recentRevisions.clear();
  recentRecitations.clear();
  db.restDays = [];
  db.testAttempts = [];
  saveDatabase(db);

  const cycleInfo = calculateCycleInfo(db.settings, db.restDays, todayStr);

  res.json({
    success: true,
    message: 'تمت إعادة ضبط المصنع ومسح جميع السجلات نهائيًا بنجاح. عادت الدورة إلى اليوم الأول (الربع رقم 1) ورقم الدورة 1.',
    cycleInfo,
    settings: db.settings,
  });
});

// Simplified Admin Statistics
app.get('/api/admin/stats', requireAdmin, (req: Request, res: Response) => {
  const todayStr = getTodayDate(req);
  const cycleInfo = calculateCycleInfo(db.settings, db.restDays, todayStr);
  const members = db.users.filter((u) => u.role === 'member' && u.is_active);

  const memberStats = members.map((m) => {
    const todayRecitation = db.recitationLogs.find(
      (r) => (r.member_id === m.id || r.reciter_id === m.id) && r.date === todayStr
    );

    const todayRevision = db.revisionLogs.find(
      (r) => r.member_id === m.id && r.date === todayStr
    );

    const totalRecitations = db.recitationLogs.filter(
      (r) => r.member_id === m.id || r.reciter_id === m.id
    ).length;

    const totalRevisions = db.revisionLogs.filter((r) => r.member_id === m.id).length;

    const quarterStatus = calculateMemberRequiredQuarter(
      m.id,
      cycleInfo.quarter_of_day,
      db.recitationLogs
    );

    return {
      id: m.id,
      name: m.name,
      phone: m.phone,
      has_recited_today: !!todayRecitation,
      recited_quarter: todayRecitation?.quarter_number,
      listener_name: todayRecitation?.listener_name,
      has_reviewed_today: !!todayRevision,
      total_recitations: totalRecitations,
      total_revisions: totalRevisions,
      required_quarter: quarterStatus.requiredQuarter,
      is_behind: quarterStatus.isBehind,
      missed_quarters_count: quarterStatus.pastMissedQuartersCount,
      missed_quarters: quarterStatus.pastMissedQuarters,
    };
  });

  const pendingRecitationToday = memberStats.filter((m) => !m.has_recited_today);
  const pendingRevisionToday = memberStats.filter((m) => !m.has_reviewed_today);
  const behindMembers = memberStats.filter((m) => m.is_behind);

  res.json({
    total_members: members.length,
    completed_recitation_count: memberStats.filter((m) => m.has_recited_today).length,
    completed_revision_count: memberStats.filter((m) => m.has_reviewed_today).length,
    pending_recitation_today: pendingRecitationToday,
    pending_revision_today: pendingRevisionToday,
    behind_members_count: behindMembers.length,
    member_stats: memberStats,
  });
});

// ==================== PERSONAL SELF-TESTS (اختبر نفسك) ====================
registerPersonalTestRoutes(app, {
  getAuthUser,
  getTodayDate,
  store: personalTestsFirestoreStore,
});

// ==================== PEER TESTING (الاختبارات المتبادلة) ====================

function parseStrictInteger(val: unknown): number | null {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(val);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  return n;
}

/**
 * Unified candidate eligibility calculation.
 * Used identically in /api/tests/:id/eligible-candidates and POST /api/tests/attempts.
 */
function computeCandidateStatus(
  test: TestDefinition,
  member: User,
  todayStr: string
): {
  is_eligible: boolean;
  reasons: string[];
  has_passed: boolean;
  attempts_count: number;
  effective_range_end: number;
  covers_full_range: boolean;
} {
  const attempts = (db.testAttempts || []).filter(
    (a) => a.test_id === test.id && a.candidate_id === member.id
  );
  // Full pass only if covers_full_range !== false (legacy attempts count as full range)
  const hasPassedFull = attempts.some((a) => a.passed && a.covers_full_range !== false);
  const reasons: string[] = [];
  let isEligible = true;

  // 1. Must be active member and in test audience
  if (!member.is_active || member.role !== 'member') {
    isEligible = false;
    reasons.push('العضو غير نشط أو ليس عضواً عادياً في المقرأة');
  }
  if (!isInTestAudience(test, member.id)) {
    isEligible = false;
    reasons.push('العضو ليس ضمن الجمهور المستهدف لهذا الاختبار');
  }

  // 2. Must not have already passed this test fully
  if (hasPassedFull) {
    isEligible = false;
    reasons.push('اجتاز العضو هذا الاختبار بنجاح مسبقاً');
  }

  // 3. Determine member's last completed consecutive quarter from recitation logs
  const memberLogs = (db.recitationLogs || []).filter(
    (l) => l.member_id === member.id || l.reciter_id === member.id
  );
  const completedQuarterSet = new Set<number>(memberLogs.map((l) => l.quarter_number));
  let lastCompletedConsecutive = 0;
  while (completedQuarterSet.has(lastCompletedConsecutive + 1)) {
    lastCompletedConsecutive++;
  }

  const requireAllQuarters = !!test.prerequisites?.require_all_quarters_completed;
  let effectiveRangeEnd = test.range_end;
  let coversFullRange = true;

  if (requireAllQuarters) {
    // Condition enabled: every quarter of the test range must have been recited
    // (the member's position relative to today's quarter does NOT matter).
    let missingInRange = 0;
    for (let q = test.range_start; q <= test.range_end; q++) {
      if (!completedQuarterSet.has(q)) missingInRange++;
    }
    if (missingInRange > 0) {
      isEligible = false;
      reasons.push(
        `لم يتم تسميع جميع أرباع نطاق الاختبار بعد (متبقٍ ${missingInRange} ربع من الأرباع ${test.range_start} إلى ${test.range_end})`
      );
    }
    effectiveRangeEnd = test.range_end;
    coversFullRange = true;
  } else {
    // Condition disabled: enough to have completed at least the first quarter of the range
    if (lastCompletedConsecutive < test.range_start) {
      isEligible = false;
      reasons.push(
        `لم يتم تسميع بداية نطاق الاختبار بعد (أتمّ حتى الربع ${lastCompletedConsecutive} ويبدأ الاختبار من الربع ${test.range_start})`
      );
    }
    effectiveRangeEnd = Math.min(test.range_end, lastCompletedConsecutive);
    coversFullRange = effectiveRangeEnd === test.range_end;

    // If candidate already passed a partial test covering up to or past effectiveRangeEnd,
    // they cannot be retested until they complete more quarters:
    const hasPassedAtOrAbove = attempts.some(
      (a) =>
        a.passed &&
        (a.covers_full_range !== false ||
          (typeof a.effective_range_end === 'number' && a.effective_range_end >= effectiveRangeEnd))
    );
    if (!hasPassedFull && hasPassedAtOrAbove) {
      isEligible = false;
      reasons.push(
        `اجتاز العضو الاختبار لهذا النطاق مسبقًا (حتى الربع ${effectiveRangeEnd})، ويمكن إعادة اختباره بعد إتمام أرباع إضافية`
      );
    }
  }

  // 5. Condition B: Revision completed if enforced
  if (test.prerequisites?.require_revision_completed) {
    const activeCycleDates = getActiveCycleDates(
      db.settings.start_date,
      todayStr,
      db.restDays,
      db.settings
    );
    const revisionStatus = calculateMemberRevisionStatus(
      member.id,
      activeCycleDates,
      db.revisionLogs,
      todayStr
    );
    if (revisionStatus.missedRevisionDaysCount > 0) {
      isEligible = false;
      reasons.push(`توجد أيام مراجعة فائتة (${revisionStatus.missedRevisionDaysCount} يوم)`);
    }
    if (!revisionStatus.hasReviewedToday) {
      isEligible = false;
      reasons.push('لم يتم تأكيد مراجعة اليوم بعد');
    }
  }

  return {
    is_eligible: isEligible && reasons.length === 0,
    reasons,
    has_passed: hasPassedFull,
    attempts_count: attempts.length,
    effective_range_end: effectiveRangeEnd,
    covers_full_range: coversFullRange,
  };
}

// 1. Get tests list (Admin can see all, Members see only active test if in audience)
app.get('/api/tests', (req: Request, res: Response) => {
  const user = getAuthUser(req);
  if (!user) {
    return res.status(401).json({ error: 'يجب تسجيل الدخول أولاً' });
  }

  const allTests = db.tests || [];
  const rawActiveTest = allTests.find((t) => t.is_active && !t.is_finished) || null;
  const isAdmin = user.role === 'admin';
  const activeTest =
    rawActiveTest && (isAdmin || isInTestAudience(rawActiveTest, user.id))
      ? rawActiveTest
      : null;

  res.json({
    tests: isAdmin ? allTests : (activeTest ? [activeTest] : []),
    activeTest,
  });
});

// 2. Admin: Preview questions for any test (without saving)
app.get('/api/admin/tests/:id/preview-questions', requireAdmin, (req: Request, res: Response) => {
  const { id } = req.params;
  const test = (db.tests || []).find((t) => t.id === id);
  if (!test) {
    return res.status(404).json({ error: 'الاختبار غير موجود' });
  }

  const questions = generateTestQuestions(
    test.range_start,
    test.range_end,
    test.questions_count,
    test.lines_per_question,
    test.difficulty || 'any'
  );

  if (questions.length < test.questions_count) {
    return res.status(422).json({
      error: 'النطاق لا يتسع لهذا العدد من الأسئلة بهذا الطول',
    });
  }

  res.json({
    test_id: test.id,
    questions,
  });
});

// 2b. Admin: Test Impact analysis before activation (التحقق من عدد الأعضاء الممنوعين فوراً)
app.get('/api/admin/tests/:id/impact', requireAdmin, (req: Request, res: Response) => {
  const { id } = req.params;
  const test = (db.tests || []).find((t) => t.id === id);
  if (!test) {
    return res.status(404).json({ error: 'الاختبار غير موجود' });
  }

  const todayStr = getTodayDate(req);
  const cycleInfo = calculateCycleInfo(db.settings, db.restDays, todayStr);

  // Active members in test audience
  const audienceMembers = db.users.filter(
    (u) => u.role === 'member' && u.is_active && isInTestAudience(test, u.id)
  );

  const blockedMembers = audienceMembers.filter((m) => {
    // Has completed recitation past range_end
    const quarterStatus = calculateMemberRequiredQuarter(
      m.id,
      cycleInfo.quarter_of_day,
      db.recitationLogs
    );
    const isPastRange = quarterStatus.requiredQuarter > test.range_end;
    if (!isPastRange) return false;

    // Has not passed this test fully
    const hasPassed = (db.testAttempts || []).some(
      (a) => a.test_id === test.id && a.candidate_id === m.id && a.passed && a.covers_full_range !== false
    );
    return !hasPassed;
  });

  res.json({
    test_id: test.id,
    test_type: test.test_type,
    range_start: test.range_start,
    range_end: test.range_end,
    blocked_count: blockedMembers.length,
    blocked_members: blockedMembers.map((m) => ({ id: m.id, name: m.name })),
  });
});

// 3. Admin: Create or update test definition
app.post('/api/admin/tests', requireAdmin, async (req: Request, res: Response) => {
  const admin = getAuthUser(req)!;
  const {
    id,
    title,
    range_start,
    range_end,
    questions_count,
    lines_per_question,
    prerequisites,
    has_max_errors,
    max_errors_allowed,
    test_type,
    difficulty,
    audience,
    selected_member_ids,
    is_active,
  } = req.body;

  // Strict integer validation using parseStrictInteger
  const rStart = parseStrictInteger(range_start);
  const rEnd = parseStrictInteger(range_end);
  const qCount = parseStrictInteger(questions_count);
  const lPerQ = parseStrictInteger(lines_per_question);

  if (rStart === null || rStart < 1 || rStart > 240) {
    return res.status(400).json({ error: 'بداية نطاق الاختبار يجب أن تكون عدداً صحيحاً بين 1 و 240' });
  }
  if (rEnd === null || rEnd < 1 || rEnd > 240) {
    return res.status(400).json({ error: 'نهاية نطاق الاختبار يجب أن تكون عدداً صحيحاً بين 1 و 240' });
  }
  if (rStart > rEnd) {
    return res.status(400).json({ error: 'بداية النطاق يجب أن تكون أقل من أو تساوي نهاية النطاق' });
  }
  if (qCount === null || qCount < 1 || qCount > 50) {
    return res.status(400).json({ error: 'عدد الأسئلة يجب أن يكون عدداً صحيحاً بين 1 و 50' });
  }
  if (lPerQ === null || lPerQ < 1 || lPerQ > 60) {
    return res.status(400).json({ error: 'عدد الأسطر لكل سؤال يجب أن يكون عدداً صحيحاً بين 1 و 60' });
  }

  // Capacity check using estimateRangeLines
  const totalRangeLines = estimateRangeLines(rStart, rEnd);
  if (qCount * lPerQ > 0.8 * totalRangeLines) {
    return res.status(400).json({
      error: 'النطاق لا يتسع لهذا العدد من الأسئلة بهذا الطول، قلّل العدد أو الأسطر أو وسّع النطاق',
    });
  }

  // Title validation
  const cleanTitle = title ? String(title).trim().slice(0, 120) : `اختبار الأرباع (${rStart} - ${rEnd})`;

  // Max errors validation
  const hasMax = !!has_max_errors;
  let maxErr: number | undefined = undefined;
  if (hasMax) {
    const parsedMax = parseStrictInteger(max_errors_allowed);
    if (parsedMax === null || parsedMax < 0 || parsedMax > 100) {
      return res.status(400).json({ error: 'الحد الأقصى للأخطاء يجب أن يكون عدداً صحيحاً بين 0 و 100' });
    }
    maxErr = parsedMax;
  }

  const tType = test_type === 'mandatory' ? 'mandatory' : 'recommended';
  const shouldBeActive = is_active !== undefined ? !!is_active : true;
  const targetAudience: 'all' | 'selected' = audience === 'all' ? 'all' : 'selected';
  const selectedMembers = Array.isArray(selected_member_ids)
    ? selected_member_ids.map(String).filter(Boolean)
    : [];

  // Reject selected audience if member list is empty
  if (targetAudience === 'selected' && selectedMembers.length === 0) {
    return res.status(400).json({
      error: 'يرجى تحديد عضو واحد على الأقل في قائمة الأعضاء المختارين، أو اختيار (كل الأعضاء)',
    });
  }

  // Validate difficulty from 5 allowed values
  const validDifficulties = ['any', 'easy', 'medium', 'hard', 'mixed'] as const;
  const testDiff: 'any' | 'easy' | 'medium' | 'hard' | 'mixed' = validDifficulties.includes(difficulty)
    ? difficulty
    : 'any';

  if (!db.tests) db.tests = [];

  const nowStr = new Date().toISOString();
  const existingIdx = id ? db.tests.findIndex((t) => t.id === id) : -1;
  const existingTest = existingIdx >= 0 ? db.tests[existingIdx] : null;

  if (existingTest?.is_finished) {
    return res.status(400).json({
      error: 'هذا الاختبار منتهٍ نهائيًا ولا يمكن إعادة تفعيله، أنشئ اختبارًا جديدًا',
    });
  }

  // Check if test has prior attempts
  const hasAttempts = existingTest
    ? (db.testAttempts || []).some((a) => a.test_id === existingTest.id)
    : false;

  let createNewDueToMaterialChange = false;
  if (existingTest && hasAttempts) {
    const materialChanged =
      existingTest.range_start !== rStart ||
      existingTest.range_end !== rEnd ||
      existingTest.questions_count !== qCount ||
      existingTest.lines_per_question !== lPerQ ||
      (existingTest.difficulty || 'any') !== testDiff;
    if (materialChanged) {
      createNewDueToMaterialChange = true;
    }
  }

  const targetTestId =
    createNewDueToMaterialChange || !id
      ? `test_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`
      : String(id).trim();

  const testDoc: TestDefinition = {
    id: targetTestId,
    title: cleanTitle,
    range_start: rStart,
    range_end: rEnd,
    questions_count: qCount,
    lines_per_question: lPerQ,
    prerequisites: {
      require_all_quarters_completed: !!prerequisites?.require_all_quarters_completed,
      require_revision_completed: !!prerequisites?.require_revision_completed,
    },
    has_max_errors: hasMax,
    max_errors_allowed: maxErr,
    test_type: tType,
    difficulty: testDiff,
    audience: targetAudience,
    selected_member_ids: selectedMembers,
    is_active: shouldBeActive,
    created_at: createNewDueToMaterialChange || !existingTest ? nowStr : existingTest.created_at,
    created_by_admin_id: admin.id,
    updated_at: nowStr,
  };

  // Atomic write to Firestore FIRST
  try {
    // If archiving old test due to material changes
    if (createNewDueToMaterialChange && existingTest) {
      await firestoreService.updateLiveTest(existingTest.id, {
        is_active: false,
        updated_at: nowStr,
      });
    }

    // If activating new test, deactivate any other active tests first
    if (shouldBeActive) {
      for (const other of db.tests) {
        if (other.id !== targetTestId && other.is_active) {
          await firestoreService.updateLiveTest(other.id, {
            is_active: false,
            updated_at: nowStr,
          });
        }
      }
    }

    // Save test doc to Firestore
    await firestoreService.saveLiveTest(testDoc);
  } catch (fsErr: unknown) {
    const msg = fsErr instanceof Error ? fsErr.message : String(fsErr);
    console.error('[Firestore Test Save Error]', msg);
    return res.status(500).json({
      error: 'فشل حفظ الاختبار في قاعدة البيانات السحابية (Firestore). لم يتم حفظ الاختبار، يرجى المحاولة ثانية.',
    });
  }

  // Update memory only upon Firestore success
  if (createNewDueToMaterialChange && existingTest) {
    existingTest.is_active = false;
  }
  if (shouldBeActive) {
    for (const other of db.tests) {
      if (other.id !== targetTestId) {
        other.is_active = false;
      }
    }
  }

  const existingMemoryIdx = db.tests.findIndex((t) => t.id === targetTestId);
  if (existingMemoryIdx >= 0) {
    db.tests[existingMemoryIdx] = testDoc;
  } else {
    db.tests.push(testDoc);
  }
  saveDatabase(db);

  res.json({
    success: true,
    message: createNewDueToMaterialChange
      ? 'نظراً لوجود محاولات سابقة، تم حفظ التعديلات كاختبار جديد وأرشفة الاختبار السابق لحفظ سجل النتائج.'
      : 'تم حفظ الاختبار بنجاح.',
    test: testDoc,
  });
});

// 4. Admin: Toggle active status of a test
app.patch('/api/admin/tests/:id/status', requireAdmin, async (req: Request, res: Response) => {
  const { id } = req.params;
  const { is_active } = req.body;

  if (!db.tests) db.tests = [];
  const test = db.tests.find((t) => t.id === id);
  if (!test) {
    return res.status(404).json({ error: 'الاختبار غير موجود' });
  }

  if (test.is_finished) {
    return res.status(400).json({
      error: 'هذا الاختبار منتهٍ نهائيًا ولا يمكن إعادة تفعيله، أنشئ اختبارًا جديدًا',
    });
  }

  const nextActive = !!is_active;

  // Reject activation of selected-audience test if selected_member_ids is empty
  if (
    nextActive &&
    (test.audience === 'selected' || !test.audience) &&
    (!test.selected_member_ids || test.selected_member_ids.length === 0)
  ) {
    return res.status(400).json({
      error: 'لا يمكن تفعيل اختبار مخصص لأعضاء مختارين دون تحديد أي عضو في قائمته',
    });
  }

  const nowStr = new Date().toISOString();

  // Write to Firestore FIRST
  try {
    if (nextActive) {
      for (const other of db.tests) {
        if (other.id !== id && other.is_active) {
          await firestoreService.updateLiveTest(other.id, {
            is_active: false,
            updated_at: nowStr,
          });
        }
      }
    }
    await firestoreService.updateLiveTest(id, {
      is_active: nextActive,
      updated_at: nowStr,
    });
  } catch (fsErr: unknown) {
    const msg = fsErr instanceof Error ? fsErr.message : String(fsErr);
    console.error('[Firestore Test Status Error]', msg);
    return res.status(500).json({
      error: 'فشل تعديل حالة الاختبار في قاعدة البيانات السحابية (Firestore). يرجى المحاولة ثانية.',
    });
  }

  // Update memory only upon Firestore success
  if (nextActive) {
    for (const other of db.tests) {
      if (other.id !== id) {
        other.is_active = false;
      }
    }
  }
  test.is_active = nextActive;
  saveDatabase(db);

  res.json({
    success: true,
    message: nextActive ? 'تم تفعيل الاختبار بنجاح' : 'تم إيقاف الاختبار بنجاح',
    test,
  });
});

// Admin: Finish test permanently (إنهاء الاختبار نهائيًا)
app.post('/api/admin/tests/:id/finish', requireAdmin, async (req: Request, res: Response) => {
  const { id } = req.params;

  if (!db.tests) db.tests = [];
  const test = db.tests.find((t) => t.id === id);
  if (!test) {
    return res.status(404).json({ error: 'الاختبار غير موجود' });
  }

  if (test.is_finished) {
    return res.status(400).json({ error: 'هذا الاختبار منتهٍ بالفعل ولا يمكن إنهاؤه مجدداً' });
  }

  const nowStr = new Date().toISOString();

  // Write to Firestore FIRST
  try {
    await firestoreService.updateLiveTest(id, {
      is_active: false,
      is_finished: true,
      finished_at: nowStr,
      updated_at: nowStr,
    });
  } catch (fsErr: unknown) {
    const msg = fsErr instanceof Error ? fsErr.message : String(fsErr);
    console.error('[Firestore Test Finish Error]', msg);
    return res.status(500).json({
      error: 'فشل إنهاء الاختبار في قاعدة البيانات السحابية (Firestore). يرجى المحاولة ثانية.',
    });
  }

  // Update memory only upon Firestore success
  test.is_active = false;
  test.is_finished = true;
  test.finished_at = nowStr;
  test.updated_at = nowStr;
  saveDatabase(db);

  res.json({
    success: true,
    message: 'تم إنهاء الاختبار نهائيًا بنجاح',
    test,
  });
});

// 5. Eligible candidates for the active test
app.get('/api/tests/:id/eligible-candidates', (req: Request, res: Response) => {
  const user = getAuthUser(req);
  if (!user) {
    return res.status(401).json({ error: 'يجب تسجيل الدخول أولاً' });
  }

  const { id } = req.params;
  const test = (db.tests || []).find((t) => t.id === id);
  if (!test) {
    return res.status(404).json({ error: 'الاختبار غير موجود' });
  }

  // Examiner must be member, active, and in audience
  const isAdmin = user.role === 'admin';
  if (!isAdmin) {
    if (user.role !== 'member' || !user.is_active || !isInTestAudience(test, user.id)) {
      return res.status(403).json({ error: 'لست ضمن قائمة الأعضاء المخولين بالمشاركة في هذا الاختبار' });
    }
  }

  const todayStr = getTodayDate(req);

  // Eligible peers: active members in test audience (and not the tester themselves)
  const candidatePool = db.users.filter(
    (u) => u.role === 'member' && u.is_active && u.id !== user.id && isInTestAudience(test, u.id)
  );

  const eligibleCandidates = candidatePool.map((m) => {
    const status = computeCandidateStatus(test, m, todayStr);
    return {
      id: m.id,
      name: m.name,
      phone: m.phone,
      is_eligible: status.is_eligible,
      ineligibility_reasons: status.reasons,
      has_passed: status.has_passed,
      attempts_count: status.attempts_count,
      effective_range_end: status.effective_range_end,
      covers_full_range: status.covers_full_range,
    };
  });

  res.json({
    test,
    candidates: eligibleCandidates,
  });
});

// 6. Generate test questions for an active test session
app.get('/api/tests/:id/generate-questions', (req: Request, res: Response) => {
  const user = getAuthUser(req);
  if (!user) {
    return res.status(401).json({ error: 'يجب تسجيل الدخول أولاً' });
  }

  const { id } = req.params;
  const test = (db.tests || []).find((t) => t.id === id);
  if (!test) {
    return res.status(404).json({ error: 'الاختبار غير موجود' });
  }

  const isAdmin = user.role === 'admin';
  if (!isAdmin && (!user.is_active || user.role !== 'member' || !isInTestAudience(test, user.id))) {
    return res.status(403).json({ error: 'لست ضمن قائمة الأعضاء المخولين بالمشاركة في هذا الاختبار' });
  }

  const todayStr = getTodayDate(req);
  const candidateId = typeof req.query.candidate_id === 'string' ? req.query.candidate_id : undefined;

  let effectiveRangeEnd = test.range_end;

  if (candidateId) {
    const candidate = db.users.find((u) => u.id === candidateId && u.is_active);
    if (!candidate) {
      return res.status(404).json({ error: 'العضو المختبَر غير موجود' });
    }
    const status = computeCandidateStatus(test, candidate, todayStr);
    if (!status.is_eligible) {
      return res.status(400).json({
        error: `العضو غير مؤهل للاختبار: ${status.reasons.join('، ')}`,
      });
    }
    effectiveRangeEnd = status.effective_range_end;
  }

  const questions = generateTestQuestions(
    test.range_start,
    effectiveRangeEnd,
    test.questions_count,
    test.lines_per_question,
    test.difficulty || 'any'
  );

  if (questions.length < test.questions_count) {
    return res.status(422).json({
      error: 'النطاق لا يتسع لهذا العدد من الأسئلة بهذا الطول',
    });
  }

  res.json({
    test_id: test.id,
    effective_range_end: effectiveRangeEnd,
    questions,
  });
});

// 7. Record a completed test attempt (peer testing submission)
app.post('/api/tests/attempts', async (req: Request, res: Response) => {
  const examiner = getAuthUser(req);
  if (!examiner) {
    return res.status(401).json({ error: 'يجب تسجيل الدخول أولاً' });
  }

  const { test_id, candidate_id, questions_results, notes } = req.body;

  if (!test_id || !candidate_id) {
    return res.status(400).json({ error: 'يرجى تحديد الاختبار والعضو المُختبَر' });
  }

  const test = (db.tests || []).find((t) => t.id === test_id);
  if (!test) {
    return res.status(404).json({ error: 'الاختبار غير موجود' });
  }
  if (!test.is_active) {
    return res.status(400).json({ error: 'هذا الاختبار غير مفعّل حالياً' });
  }

  // Examiner validation
  if (examiner.role !== 'member' || !examiner.is_active) {
    return res.status(403).json({ error: 'يجب أن يكون المُختبِر عضواً نشطاً في المقرأة' });
  }
  if (!isInTestAudience(test, examiner.id)) {
    return res.status(403).json({ error: 'أنت لست ضمن قائمة الأعضاء المخولين بإجراء هذا الاختبار' });
  }

  // Cannot test oneself
  if (examiner.id === candidate_id) {
    return res.status(400).json({ error: 'لا يمكن للعضو اختبار نفسه؛ يجب أن يختبرك زميل في المقرأة' });
  }

  // Candidate validation
  const candidate = db.users.find((u) => u.id === candidate_id);
  if (!candidate || candidate.role !== 'member' || !candidate.is_active) {
    return res.status(404).json({ error: 'العضو المُختبَر غير موجود أو حسابه غير نشط' });
  }
  if (!isInTestAudience(test, candidate.id)) {
    return res.status(400).json({ error: 'العضو المُختبَر ليس ضمن قائمة الأعضاء المشمولين بهذا الاختبار' });
  }

  // Anti-duplicate / Spam prevention: reject matching attempt within last 60 seconds
  const nowMs = Date.now();
  const recentDuplicate = (db.testAttempts || []).find((a) => {
    if (a.test_id === test.id && a.candidate_id === candidate.id && a.examiner_id === examiner.id) {
      const attemptTime = new Date(a.created_at).getTime();
      return nowMs - attemptTime < 60000;
    }
    return false;
  });
  if (recentDuplicate) {
    return res.status(429).json({
      error: 'تم تسجيل محاولة لنفس العضو من قِبلك للتو! يرجى الانتظار دقيقة واحدة قبل تسجيل محاولة جديدة منعاً للتكرار.',
    });
  }

  const todayStr = getTodayDate(req);

  // Candidate eligibility check at submission time using unified function
  const candidateStatus = computeCandidateStatus(test, candidate, todayStr);
  if (candidateStatus.has_passed) {
    return res.status(400).json({ error: 'العضو اجتاز هذا الاختبار بالفعل بنجاح ولا يحتاج لإعادته' });
  }
  if (!candidateStatus.is_eligible) {
    return res.status(400).json({
      error: `العضو غير مؤهل لخوض هذا الاختبار حالياً: ${candidateStatus.reasons.join('، ')}`,
    });
  }

  // Untrusted client validation for questions
  if (!Array.isArray(questions_results) || questions_results.length === 0) {
    return res.status(400).json({ error: 'يجب إرسال بيانات أسئلة الاختبار' });
  }
  if (questions_results.length !== test.questions_count) {
    return res.status(400).json({
      error: `عدد الأسئلة المرسلة (${questions_results.length}) لا يطابق عدد أسئلة الاختبار المطلوب بالضبط (${test.questions_count})`,
    });
  }

  const effectiveRangeEnd = candidateStatus.effective_range_end;
  const minVerseIdx = getQuarterStartIndex(test.range_start);
  const maxVerseIdx = getQuarterEndIndex(effectiveRangeEnd);

  const verifiedQuestionsResults = [];
  let calculatedTotalErrors = 0;
  let prevEndVerseIdx = -1;

  for (let i = 0; i < questions_results.length; i++) {
    const q = questions_results[i];
    const sSurah = parseStrictInteger(q?.start_surah);
    const sAyah = parseStrictInteger(q?.start_ayah);
    const eSurah = parseStrictInteger(q?.end_surah);
    const eAyah = parseStrictInteger(q?.end_ayah);
    const qErrors = parseStrictInteger(q?.errors_count);

    if (sSurah === null || sAyah === null || eSurah === null || eAyah === null) {
      return res.status(400).json({ error: `بيانات السورة أو الآية غير صالحة في السؤال رقم ${i + 1}` });
    }

    const startIdx = getVerseIndexBySurahAyah(sSurah, sAyah);
    const endIdx = getVerseIndexBySurahAyah(eSurah, eAyah);

    if (startIdx === undefined || endIdx === undefined) {
      return res.status(400).json({ error: `الآية المحددة غير موجودة في المصحف الشريف في السؤال رقم ${i + 1}` });
    }
    if (startIdx > endIdx) {
      return res.status(400).json({ error: `بداية السؤال يجب أن تسبق نهايته في السؤال رقم ${i + 1}` });
    }
    if (startIdx < minVerseIdx || endIdx > maxVerseIdx) {
      return res.status(400).json({
        error: `السؤال رقم ${i + 1} يقع خارج نطاق أرباع الاختبار (${test.range_start} إلى ${effectiveRangeEnd})`,
      });
    }
    if (i > 0 && startIdx <= prevEndVerseIdx) {
      return res.status(400).json({ error: `يوجد تداخل بين السؤال رقم ${i + 1} والسؤال السابق له` });
    }
    prevEndVerseIdx = endIdx;

    if (qErrors === null || qErrors < 0 || qErrors > 99) {
      return res.status(400).json({ error: `عدد الأخطاء يجب أن يكون رقماً صحيحاً بين 0 و 99 في السؤال رقم ${i + 1}` });
    }
    calculatedTotalErrors += qErrors;

    const startVerseObj = ALL_VERSES[startIdx];
    const endVerseObj = ALL_VERSES[endIdx];

    const cleanQNotes = q.notes ? String(q.notes).trim().slice(0, 300) : undefined;

    verifiedQuestionsResults.push({
      question_number: i + 1,
      start_surah: startVerseObj.surah,
      start_surah_name: startVerseObj.surah_name,
      start_ayah: startVerseObj.ayah,
      end_surah: endVerseObj.surah,
      end_surah_name: endVerseObj.surah_name,
      end_ayah: endVerseObj.ayah,
      errors_count: qErrors,
      notes: cleanQNotes,
    });
  }

  // Calculate pass/fail strictly on server
  let passed = true;
  if (test.has_max_errors && typeof test.max_errors_allowed === 'number') {
    passed = calculatedTotalErrors <= test.max_errors_allowed;
  }

  const cleanOverallNotes = notes ? String(notes).trim().slice(0, 300) : undefined;
  const nowIso = new Date().toISOString();
  const attemptId = `att_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  const attemptDoc: TestAttempt = {
    id: attemptId,
    test_id: test.id,
    candidate_id: candidate.id,
    candidate_name: candidate.name,
    examiner_id: examiner.id,
    examiner_name: examiner.name,
    total_errors: calculatedTotalErrors,
    passed,
    status: passed ? 'passed' : 'failed',
    date: todayStr,
    questions_results: verifiedQuestionsResults,
    notes: cleanOverallNotes,
    created_at: nowIso,
    effective_range_end: effectiveRangeEnd,
    covers_full_range: candidateStatus.covers_full_range,
  };

  // Write to Firestore FIRST
  try {
    await firestoreService.addLiveTestAttempt(attemptDoc);
  } catch (fsErr: unknown) {
    const msg = fsErr instanceof Error ? fsErr.message : String(fsErr);
    console.error('[Firestore Test Attempt Write Error]', msg);
    return res.status(500).json({
      error: 'فشل حفظ نتيجة الاختبار في قاعدة البيانات السحابية (Firestore). لم يتم حفظ النتيجة، يرجى المحاولة ثانية.',
    });
  }

  // Update memory only upon Firestore success
  if (!db.testAttempts) db.testAttempts = [];
  db.testAttempts.unshift(attemptDoc);
  saveDatabase(db);

  res.json({
    success: true,
    message: passed
      ? 'تم تسجيل الاختبار بنجاح واجتياز العضو للاختبار!'
      : 'تم تسجيل الاختبار (لم يجتز العضو بنجاح بسبب تجاوز حد الأخطاء المسموح).',
    attempt: attemptDoc,
  });
});

// 8. Get test attempts (with privacy filter: non-admins only see attempts they took part in)
app.get('/api/tests/attempts', (req: Request, res: Response) => {
  const user = getAuthUser(req);
  if (!user) {
    return res.status(401).json({ error: 'يجب تسجيل الدخول أولاً' });
  }

  const { test_id, candidate_id, examiner_id } = req.query;
  const isAdmin = user.role === 'admin';

  let attempts = [...(db.testAttempts || [])];

  // Privacy filter: Regular members only see their own attempts
  if (!isAdmin) {
    attempts = attempts.filter((a) => a.candidate_id === user.id || a.examiner_id === user.id);
  }

  if (test_id) {
    attempts = attempts.filter((a) => a.test_id === test_id);
  }
  if (candidate_id) {
    attempts = attempts.filter((a) => a.candidate_id === candidate_id);
  }
  if (examiner_id) {
    attempts = attempts.filter((a) => a.examiner_id === examiner_id);
  }

  res.json({
    attempts,
  });
});

// ==================== VITE / STATIC SERVING ====================


async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Motqin server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start Motqin server:', err);
});
