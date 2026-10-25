import express, { Request, Response } from 'express';
import crypto from 'crypto';
import { User, GroupSettings, RestDay, RecitationLog, RevisionLog, TestDefinition, TestAttempt } from '../types';
import {
  calculateCycleInfo,
  calculateMemberRequiredQuarter,
  formatDate,
  getCalendarDaysElapsed,
  getActiveCycleDates,
  calculateMemberRevisionStatus,
} from '../lib/calculations';
import {
  generateTestQuestions,
  estimateRangeLines,
  isInTestAudience,
  getQuarterStartIndex,
  getQuarterEndIndex,
  getVerseIndexBySurahAyah,
  getAbsoluteLineStart,
  getAbsoluteLineEnd,
  ALL_VERSES,
} from '../lib/testGenerator';
import { phoneToAuthEmail } from '../lib/authIdentity';
import { registerPersonalTestRoutes, type PersonalTestStore } from './personalTests';
import type { AuthService } from './auth';
import * as store from './store';
import type { AppState, Database, Queryable, AttemptQuestionGeometry } from './store';

export interface AppDeps {
  db: Database;
  auth: AuthService;
  publicConfig: { supabaseUrl: string; supabasePublishableKey: string };
}

type Reply = { status: number; body: unknown };
const reply = (status: number, body: unknown): Reply => ({ status, body });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** Supabase Auth's minimum password length (project setting; cannot be lower than 6). */
const MIN_PASSWORD_LENGTH = 6;

/**
 * Resolve today's date in YYYY-MM-DD format:
 * 1. Checks client's local date sent via X-Client-Date header
 * 2. Checks client_date query param
 * 3. Falls back to Makkah time (Asia/Riyadh, UTC+3)
 */
export function getTodayDate(req?: Request): string {
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

function parseStrictInteger(val: unknown): number | null {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(val);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  return n;
}

function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && (!constraint || e.constraint === constraint);
}

export function createApp(deps: AppDeps): express.Express {
  const { db, auth } = deps;
  const app = express();
  app.use(express.json());

  // ---------------------------------------------------------------------------------------------
  // Plumbing
  // ---------------------------------------------------------------------------------------------

  /** Express adapter: the handler computes a reply (after its transaction committed); errors → 500. */
  const route =
    (failureMessage: string, handler: (req: Request) => Promise<Reply>) =>
    async (req: Request, res: Response) => {
      try {
        const r = await handler(req);
        res.status(r.status).json(r.body);
      } catch (err: unknown) {
        console.error(`[Supabase ${req.method} ${req.path}]`, err instanceof Error ? err.message : String(err));
        res.status(500).json({ error: failureMessage });
      }
    };

  /** Consistent read-only snapshot of the whole program. */
  const readState = () =>
    db.transaction(async (tx) => {
      await tx.query('set transaction isolation level repeatable read, read only');
      return store.loadState(tx);
    });

  /** Mutation transaction: locks the active cycle, so writers are serialized and validations stay true. */
  const writeTransaction = <T>(fn: (tx: Queryable, state: AppState) => Promise<T>) =>
    db.transaction(async (tx) => fn(tx, await store.loadState(tx, { lock: true })));

  async function getAuthUserId(req: Request): Promise<string | null> {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) return null;
    const token = header.slice(7).trim();
    if (!token) return null;
    try {
      return await auth.verifyAccessToken(token);
    } catch (err) {
      console.warn('[Auth verify warning]', err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  const findUser = (state: AppState, id: string | null): User | null =>
    (id && state.users.find((u) => u.id === id)) || null;

  const NOT_ADMIN = reply(403, { error: 'هذا الإجراء مخصص للمشرف فقط' });
  const NOT_SIGNED_IN = reply(401, { error: 'يجب تسجيل الدخول أولاً' });

  // ==================== API ROUTES ====================

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // Public (non-secret) browser configuration: Supabase URL + publishable key only.
  app.get('/api/public-config', (_req: Request, res: Response) => {
    res.json(deps.publicConfig);
  });

  // Supabase connectivity diagnostic
  app.get(
    '/api/status',
    route('تعذر الاتصال بقاعدة البيانات', async () => {
      await db.query('select 1');
      return reply(200, { backend: 'supabase', connected: true });
    })
  );

  // Authentication: sign-in happens in the browser through Supabase Auth.
  app.post('/api/auth/login', (_req: Request, res: Response) => {
    res.status(410).json({ error: 'تم تحديث نظام الدخول. يرجى تحديث الصفحة ثم تسجيل الدخول من جديد.' });
  });

  app.get(
    '/api/auth/me',
    route('تعذر تحميل بيانات الحساب', async (req) => {
      const userId = await getAuthUserId(req);
      const user = userId ? await store.loadUser(db, userId) : null;
      if (!user) return reply(401, { error: 'غير مسجل الدخول' });
      return reply(200, { user });
    })
  );

  // Sessions live in the browser (Supabase Auth); nothing to clear server-side.
  app.post('/api/auth/logout', (_req: Request, res: Response) => {
    res.json({ success: true });
  });

  // Change Password (Authenticated User)
  app.post(
    '/api/auth/change-password',
    route('فشل حفظ كلمة المرور الجديدة في قاعدة البيانات السحابية. لم يتم تطبيق التغيير، يرجى المحاولة ثانية.', async (req) => {
      const userId = await getAuthUserId(req);
      const user = userId ? await store.loadUser(db, userId) : null;
      if (!user) return NOT_SIGNED_IN;

      const { currentPassword, newPassword, confirmPassword } = req.body;

      if (!currentPassword || !newPassword) {
        return reply(400, { error: 'يرجى إدخال كلمة المرور الحالية وكلمة المرور الجديدة' });
      }

      const isCurrentValid = await auth.verifyPassword(phoneToAuthEmail(user.phone), String(currentPassword));
      if (!isCurrentValid) {
        return reply(400, { error: 'كلمة المرور الحالية غير صحيحة' });
      }

      const trimmedNewPassword = String(newPassword).trim();
      if (!trimmedNewPassword) {
        return reply(400, { error: 'لا يمكن أن تكون كلمة المرور الجديدة فارغة' });
      }

      if (trimmedNewPassword.length < MIN_PASSWORD_LENGTH) {
        return reply(400, { error: `يجب ألا تقل كلمة المرور الجديدة عن ${MIN_PASSWORD_LENGTH} خانات` });
      }

      if (confirmPassword !== undefined && trimmedNewPassword !== String(confirmPassword).trim()) {
        return reply(400, { error: 'كلمة المرور الجديدة وتأكيدها غير متطابقين' });
      }

      await auth.updateUser(user.id, { password: trimmedNewPassword });
      // As before, a password change ends every existing session (including this one).
      await store.revokeSessions(db, user.id);
      auth.forget(user.id);

      return reply(200, { message: 'تم تغيير كلمة المرور بنجاح' });
    })
  );

  // Bootstrap / Global State
  app.get(
    '/api/bootstrap',
    route('تعذر جلب بيانات المقرأة', async (req) => {
      const userId = await getAuthUserId(req);
      if (!userId) return NOT_SIGNED_IN;
      const db = await readState();
      const user = findUser(db, userId);
      if (!user) return NOT_SIGNED_IN;

      const todayStr = getTodayDate(req);
      const cycleInfo = calculateCycleInfo(db.settings, db.restDays, todayStr);

      const todayRecitations = db.recitationLogs.filter((r) => r.date === todayStr);
      const todayRevisions = db.revisionLogs.filter((r) => r.date === todayStr);

      const isAdmin = user.role === 'admin';

      const allTests = db.tests || [];
      const rawActiveTest = allTests.find((t) => t.is_active && !t.is_finished) || null;
      const activeTest = rawActiveTest && (isAdmin || isInTestAudience(rawActiveTest, user.id)) ? rawActiveTest : null;

      let clientTests: TestDefinition[] = [];
      let clientAttempts: TestAttempt[] = [];

      if (isAdmin) {
        clientTests = allTests;
        clientAttempts = db.testAttempts || [];
      } else {
        clientTests = activeTest ? [activeTest] : [];
        clientAttempts = (db.testAttempts || []).filter((a) => a.candidate_id === user.id || a.examiner_id === user.id);
      }

      return reply(200, {
        cycleInfo,
        settings: db.settings,
        restDays: db.restDays,
        users: db.users,
        todayRecitations,
        todayRevisions,
        tests: clientTests,
        activeTest,
        testAttempts: clientAttempts,
      });
    })
  );

  // Recitation logs list
  app.get(
    '/api/recitations',
    route('تعذر جلب سجلات التسميع', async (req) => {
      if (!(await getAuthUserId(req))) return NOT_SIGNED_IN;
      const db = await readState();
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

      return reply(200, { recitations: logs });
    })
  );

  // Record a Recitation: Member registers for themselves!
  app.post(
    '/api/recitations',
    route('فشل حفظ سجل التسميع في قاعدة البيانات السحابية. يرجى التحقق من اتصال الإنترنت والمحاولة مرة أخرى.', async (req) => {
      const userId = await getAuthUserId(req);
      if (!userId) return NOT_SIGNED_IN;

      return writeTransaction(async (tx, db) => {
        const currentUser = findUser(db, userId);
        if (!currentUser) return NOT_SIGNED_IN;

        if (currentUser.role === 'admin') {
          return reply(403, { error: 'المشرف لا يسجل تسميعًا' });
        }

        if (!currentUser.is_active) {
          return reply(403, {
            error: 'حسابك مُعلّق (مُقصَى) حاليًا بقرار من المشرف، ولا يمكنك تسجيل التسميع حتى تتم إعادة تفعيلك.',
          });
        }

        const { quarter_number, listener_id, notes, date } = req.body;
        const logDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : getTodayDate(req);

        // Rule: Sequential catch-up requirement (can recite multiple missed quarters in the same day)
        const currentCycleInfo = calculateCycleInfo(db.settings, db.restDays, logDate);

        if (!currentCycleInfo.has_started) {
          return reply(400, {
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
          return reply(400, {
            error: `لقد أتممت بالفعل جميع الأرباع حتى ربع اليوم الحالي للمجموعة (الربع ${currentCycleInfo.quarter_of_day}). لا يمكن تسجيل ربع أكبر من ربع اليوم للمجموعة (لا يمكن السبق على الجدول الزمني الجماعي).`,
          });
        }

        const quarter = parseInt(String(quarter_number), 10);
        if (isNaN(quarter) || quarter !== memberQuarterStatus.requiredQuarter) {
          return reply(400, {
            error: `لا يمكن تخطي الربع الفائت! الربع المطلوب منك تسميعه الآن هو الربع رقم (${memberQuarterStatus.requiredQuarter}). يجب تسميع الأرباع السابقة بالترتيب أولاً.`,
          });
        }

        // Rule: Cannot advance past the group's current quarter of day
        if (quarter > currentCycleInfo.quarter_of_day) {
          return reply(400, {
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
            return reply(403, {
              error: `يجب اجتياز الاختبار الإلزامي للأرباع (${activeMandatoryTest.range_start} - ${activeMandatoryTest.range_end}) بنجاح أولاً قبل متابعة تسميع الأرباع التالية.`,
            });
          }
        }

        // Guard against duplicate records for the exact same quarter
        const alreadyCompletedQuarter = db.recitationLogs.some(
          (r) => (r.member_id === currentUser.id || r.reciter_id === currentUser.id) && r.quarter_number === quarter
        );
        if (alreadyCompletedQuarter) {
          return reply(400, { error: `الربع رقم (${quarter}) مسجل ومكتمل لديك بالفعل.` });
        }

        // Required listener colleague (strictly from group members - cannot recite to outside person)
        if (!listener_id) {
          return reply(400, {
            error: 'يرجى اختيار الزميل المستمع من أعضاء المقرأة (لا يُسمح بالتسميع على شخص من الخارج).',
          });
        }

        const peer = db.users.find(
          (u) => u.id === listener_id && u.is_active && u.role === 'member' && u.id !== currentUser.id
        );
        if (!peer) {
          return reply(400, {
            error: 'الزميل المستمع المحدد غير صالح. يجب اختيار زميل نشط من أعضاء المقرأة.',
          });
        }

        const newLog: RecitationLog = await store.insertRecitation(tx, db, {
          memberId: currentUser.id,
          memberName: currentUser.name,
          listenerId: peer.id,
          listenerName: peer.name,
          quarter,
          date: logDate,
          createdAt: new Date().toISOString(),
          ...(notes && String(notes).trim() ? { notes: String(notes).trim() } : {}),
        });

        return reply(201, {
          recitation: newLog,
          message: `تم تسجيل إتمام تسميع الربع ${quarter} بنجاح وتقبل الله منكم!`,
        });
      });
    })
  );

  // Revision logs list
  app.get(
    '/api/revisions',
    route('تعذر جلب سجلات المراجعة', async (req) => {
      if (!(await getAuthUserId(req))) return NOT_SIGNED_IN;
      const db = await readState();
      const { member_id, date } = req.query;
      let logs = [...db.revisionLogs];

      if (member_id) {
        logs = logs.filter((l) => l.member_id === member_id);
      }
      if (date) {
        logs = logs.filter((l) => l.date === date);
      }

      logs.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      return reply(200, { revisions: logs });
    })
  );

  // Record Daily Revision (Member for themselves)
  app.post(
    '/api/revisions',
    route('فشل حفظ سجل المراجعة في قاعدة البيانات السحابية. يرجى التحقق من اتصال الإنترنت والمحاولة مرة أخرى.', async (req) => {
      const userId = await getAuthUserId(req);
      if (!userId) return NOT_SIGNED_IN;

      return writeTransaction(async (tx, db) => {
        const currentUser = findUser(db, userId);
        if (!currentUser) return NOT_SIGNED_IN;

        if (currentUser.role === 'admin') {
          return reply(403, { error: 'المشرف لا يسجل مراجعة' });
        }

        if (!currentUser.is_active) {
          return reply(403, {
            error: 'حسابك مُعلّق (مُقصَى) حاليًا بقرار من المشرف، ولا يمكنك تسجيل المراجعة حتى تتم إعادة تفعيلك.',
          });
        }

        const { notes, date } = req.body;
        const todayDate = getTodayDate(req);
        const logDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : todayDate;

        // Validate date: must be within valid active cycle dates from start date up to today
        const startDate = db.settings.start_date;
        if (!startDate || logDate < startDate) {
          return reply(400, {
            error: 'التاريخ المحدد غير صالح: لا يمكن تسجيل مراجعة لتاريخ يسبق بداية برنامج المقرأة.',
          });
        }

        if (logDate > todayDate) {
          return reply(400, {
            error: 'التاريخ المحدد غير صالح: لا يمكن تسجيل مراجعة لتاريخ مستقبلي بعد اليوم الحالي.',
          });
        }

        // Rest days and paused days are allowed to be recorded (they are never counted as "missed").
        const cycleInfo = calculateCycleInfo(db.settings, db.restDays, logDate);

        if (!cycleInfo.has_started) {
          return reply(400, { error: 'برنامج المقرأة لم يبدأ بعد في التاريخ المحدد.' });
        }

        const existing = db.revisionLogs.find((r) => r.member_id === currentUser.id && r.date === logDate);
        if (existing) {
          // Idempotent: a retry after a lost response must look like success, not an error.
          return reply(200, {
            revision: existing,
            already_recorded: true,
            message: 'تم تأكيد مراجعة هذا اليوم مسبقًا.',
          });
        }

        const newRevision: RevisionLog | null = await store.insertRevision(tx, db, {
          memberId: currentUser.id,
          memberName: currentUser.name,
          date: logDate,
          start: cycleInfo.review_start,
          end: cycleInfo.review_end,
          createdAt: new Date().toISOString(),
          ...(notes && String(notes).trim() ? { notes: String(notes).trim() } : {}),
        });
        if (!newRevision) throw new Error('Revision already exists for this member and date');

        return reply(201, {
          revision: newRevision,
          message: `تم تسجيل إتمام مراجعة ${logDate === todayDate ? 'اليوم' : `يوم ${logDate}`} (من الربع ${cycleInfo.review_start} إلى ${cycleInfo.review_end}) بنجاح`,
        });
      });
    })
  );

  // ==================== ADMIN ENDPOINTS ====================

  // Add member (Admin only)
  app.post(
    '/api/admin/members',
    route('فشل حفظ بيانات العضو الجديد في قاعدة البيانات السحابية. لم تتم إضافة العضو، يرجى المحاولة ثانية.', async (req) => {
      const adminId = await getAuthUserId(req);
      if (!adminId) return NOT_ADMIN;
      const { name, phone, password, role } = req.body;

      let createdAuthId: string | null = null;
      try {
        return await writeTransaction(async (tx, db) => {
          const admin = findUser(db, adminId);
          if (!admin || admin.role !== 'admin') return NOT_ADMIN;

          if (!name || !phone || !password) {
            return reply(400, { error: 'الاسم ورقم الهاتف وكلمة المرور مطلوبة' });
          }

          const normalizedPhone = String(phone).trim();
          const loginEmail = phoneToAuthEmail(normalizedPhone);
          const existingUser = db.users.find((u) => u.phone === normalizedPhone || phoneToAuthEmail(u.phone) === loginEmail);
          if (existingUser) {
            return reply(400, { error: 'رقم الهاتف هذا مسجل بالفعل لعضو آخر' });
          }

          const trimmedPassword = String(password).trim();
          if (trimmedPassword.length < MIN_PASSWORD_LENGTH) {
            return reply(400, { error: `يجب ألا تقل كلمة المرور عن ${MIN_PASSWORD_LENGTH} خانات` });
          }

          const newUser: User = {
            id: '',
            name: String(name).trim(),
            phone: normalizedPhone,
            role: role === 'admin' ? 'admin' : 'member',
            is_active: true,
            created_at: new Date().toISOString(),
          };

          createdAuthId = await auth.createUser({ email: loginEmail, password: trimmedPassword, fullName: newUser.name });
          newUser.id = createdAuthId;
          await store.insertProfile(tx, db, {
            id: newUser.id,
            name: newUser.name,
            phone: newUser.phone,
            role: newUser.role,
            createdAt: newUser.created_at,
            actorId: admin.id,
          });

          return reply(201, { user: newUser, message: 'تمت إضافة العضو بنجاح' });
        });
      } catch (err) {
        // The profile was not committed: remove the just-created login so no orphan identity remains.
        if (createdAuthId) await auth.deleteUser(createdAuthId).catch((e) => console.error('[Auth cleanup error]', e.message));
        if (isUniqueViolation(err, 'profiles_phone_key')) {
          return reply(400, { error: 'رقم الهاتف هذا مسجل بالفعل لعضو آخر' });
        }
        throw err;
      }
    })
  );

  // Update member (Admin only)
  app.patch(
    '/api/admin/members/:id',
    route('فشل تحديث بيانات العضو في قاعدة البيانات السحابية. لم يتم حفظ التعديلات، يرجى المحاولة مرة أخرى.', async (req) => {
      const adminId = await getAuthUserId(req);
      if (!adminId) return NOT_ADMIN;
      const { id } = req.params;
      const { name, phone, password, role, is_active } = req.body;

      return writeTransaction(async (tx, db) => {
        const admin = findUser(db, adminId);
        if (!admin || admin.role !== 'admin') return NOT_ADMIN;

        const user = db.users.find((u) => u.id === id);
        if (!user) {
          return reply(404, { error: 'العضو غير موجود' });
        }

        const updates: Partial<User> = {};
        let newPassword: string | null = null;

        if (name) {
          updates.name = String(name).trim();
        }
        if (phone) {
          const norm = String(phone).trim();
          const conflict = db.users.find(
            (u) => (u.phone === norm || phoneToAuthEmail(u.phone) === phoneToAuthEmail(norm)) && u.id !== id
          );
          if (conflict) return reply(400, { error: 'رقم الهاتف مستخدم لعضو آخر' });
          updates.phone = norm;
        }
        if (password) {
          const trimmedPassword = String(password).trim();
          if (trimmedPassword) {
            if (trimmedPassword.length < MIN_PASSWORD_LENGTH) {
              return reply(400, { error: `يجب ألا تقل كلمة المرور عن ${MIN_PASSWORD_LENGTH} خانات` });
            }
            newPassword = trimmedPassword;
          }
        }
        if (role && (role === 'member' || role === 'admin')) {
          updates.role = role;
        }
        if (typeof is_active === 'boolean') {
          updates.is_active = is_active;
        }

        await store.updateProfile(tx, db, id, updates);
        const emailChanged = updates.phone !== undefined && phoneToAuthEmail(updates.phone) !== phoneToAuthEmail(user.phone);
        if (emailChanged || newPassword || updates.name) {
          // Inside the transaction: if Supabase Auth rejects the change, the profile update rolls back.
          await auth.updateUser(id, {
            ...(emailChanged ? { email: phoneToAuthEmail(updates.phone as string) } : {}),
            ...(newPassword ? { password: newPassword } : {}),
            ...(updates.name ? { fullName: updates.name } : {}),
          });
        }
        if (newPassword) {
          // As before, a password reset invalidates the member's existing sessions.
          await store.revokeSessions(tx, id);
          auth.forget(id);
        }

        return reply(200, { user: { ...user, ...updates }, message: 'تم تحديث بيانات العضو بنجاح' });
      });
    })
  );

  // Admin: Delete member completely and permanently with all their recitation and revision logs
  app.delete(
    '/api/admin/members/:id/completely',
    route('فشل حذف العضو وسجلاته من قاعدة البيانات السحابية. لم يتم حذف العضو، يرجى المحاولة مرة أخرى.', async (req) => {
      const adminId = await getAuthUserId(req);
      if (!adminId) return NOT_ADMIN;
      const { id } = req.params;

      const result = await writeTransaction(async (tx, db) => {
        const admin = findUser(db, adminId);
        if (!admin || admin.role !== 'admin') return NOT_ADMIN;

        const user = db.users.find((u) => u.id === id);
        if (!user) {
          return reply(404, { error: 'العضو غير موجود' });
        }

        if (user.role === 'admin') {
          return reply(400, { error: 'لا يمكن حذف حساب المشرف' });
        }

        const counts = await store.deleteMemberCompletely(tx, id);
        return reply(200, {
          success: true,
          message: `تم حذف العضو "${user.name}" نهائيًا ومسح كافة سجلات التسميع (${counts.recitations}) وسجلات المراجعة (${counts.revisions}) الخاصة به.`,
        });
      });

      if (result.status === 200) {
        // After commit (the auth row is referenced by the profile until then).
        await auth.deleteUser(id).catch((e) =>
          console.error(`[Auth delete error] profile ${id} removed but its login identity remains: ${e.message}`)
        );
      }
      return result;
    })
  );

  // Rest Days: Add (Admin only)
  app.post(
    '/api/admin/rest-days',
    route('فشل حفظ يوم الاستدراك والراحة في قاعدة البيانات السحابية. لم يتم الحفظ، يرجى المحاولة ثانية.', async (req) => {
      const adminId = await getAuthUserId(req);
      if (!adminId) return NOT_ADMIN;
      const { date, note } = req.body;

      return writeTransaction(async (tx, db) => {
        const admin = findUser(db, adminId);
        if (!admin || admin.role !== 'admin') return NOT_ADMIN;

        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return reply(400, { error: 'يرجى تحديد تاريخ صحيح ليوم الاستدراك والراحة (YYYY-MM-DD)' });
        }

        const existing = db.restDays.find((rd) => rd.date === date);
        if (existing) {
          return reply(400, { error: 'هذا التاريخ مسجل بالفعل كيوم استدراك وراحة' });
        }

        const newRestDay: RestDay = await store.insertRestDay(tx, db, {
          date,
          note: note ? String(note).trim() : 'يوم استدراك وراحة للمجموعة',
          adminId: admin.id,
          adminName: admin.name,
          createdAt: new Date().toISOString(),
        });

        return reply(201, { restDay: newRestDay, message: 'تمت إضافة يوم الاستدراك والراحة بنجاح' });
      });
    })
  );

  // Rest Days: Delete (Admin only)
  app.delete(
    '/api/admin/rest-days/:id',
    route('فشل حذف يوم الاستدراك من قاعدة البيانات السحابية. لم يتم الحذف، يرجى المحاولة ثانية.', async (req) => {
      const adminId = await getAuthUserId(req);
      if (!adminId) return NOT_ADMIN;
      const { id } = req.params;

      return writeTransaction(async (tx, db) => {
        const admin = findUser(db, adminId);
        if (!admin || admin.role !== 'admin') return NOT_ADMIN;

        if (!isUuid(id) || !(await store.deleteRestDay(tx, db, id))) {
          return reply(404, { error: 'يوم الاستدراك غير موجود' });
        }
        return reply(200, { success: true, message: 'تم حذف يوم الاستدراك والراحة' });
      });
    })
  );

  // Pause the program (Admin only)
  app.post(
    '/api/admin/pause',
    route('فشل حفظ تفعيل الإيقاف المؤقت في قاعدة البيانات السحابية. يرجى المحاولة ثانية.', async (req) => {
      const adminId = await getAuthUserId(req);
      if (!adminId) return NOT_ADMIN;
      const todayStr = getTodayDate(req);

      return writeTransaction(async (tx, db) => {
        const admin = findUser(db, adminId);
        if (!admin || admin.role !== 'admin') return NOT_ADMIN;

        if (db.settings.is_paused) {
          return reply(200, { settings: db.settings, message: 'البرنامج متوقف مؤقتًا بالفعل.' });
        }

        await store.openPause(tx, db, todayStr, admin.id);
        const after = await store.loadState(tx);

        const cycleInfo = calculateCycleInfo(after.settings, after.restDays, todayStr);
        return reply(200, {
          settings: after.settings,
          cycleInfo,
          message: 'تم تفعيل الإيقاف المؤقت للبرنامج وتجميد عداد الدورة لجميع الأعضاء بنجاح.',
        });
      });
    })
  );

  // Resume the program (Admin only)
  app.post(
    '/api/admin/resume',
    route('فشل حفظ استئناف البرنامج في قاعدة البيانات السحابية. يرجى المحاولة ثانية.', async (req) => {
      const adminId = await getAuthUserId(req);
      if (!adminId) return NOT_ADMIN;
      const todayStr = getTodayDate(req);

      return writeTransaction(async (tx, db) => {
        const admin = findUser(db, adminId);
        if (!admin || admin.role !== 'admin') return NOT_ADMIN;

        if (!db.settings.is_paused) {
          return reply(200, { settings: db.settings, message: 'البرنامج غير متوقف حاليًا.' });
        }

        // Close the pause as a dated period: paused_at .. the day BEFORE resuming (the resume day is active).
        await store.closePause(tx, db, todayStr);
        const after = await store.loadState(tx);

        const cycleInfo = calculateCycleInfo(after.settings, after.restDays, todayStr);
        return reply(200, {
          settings: after.settings,
          cycleInfo,
          message: 'تم استئناف البرنامج بنجاح ومواصلة الدورة.',
        });
      });
    })
  );

  // Record a past pause period whose dates were not stored (Admin only).
  // Moves `days` out of the legacy total_paused_days counter into a dated period. Never touches member logs.
  app.post(
    '/api/admin/pause-periods',
    route('فشل حفظ فترة الإيقاف. حاول مرة أخرى.', async (req) => {
      const adminId = await getAuthUserId(req);
      if (!adminId) return NOT_ADMIN;
      const { from, to } = req.body || {};

      return writeTransaction(async (tx, db) => {
        const admin = findUser(db, adminId);
        if (!admin || admin.role !== 'admin') return NOT_ADMIN;

        const re = /^\d{4}-\d{2}-\d{2}$/;
        if (!re.test(from || '') || !re.test(to || '') || to < from) {
          return reply(400, { error: 'تواريخ الإيقاف غير صالحة (من/إلى).' });
        }
        const days = getCalendarDaysElapsed(from, to);
        await store.addPastPausePeriod(tx, db, from, to, days, admin.id);
        const after = await store.loadState(tx);
        return reply(200, { settings: after.settings, message: 'تم تسجيل فترة الإيقاف.' });
      });
    })
  );

  // One-time admin backfill: record missing daily revisions for all active members up to `until` (inclusive).
  // Only ADDS missing logs; never edits or deletes existing data. Idempotent.
  app.post(
    '/api/admin/backfill-revisions',
    route('تعذر حفظ السجلات الناقصة. أعد المحاولة (آمنة ولا تكرر).', async (req) => {
      const adminId = await getAuthUserId(req);
      if (!adminId) return NOT_ADMIN;
      const { until } = req.body || {};
      const todayDate = getTodayDate(req);

      return writeTransaction(async (tx, db) => {
        const admin = findUser(db, adminId);
        if (!admin || admin.role !== 'admin') return NOT_ADMIN;

        if (!/^\d{4}-\d{2}-\d{2}$/.test(until || '') || until > todayDate) {
          return reply(400, { error: 'تاريخ النهاية غير صالح.' });
        }
        const startDate = db.settings.start_date;
        if (!startDate || until < startDate) {
          return reply(400, { error: 'تاريخ النهاية يسبق بداية البرنامج.' });
        }

        const existing = new Set(db.revisionLogs.map((r) => `${r.member_id}|${r.date}`));
        const members = db.users.filter((u) => u.role === 'member' && u.is_active);
        const msPerDay = 86400000;
        const startMs = new Date(startDate + 'T00:00:00Z').getTime();
        const endMs = new Date(until + 'T00:00:00Z').getTime();
        let created = 0;
        for (let t = startMs; t <= endMs; t += msPerDay) {
          const dStr = new Date(t).toISOString().slice(0, 10);
          const info = calculateCycleInfo(db.settings, db.restDays, dStr);
          if (!info.has_started) continue;
          for (const m of members) {
            if (existing.has(`${m.id}|${dStr}`)) continue;
            const inserted = await store.insertRevision(tx, db, {
              memberId: m.id,
              memberName: m.name,
              date: dStr,
              start: info.review_start,
              end: info.review_end,
              notes: 'تسجيل إداري: تعذّر حفظ المراجعة بسبب خلل تقني',
              createdAt: new Date().toISOString(),
            });
            if (inserted) created++;
          }
        }
        return reply(200, { created, members: members.length, until, message: `تمت إضافة ${created} سجل مراجعة ناقص حتى ${until}.` });
      });
    })
  );

  // Update Settings: start_date (Admin only)
  app.put(
    '/api/admin/settings',
    route('فشل حفظ إعدادات المجموعة في قاعدة البيانات السحابية. يرجى المحاولة ثانية.', async (req) => {
      const adminId = await getAuthUserId(req);
      if (!adminId) return NOT_ADMIN;
      const { start_date } = req.body;

      return writeTransaction(async (tx, db) => {
        const admin = findUser(db, adminId);
        if (!admin || admin.role !== 'admin') return NOT_ADMIN;

        if (start_date && /^\d{4}-\d{2}-\d{2}$/.test(start_date)) {
          await store.updateStartDate(tx, db, start_date);
        }
        const after = await store.loadState(tx);
        return reply(200, { settings: after.settings, message: 'تم تحديث إعدادات المجموعة بنجاح' });
      });
    })
  );

  // Update Daily Thought (Admin only)
  app.put(
    '/api/admin/daily-thought',
    route('فشل حفظ ونشر خاطرة اليوم في قاعدة البيانات السحابية. يرجى المحاولة ثانية.', async (req) => {
      const adminId = await getAuthUserId(req);
      if (!adminId) return NOT_ADMIN;
      const { daily_thought } = req.body;

      return writeTransaction(async (tx, db) => {
        const admin = findUser(db, adminId);
        if (!admin || admin.role !== 'admin') return NOT_ADMIN;

        const clean = sanitizeThoughtServer(daily_thought || '');
        if (clean) {
          await store.publishDailyThought(tx, db, {
            html: clean,
            adminId: admin.id,
            adminName: admin.name,
            publishedAt: new Date().toISOString(),
          });
        } else {
          // Saving an empty thought hides it, as the previous empty value did.
          await store.unpublishDailyThoughts(tx, db);
        }
        const after = await store.loadState(tx);

        return reply(200, {
          settings: after.settings,
          message: 'تم حفظ ونشر خاطرة اليوم بنجاح لجميع الأعضاء',
        });
      });
    })
  );

  // Delete Daily Thought (Admin only)
  app.delete(
    '/api/admin/daily-thought',
    route('فشل حذف خاطرة اليوم من قاعدة البيانات السحابية. يرجى المحاولة ثانية.', async (req) => {
      const adminId = await getAuthUserId(req);
      if (!adminId) return NOT_ADMIN;

      return writeTransaction(async (tx, db) => {
        const admin = findUser(db, adminId);
        if (!admin || admin.role !== 'admin') return NOT_ADMIN;

        await store.unpublishDailyThoughts(tx, db);
        const after = await store.loadState(tx);

        return reply(200, {
          settings: after.settings,
          message: 'تم حذف خاطرة اليوم بالكامل ولن تظهر في لوحة الأعضاء',
        });
      });
    })
  );

  // Factory Reset (Admin only)
  app.post(
    '/api/admin/factory-reset',
    route('فشل تنفيذ إعادة ضبط المصنع في قاعدة البيانات السحابية. يرجى المحاولة ثانية.', async (req) => {
      const adminId = await getAuthUserId(req);
      if (!adminId) return NOT_ADMIN;
      const todayStr = getTodayDate(req);

      return writeTransaction(async (tx, db) => {
        const admin = findUser(db, adminId);
        if (!admin || admin.role !== 'admin') return NOT_ADMIN;

        await store.factoryReset(tx, db, todayStr);
        const after = await store.loadState(tx);
        const cycleInfo = calculateCycleInfo(after.settings, after.restDays, todayStr);

        return reply(200, {
          success: true,
          message: 'تمت إعادة ضبط المصنع ومسح جميع السجلات نهائيًا بنجاح. عادت الدورة إلى اليوم الأول (الربع رقم 1) ورقم الدورة 1.',
          cycleInfo,
          settings: after.settings,
        });
      });
    })
  );

  // Simplified Admin Statistics
  app.get(
    '/api/admin/stats',
    route('تعذر جلب الإحصائيات', async (req) => {
      const adminId = await getAuthUserId(req);
      if (!adminId) return NOT_ADMIN;
      const db = await readState();
      const admin = findUser(db, adminId);
      if (!admin || admin.role !== 'admin') return NOT_ADMIN;

      const todayStr = getTodayDate(req);
      const cycleInfo = calculateCycleInfo(db.settings, db.restDays, todayStr);
      const members = db.users.filter((u) => u.role === 'member' && u.is_active);

      const memberStats = members.map((m) => {
        const todayRecitation = db.recitationLogs.find(
          (r) => (r.member_id === m.id || r.reciter_id === m.id) && r.date === todayStr
        );

        const todayRevision = db.revisionLogs.find((r) => r.member_id === m.id && r.date === todayStr);

        const totalRecitations = db.recitationLogs.filter((r) => r.member_id === m.id || r.reciter_id === m.id).length;

        const totalRevisions = db.revisionLogs.filter((r) => r.member_id === m.id).length;

        const quarterStatus = calculateMemberRequiredQuarter(m.id, cycleInfo.quarter_of_day, db.recitationLogs);

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

      return reply(200, {
        total_members: members.length,
        completed_recitation_count: memberStats.filter((m) => m.has_recited_today).length,
        completed_revision_count: memberStats.filter((m) => m.has_reviewed_today).length,
        pending_recitation_today: pendingRecitationToday,
        pending_revision_today: pendingRevisionToday,
        behind_members_count: behindMembers.length,
        member_stats: memberStats,
      });
    })
  );

  // ==================== PERSONAL SELF-TESTS (اختبر نفسك) ====================
  const personalTestStore: PersonalTestStore = {
    listByMember: (memberId) => store.listPersonalTests(db, memberId),
    add: (record) => db.transaction((tx) => store.insertPersonalTest(tx, record)),
    remove: async (memberId, id) => (isUuid(id) ? store.deletePersonalTest(db, memberId, id) : false),
  };
  registerPersonalTestRoutes(app, {
    getAuthUser: async (req) => {
      const userId = await getAuthUserId(req);
      return userId ? store.loadUser(db, userId) : null;
    },
    getTodayDate,
    store: personalTestStore,
  });

  // ==================== PEER TESTING (الاختبارات المتبادلة) ====================

  /**
   * Unified candidate eligibility calculation.
   * Used identically in /api/tests/:id/eligible-candidates and POST /api/tests/attempts.
   */
  function computeCandidateStatus(
    db: AppState,
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
    const attempts = (db.testAttempts || []).filter((a) => a.test_id === test.id && a.candidate_id === member.id);
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
    const memberLogs = (db.recitationLogs || []).filter((l) => l.member_id === member.id || l.reciter_id === member.id);
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
      const activeCycleDates = getActiveCycleDates(db.settings.start_date, todayStr, db.restDays, db.settings);
      const revisionStatus = calculateMemberRevisionStatus(member.id, activeCycleDates, db.revisionLogs, todayStr);
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
  app.get(
    '/api/tests',
    route('تعذر جلب الاختبارات', async (req) => {
      const userId = await getAuthUserId(req);
      if (!userId) return NOT_SIGNED_IN;
      const db = await readState();
      const user = findUser(db, userId);
      if (!user) return NOT_SIGNED_IN;

      const allTests = db.tests || [];
      const rawActiveTest = allTests.find((t) => t.is_active && !t.is_finished) || null;
      const isAdmin = user.role === 'admin';
      const activeTest = rawActiveTest && (isAdmin || isInTestAudience(rawActiveTest, user.id)) ? rawActiveTest : null;

      return reply(200, {
        tests: isAdmin ? allTests : activeTest ? [activeTest] : [],
        activeTest,
      });
    })
  );

  // 2. Admin: Preview questions for any test (without saving)
  app.get(
    '/api/admin/tests/:id/preview-questions',
    route('تعذر توليد الأسئلة', async (req) => {
      const adminId = await getAuthUserId(req);
      if (!adminId) return NOT_ADMIN;
      const db = await readState();
      const admin = findUser(db, adminId);
      if (!admin || admin.role !== 'admin') return NOT_ADMIN;

      const { id } = req.params;
      const test = (db.tests || []).find((t) => t.id === id);
      if (!test) {
        return reply(404, { error: 'الاختبار غير موجود' });
      }

      const questions = generateTestQuestions(
        test.range_start,
        test.range_end,
        test.questions_count,
        test.lines_per_question,
        test.difficulty || 'any'
      );

      if (questions.length < test.questions_count) {
        return reply(422, { error: 'النطاق لا يتسع لهذا العدد من الأسئلة بهذا الطول' });
      }

      return reply(200, { test_id: test.id, questions });
    })
  );

  // 2b. Admin: Test Impact analysis before activation (التحقق من عدد الأعضاء الممنوعين فوراً)
  app.get(
    '/api/admin/tests/:id/impact',
    route('تعذر حساب أثر الاختبار', async (req) => {
      const adminId = await getAuthUserId(req);
      if (!adminId) return NOT_ADMIN;
      const db = await readState();
      const admin = findUser(db, adminId);
      if (!admin || admin.role !== 'admin') return NOT_ADMIN;

      const { id } = req.params;
      const test = (db.tests || []).find((t) => t.id === id);
      if (!test) {
        return reply(404, { error: 'الاختبار غير موجود' });
      }

      const todayStr = getTodayDate(req);
      const cycleInfo = calculateCycleInfo(db.settings, db.restDays, todayStr);

      // Active members in test audience
      const audienceMembers = db.users.filter((u) => u.role === 'member' && u.is_active && isInTestAudience(test, u.id));

      const blockedMembers = audienceMembers.filter((m) => {
        // Has completed recitation past range_end
        const quarterStatus = calculateMemberRequiredQuarter(m.id, cycleInfo.quarter_of_day, db.recitationLogs);
        const isPastRange = quarterStatus.requiredQuarter > test.range_end;
        if (!isPastRange) return false;

        // Has not passed this test fully
        const hasPassed = (db.testAttempts || []).some(
          (a) => a.test_id === test.id && a.candidate_id === m.id && a.passed && a.covers_full_range !== false
        );
        return !hasPassed;
      });

      return reply(200, {
        test_id: test.id,
        test_type: test.test_type,
        range_start: test.range_start,
        range_end: test.range_end,
        blocked_count: blockedMembers.length,
        blocked_members: blockedMembers.map((m) => ({ id: m.id, name: m.name })),
      });
    })
  );

  // 3. Admin: Create or update test definition
  app.post(
    '/api/admin/tests',
    route('فشل حفظ الاختبار في قاعدة البيانات السحابية. لم يتم حفظ الاختبار، يرجى المحاولة ثانية.', async (req) => {
      const adminId = await getAuthUserId(req);
      if (!adminId) return NOT_ADMIN;
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

      return writeTransaction(async (tx, db) => {
        const admin = findUser(db, adminId);
        if (!admin || admin.role !== 'admin') return NOT_ADMIN;

        // Strict integer validation using parseStrictInteger
        const rStart = parseStrictInteger(range_start);
        const rEnd = parseStrictInteger(range_end);
        const qCount = parseStrictInteger(questions_count);
        const lPerQ = parseStrictInteger(lines_per_question);

        if (rStart === null || rStart < 1 || rStart > 240) {
          return reply(400, { error: 'بداية نطاق الاختبار يجب أن تكون عدداً صحيحاً بين 1 و 240' });
        }
        if (rEnd === null || rEnd < 1 || rEnd > 240) {
          return reply(400, { error: 'نهاية نطاق الاختبار يجب أن تكون عدداً صحيحاً بين 1 و 240' });
        }
        if (rStart > rEnd) {
          return reply(400, { error: 'بداية النطاق يجب أن تكون أقل من أو تساوي نهاية النطاق' });
        }
        if (qCount === null || qCount < 1 || qCount > 50) {
          return reply(400, { error: 'عدد الأسئلة يجب أن يكون عدداً صحيحاً بين 1 و 50' });
        }
        if (lPerQ === null || lPerQ < 1 || lPerQ > 60) {
          return reply(400, { error: 'عدد الأسطر لكل سؤال يجب أن يكون عدداً صحيحاً بين 1 و 60' });
        }

        // Capacity check using estimateRangeLines
        const totalRangeLines = estimateRangeLines(rStart, rEnd);
        if (qCount * lPerQ > 0.8 * totalRangeLines) {
          return reply(400, {
            error: 'النطاق لا يتسع لهذا العدد من الأسئلة بهذا الطول، قلّل العدد أو الأسطر أو وسّع النطاق',
          });
        }

        // Title validation (a blank title falls back to the default, as the database requires a title)
        const trimmedTitle = title ? String(title).trim().slice(0, 120) : '';
        const cleanTitle = trimmedTitle || `اختبار الأرباع (${rStart} - ${rEnd})`;

        // Max errors validation
        const hasMax = !!has_max_errors;
        let maxErr: number | undefined = undefined;
        if (hasMax) {
          const parsedMax = parseStrictInteger(max_errors_allowed);
          if (parsedMax === null || parsedMax < 0 || parsedMax > 100) {
            return reply(400, { error: 'الحد الأقصى للأخطاء يجب أن يكون عدداً صحيحاً بين 0 و 100' });
          }
          maxErr = parsedMax;
        }

        const tType = test_type === 'mandatory' ? 'mandatory' : 'recommended';
        const shouldBeActive = is_active !== undefined ? !!is_active : true;
        const targetAudience: 'all' | 'selected' = audience === 'all' ? 'all' : 'selected';
        const selectedMembers: string[] = Array.isArray(selected_member_ids)
          ? [...new Set<string>(selected_member_ids.map(String).filter(Boolean))]
          : [];

        // Reject selected audience if member list is empty
        if (targetAudience === 'selected' && selectedMembers.length === 0) {
          return reply(400, {
            error: 'يرجى تحديد عضو واحد على الأقل في قائمة الأعضاء المختارين، أو اختيار (كل الأعضاء)',
          });
        }
        if (selectedMembers.some((m) => !db.users.some((u) => u.id === m))) {
          return reply(400, { error: 'قائمة الأعضاء المختارين تحتوي على عضو غير موجود' });
        }

        // Validate difficulty from 5 allowed values
        const validDifficulties = ['any', 'easy', 'medium', 'hard', 'mixed'] as const;
        const testDiff: 'any' | 'easy' | 'medium' | 'hard' | 'mixed' = validDifficulties.includes(difficulty)
          ? difficulty
          : 'any';

        const nowStr = new Date().toISOString();
        const existingTest = id ? db.tests.find((t) => t.id === id) || null : null;

        if (existingTest?.is_finished) {
          return reply(400, {
            error: 'هذا الاختبار منتهٍ نهائيًا ولا يمكن إعادة تفعيله، أنشئ اختبارًا جديدًا',
          });
        }

        // Check if test has prior attempts
        const hasAttempts = existingTest ? (db.testAttempts || []).some((a) => a.test_id === existingTest.id) : false;

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

        const isNew = createNewDueToMaterialChange || !existingTest;
        const targetTestId = isNew ? crypto.randomUUID() : existingTest!.id;

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
          created_at: isNew ? nowStr : existingTest!.created_at,
          created_by_admin_id: admin.id,
          updated_at: nowStr,
        };

        // One transaction: archive the previous version, keep a single active test, save this one.
        if (createNewDueToMaterialChange && existingTest) {
          await store.setTestStatus(tx, db, existingTest.id, 'hidden', nowStr);
        }
        if (shouldBeActive) {
          await store.hideOtherPublishedTests(tx, db, targetTestId, nowStr);
        }
        await store.saveTest(tx, db, testDoc, isNew);

        return reply(200, {
          success: true,
          message: createNewDueToMaterialChange
            ? 'نظراً لوجود محاولات سابقة، تم حفظ التعديلات كاختبار جديد وأرشفة الاختبار السابق لحفظ سجل النتائج.'
            : 'تم حفظ الاختبار بنجاح.',
          test: testDoc,
        });
      });
    })
  );

  // 4. Admin: Toggle active status of a test
  app.patch(
    '/api/admin/tests/:id/status',
    route('فشل تعديل حالة الاختبار في قاعدة البيانات السحابية. يرجى المحاولة ثانية.', async (req) => {
      const adminId = await getAuthUserId(req);
      if (!adminId) return NOT_ADMIN;
      const { id } = req.params;
      const { is_active } = req.body;

      return writeTransaction(async (tx, db) => {
        const admin = findUser(db, adminId);
        if (!admin || admin.role !== 'admin') return NOT_ADMIN;

        const test = db.tests.find((t) => t.id === id);
        if (!test) {
          return reply(404, { error: 'الاختبار غير موجود' });
        }

        if (test.is_finished) {
          return reply(400, {
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
          return reply(400, {
            error: 'لا يمكن تفعيل اختبار مخصص لأعضاء مختارين دون تحديد أي عضو في قائمته',
          });
        }

        const nowStr = new Date().toISOString();
        if (nextActive) {
          await store.hideOtherPublishedTests(tx, db, id, nowStr);
        }
        await store.setTestStatus(tx, db, id, nextActive ? 'published' : 'hidden', nowStr);

        return reply(200, {
          success: true,
          message: nextActive ? 'تم تفعيل الاختبار بنجاح' : 'تم إيقاف الاختبار بنجاح',
          test: { ...test, is_active: nextActive, updated_at: nowStr },
        });
      });
    })
  );

  // Admin: Finish test permanently (إنهاء الاختبار نهائيًا)
  app.post(
    '/api/admin/tests/:id/finish',
    route('فشل إنهاء الاختبار في قاعدة البيانات السحابية. يرجى المحاولة ثانية.', async (req) => {
      const adminId = await getAuthUserId(req);
      if (!adminId) return NOT_ADMIN;
      const { id } = req.params;

      return writeTransaction(async (tx, db) => {
        const admin = findUser(db, adminId);
        if (!admin || admin.role !== 'admin') return NOT_ADMIN;

        const test = db.tests.find((t) => t.id === id);
        if (!test) {
          return reply(404, { error: 'الاختبار غير موجود' });
        }

        if (test.is_finished) {
          return reply(400, { error: 'هذا الاختبار منتهٍ بالفعل ولا يمكن إنهاؤه مجدداً' });
        }

        const nowStr = new Date().toISOString();
        await store.setTestStatus(tx, db, id, 'finished', nowStr);

        return reply(200, {
          success: true,
          message: 'تم إنهاء الاختبار نهائيًا بنجاح',
          test: { ...test, is_active: false, is_finished: true, finished_at: nowStr, updated_at: nowStr },
        });
      });
    })
  );

  // 5. Eligible candidates for the active test
  app.get(
    '/api/tests/:id/eligible-candidates',
    route('تعذر جلب قائمة المرشحين', async (req) => {
      const userId = await getAuthUserId(req);
      if (!userId) return NOT_SIGNED_IN;
      const db = await readState();
      const user = findUser(db, userId);
      if (!user) return NOT_SIGNED_IN;

      const { id } = req.params;
      const test = (db.tests || []).find((t) => t.id === id);
      if (!test) {
        return reply(404, { error: 'الاختبار غير موجود' });
      }

      // Examiner must be member, active, and in audience
      const isAdmin = user.role === 'admin';
      if (!isAdmin) {
        if (user.role !== 'member' || !user.is_active || !isInTestAudience(test, user.id)) {
          return reply(403, { error: 'لست ضمن قائمة الأعضاء المخولين بالمشاركة في هذا الاختبار' });
        }
      }

      const todayStr = getTodayDate(req);

      // Eligible peers: active members in test audience (and not the tester themselves)
      const candidatePool = db.users.filter(
        (u) => u.role === 'member' && u.is_active && u.id !== user.id && isInTestAudience(test, u.id)
      );

      const eligibleCandidates = candidatePool.map((m) => {
        const status = computeCandidateStatus(db, test, m, todayStr);
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

      return reply(200, { test, candidates: eligibleCandidates });
    })
  );

  // 6. Generate test questions for an active test session
  app.get(
    '/api/tests/:id/generate-questions',
    route('تعذر توليد الأسئلة', async (req) => {
      const userId = await getAuthUserId(req);
      if (!userId) return NOT_SIGNED_IN;
      const db = await readState();
      const user = findUser(db, userId);
      if (!user) return NOT_SIGNED_IN;

      const { id } = req.params;
      const test = (db.tests || []).find((t) => t.id === id);
      if (!test) {
        return reply(404, { error: 'الاختبار غير موجود' });
      }

      const isAdmin = user.role === 'admin';
      if (!isAdmin && (!user.is_active || user.role !== 'member' || !isInTestAudience(test, user.id))) {
        return reply(403, { error: 'لست ضمن قائمة الأعضاء المخولين بالمشاركة في هذا الاختبار' });
      }

      const todayStr = getTodayDate(req);
      const candidateId = typeof req.query.candidate_id === 'string' ? req.query.candidate_id : undefined;

      let effectiveRangeEnd = test.range_end;

      if (candidateId) {
        const candidate = db.users.find((u) => u.id === candidateId && u.is_active);
        if (!candidate) {
          return reply(404, { error: 'العضو المختبَر غير موجود' });
        }
        const status = computeCandidateStatus(db, test, candidate, todayStr);
        if (!status.is_eligible) {
          return reply(400, { error: `العضو غير مؤهل للاختبار: ${status.reasons.join('، ')}` });
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
        return reply(422, { error: 'النطاق لا يتسع لهذا العدد من الأسئلة بهذا الطول' });
      }

      return reply(200, { test_id: test.id, effective_range_end: effectiveRangeEnd, questions });
    })
  );

  // 7. Record a completed test attempt (peer testing submission)
  app.post(
    '/api/tests/attempts',
    route('فشل حفظ نتيجة الاختبار في قاعدة البيانات السحابية. لم يتم حفظ النتيجة، يرجى المحاولة ثانية.', async (req) => {
      const examinerId = await getAuthUserId(req);
      if (!examinerId) return NOT_SIGNED_IN;
      const { test_id, candidate_id, questions_results, notes } = req.body;

      return writeTransaction(async (tx, db) => {
        const examiner = findUser(db, examinerId);
        if (!examiner) return NOT_SIGNED_IN;

        if (!test_id || !candidate_id) {
          return reply(400, { error: 'يرجى تحديد الاختبار والعضو المُختبَر' });
        }

        const test = (db.tests || []).find((t) => t.id === test_id);
        if (!test) {
          return reply(404, { error: 'الاختبار غير موجود' });
        }
        if (!test.is_active) {
          return reply(400, { error: 'هذا الاختبار غير مفعّل حالياً' });
        }

        // Examiner validation
        if (examiner.role !== 'member' || !examiner.is_active) {
          return reply(403, { error: 'يجب أن يكون المُختبِر عضواً نشطاً في المقرأة' });
        }
        if (!isInTestAudience(test, examiner.id)) {
          return reply(403, { error: 'أنت لست ضمن قائمة الأعضاء المخولين بإجراء هذا الاختبار' });
        }

        // Cannot test oneself
        if (examiner.id === candidate_id) {
          return reply(400, { error: 'لا يمكن للعضو اختبار نفسه؛ يجب أن يختبرك زميل في المقرأة' });
        }

        // Candidate validation
        const candidate = db.users.find((u) => u.id === candidate_id);
        if (!candidate || candidate.role !== 'member' || !candidate.is_active) {
          return reply(404, { error: 'العضو المُختبَر غير موجود أو حسابه غير نشط' });
        }
        if (!isInTestAudience(test, candidate.id)) {
          return reply(400, { error: 'العضو المُختبَر ليس ضمن قائمة الأعضاء المشمولين بهذا الاختبار' });
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
          return reply(429, {
            error: 'تم تسجيل محاولة لنفس العضو من قِبلك للتو! يرجى الانتظار دقيقة واحدة قبل تسجيل محاولة جديدة منعاً للتكرار.',
          });
        }

        const todayStr = getTodayDate(req);

        // Candidate eligibility check at submission time using unified function
        const candidateStatus = computeCandidateStatus(db, test, candidate, todayStr);
        if (candidateStatus.has_passed) {
          return reply(400, { error: 'العضو اجتاز هذا الاختبار بالفعل بنجاح ولا يحتاج لإعادته' });
        }
        if (!candidateStatus.is_eligible) {
          return reply(400, {
            error: `العضو غير مؤهل لخوض هذا الاختبار حالياً: ${candidateStatus.reasons.join('، ')}`,
          });
        }

        // Untrusted client validation for questions
        if (!Array.isArray(questions_results) || questions_results.length === 0) {
          return reply(400, { error: 'يجب إرسال بيانات أسئلة الاختبار' });
        }
        if (questions_results.length !== test.questions_count) {
          return reply(400, {
            error: `عدد الأسئلة المرسلة (${questions_results.length}) لا يطابق عدد أسئلة الاختبار المطلوب بالضبط (${test.questions_count})`,
          });
        }

        const effectiveRangeEnd = candidateStatus.effective_range_end;
        const minVerseIdx = getQuarterStartIndex(test.range_start);
        const maxVerseIdx = getQuarterEndIndex(effectiveRangeEnd);

        const verifiedQuestionsResults = [];
        const geometry: AttemptQuestionGeometry[] = [];
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
            return reply(400, { error: `بيانات السورة أو الآية غير صالحة في السؤال رقم ${i + 1}` });
          }

          const startIdx = getVerseIndexBySurahAyah(sSurah, sAyah);
          const endIdx = getVerseIndexBySurahAyah(eSurah, eAyah);

          if (startIdx === undefined || endIdx === undefined) {
            return reply(400, { error: `الآية المحددة غير موجودة في المصحف الشريف في السؤال رقم ${i + 1}` });
          }
          if (startIdx > endIdx) {
            return reply(400, { error: `بداية السؤال يجب أن تسبق نهايته في السؤال رقم ${i + 1}` });
          }
          if (startIdx < minVerseIdx || endIdx > maxVerseIdx) {
            return reply(400, {
              error: `السؤال رقم ${i + 1} يقع خارج نطاق أرباع الاختبار (${test.range_start} إلى ${effectiveRangeEnd})`,
            });
          }
          if (i > 0 && startIdx <= prevEndVerseIdx) {
            return reply(400, { error: `يوجد تداخل بين السؤال رقم ${i + 1} والسؤال السابق له` });
          }
          prevEndVerseIdx = endIdx;

          if (qErrors === null || qErrors < 0 || qErrors > 99) {
            return reply(400, { error: `عدد الأخطاء يجب أن يكون رقماً صحيحاً بين 0 و 99 في السؤال رقم ${i + 1}` });
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
            ...(cleanQNotes ? { notes: cleanQNotes } : {}),
          });
          // Mushaf geometry, computed exactly as the question generator does.
          geometry.push({
            start_page: startVerseObj.page,
            start_line: startVerseObj.line_start,
            end_page: endVerseObj.page_end,
            end_line: endVerseObj.line_end,
            actual_lines: getAbsoluteLineEnd(endVerseObj) - getAbsoluteLineStart(startVerseObj) + 1,
          });
        }

        // Calculate pass/fail strictly on server
        let passed = true;
        if (test.has_max_errors && typeof test.max_errors_allowed === 'number') {
          passed = calculatedTotalErrors <= test.max_errors_allowed;
        }

        const cleanOverallNotes = notes ? String(notes).trim().slice(0, 300) : undefined;

        const attemptDoc: TestAttempt = {
          id: '',
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
          ...(cleanOverallNotes ? { notes: cleanOverallNotes } : {}),
          created_at: new Date().toISOString(),
          effective_range_end: effectiveRangeEnd,
          covers_full_range: candidateStatus.covers_full_range,
        };

        const saved = await store.insertAttempt(
          tx,
          attemptDoc,
          test.has_max_errors && typeof test.max_errors_allowed === 'number' ? test.max_errors_allowed : null,
          geometry
        );

        return reply(200, {
          success: true,
          message: passed
            ? 'تم تسجيل الاختبار بنجاح واجتياز العضو للاختبار!'
            : 'تم تسجيل الاختبار (لم يجتز العضو بنجاح بسبب تجاوز حد الأخطاء المسموح).',
          attempt: saved,
        });
      });
    })
  );

  // 8. Get test attempts (with privacy filter: non-admins only see attempts they took part in)
  app.get(
    '/api/tests/attempts',
    route('تعذر جلب نتائج الاختبارات', async (req) => {
      const userId = await getAuthUserId(req);
      if (!userId) return NOT_SIGNED_IN;
      const db = await readState();
      const user = findUser(db, userId);
      if (!user) return NOT_SIGNED_IN;

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

      return reply(200, { attempts });
    })
  );

  return app;
}
