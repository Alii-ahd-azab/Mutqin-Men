import type { Express, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import {
  ALL_VERSES,
  ALL_QUARTERS,
  getSurahs,
  getJuzList,
  getQuarterStartIndex,
  getQuarterEndIndex,
  getVerseIndexBySurahAyah,
  generateQuestionsInVerseRange,
  TestDifficulty,
} from '../lib/testGenerator';

/**
 * Personal self-tests ("اختبر نفسك").
 * Completely separate from the program and from the admin's peer-testing system:
 *  - own tables `personal_tests` / `personal_test_questions`
 *  - every route only ever reads/writes the CALLING user's own records
 *  - nothing here is added to /api/bootstrap, no admin route reads these records
 *  - never blocks recitation/revision and never affects mandatory tests
 */

export interface PersonalTestRecord {
  id: string;
  member_id: string;
  range_type?: 'surah' | 'juz' | 'quarter';
  range_label?: string;
  start_juz?: number;
  end_juz?: number;
  start_quarter?: number;
  end_quarter?: number;
  start_surah: number;
  start_surah_name: string;
  end_surah: number;
  end_surah_name: string;
  questions_count: number;
  lines_per_question: number;
  difficulty: TestDifficulty;
  questions: {
    question_number: number;
    start_surah: number;
    start_surah_name: string;
    start_ayah: number;
    end_surah: number;
    end_surah_name: string;
    end_ayah: number;
    errors_count: number;
    grade: number; // 0..100
    difficulty_level?: 'easy' | 'medium' | 'hard';
  }[];
  total_errors: number;
  grade: number; // 0..100 (average of question grades)
  grade_label: string;
  notes?: string;
  date: string; // YYYY-MM-DD (user's local date)
  created_at: string;
}

export interface PersonalTestStore {
  listByMember(memberId: string): Promise<PersonalTestRecord[]>;
  add(record: PersonalTestRecord): Promise<void>;
  remove(memberId: string, id: string): Promise<boolean>;
}

/** Each error costs this many points from a question's 100 (never below 0). */
export const POINTS_PER_ERROR = 15;
const MAX_QUESTIONS = 30;
const MAX_LINES = 30;
const MAX_HISTORY = 100;
const DIFFICULTIES = ['any', 'easy', 'medium', 'hard', 'mixed'];

export function questionGrade(errors: number): number {
  return Math.max(0, 100 - errors * POINTS_PER_ERROR);
}
export function gradeLabel(g: number): string {
  if (g >= 90) return 'ممتاز';
  if (g >= 80) return 'جيد جدًا';
  if (g >= 65) return 'جيد';
  if (g >= 50) return 'مقبول';
  return 'يحتاج مراجعة';
}

function strictInt(v: unknown): number | null {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

interface Deps {
  getAuthUser: (req: Request) => Promise<{ id: string; name: string; is_active: boolean } | null>;
  getTodayDate: (req: Request) => string;
  store: PersonalTestStore;
}

interface ParsedSetup {
  range_type: 'surah' | 'juz' | 'quarter';
  lo: number;
  hi: number;
  sS: number;
  eS: number;
  sSName: string;
  eSName: string;
  start_juz?: number;
  end_juz?: number;
  start_quarter?: number;
  end_quarter?: number;
  range_label: string;
  count: number;
  lines: number;
  difficulty: TestDifficulty;
}

function parseSetup(body: any): { error: string } | ParsedSetup {
  const rangeType = (body?.range_type || 'surah') as 'surah' | 'juz' | 'quarter';
  const count = strictInt(body?.questions_count);
  const lines = strictInt(body?.lines_per_question);
  const difficulty = (body?.difficulty ?? 'any') as string;

  if (count === null || count < 1 || count > MAX_QUESTIONS) {
    return { error: `عدد الأسئلة يجب أن يكون رقمًا صحيحًا بين 1 و ${MAX_QUESTIONS}` };
  }
  if (lines === null || lines < 1 || lines > MAX_LINES) {
    return { error: `طول السؤال يجب أن يكون رقمًا صحيحًا بين 1 و ${MAX_LINES} سطرًا` };
  }
  if (!DIFFICULTIES.includes(difficulty)) {
    return { error: 'مستوى الصعوبة غير صالح' };
  }

  const surahs = getSurahs();

  if (rangeType === 'quarter') {
    const sQ = strictInt(body?.start_quarter);
    const eQ = strictInt(body?.end_quarter);
    if (sQ === null || eQ === null || sQ < 1 || eQ > 240 || sQ > eQ) {
      return { error: 'نطاق الأرباع غير صالح (يجب أن يكون ربع البداية بين 1 و 240 وقبل أو يساوي ربع النهاية)' };
    }
    const lo = getQuarterStartIndex(sQ);
    const hi = getQuarterEndIndex(eQ);
    const sV = ALL_VERSES[lo];
    const eV = ALL_VERSES[hi];
    const sS = sV.surah;
    const eS = eV.surah;
    const sSName = sV.surah_name;
    const eSName = eV.surah_name;
    const range_label =
      sQ === eQ ? `الربع ${sQ} (${sSName})` : `الأرباع ${sQ} ← ${eQ} (${sSName} إلى ${eSName})`;
    return {
      range_type: 'quarter',
      lo,
      hi,
      sS,
      eS,
      sSName,
      eSName,
      start_quarter: sQ,
      end_quarter: eQ,
      range_label,
      count,
      lines,
      difficulty: difficulty as TestDifficulty,
    };
  }

  if (rangeType === 'juz') {
    const sJ = strictInt(body?.start_juz);
    const eJ = strictInt(body?.end_juz);
    if (sJ === null || eJ === null || sJ < 1 || eJ > 30 || sJ > eJ) {
      return { error: 'نطاق الأجزاء غير صالح (يجب أن يكون جزء البداية بين 1 و 30 وقبل أو يساوي جزء النهاية)' };
    }
    const sQ = (sJ - 1) * 8 + 1;
    const eQ = eJ * 8;
    const lo = getQuarterStartIndex(sQ);
    const hi = getQuarterEndIndex(eQ);
    const sV = ALL_VERSES[lo];
    const eV = ALL_VERSES[hi];
    const sS = sV.surah;
    const eS = eV.surah;
    const sSName = sV.surah_name;
    const eSName = eV.surah_name;
    const range_label =
      sJ === eJ ? `الجزء ${sJ} (${sSName})` : `الأجزاء ${sJ} ← ${eJ} (${sSName} إلى ${eSName})`;
    return {
      range_type: 'juz',
      lo,
      hi,
      sS,
      eS,
      sSName,
      eSName,
      start_juz: sJ,
      end_juz: eJ,
      start_quarter: sQ,
      end_quarter: eQ,
      range_label,
      count,
      lines,
      difficulty: difficulty as TestDifficulty,
    };
  }

  // Default: 'surah'
  const sS = strictInt(body?.start_surah);
  const eS = strictInt(body?.end_surah);
  if (sS === null || eS === null || sS < 1 || eS > 114 || sS > eS) {
    return { error: 'نطاق السور غير صالح (يجب أن تكون سورة البداية قبل أو تساوي سورة النهاية)' };
  }
  const lo = surahs[sS - 1].first_idx;
  const hi = surahs[eS - 1].last_idx;
  const sSName = surahs[sS - 1].name;
  const eSName = surahs[eS - 1].name;
  const range_label = sS === eS ? `سورة ${sSName}` : `سورة ${sSName} ← سورة ${eSName}`;

  return {
    range_type: 'surah',
    lo,
    hi,
    sS,
    eS,
    sSName,
    eSName,
    range_label,
    count,
    lines,
    difficulty: difficulty as TestDifficulty,
  };
}

export function registerPersonalTestRoutes(app: Express, deps: Deps): void {
  const { getAuthUser, getTodayDate, store } = deps;

  const authed = async (req: Request, res: Response) => {
    let user: Awaited<ReturnType<Deps['getAuthUser']>>;
    try {
      user = await getAuthUser(req);
    } catch (e) {
      console.error('[Personal Test Auth Error]', e instanceof Error ? e.message : e);
      res.status(500).json({ error: 'تعذّر التحقق من الحساب، يرجى المحاولة مرة أخرى.' });
      return null;
    }
    if (!user) {
      res.status(401).json({ error: 'يجب تسجيل الدخول أولاً' });
      return null;
    }
    if (!user.is_active) {
      res.status(403).json({ error: 'حسابك مُعلّق حاليًا' });
      return null;
    }
    return user;
  };

  // Surah list for the range pickers (preserved for backwards compatibility)
  app.get('/api/personal-tests/surahs', async (req: Request, res: Response) => {
    if (!(await authed(req, res))) return;
    res.json({
      surahs: getSurahs().map((s) => ({ number: s.number, name: s.name, ayah_count: s.ayah_count })),
    });
  });

  // Full metadata for range pickers: Surahs, Juz (1..30), and Quarters (1..240)
  app.get('/api/personal-tests/meta', async (req: Request, res: Response) => {
    if (!(await authed(req, res))) return;
    res.json({
      surahs: getSurahs().map((s) => ({ number: s.number, name: s.name, ayah_count: s.ayah_count })),
      juzList: getJuzList(),
      quartersList: ALL_QUARTERS.map((q) => ({
        quarter: q.quarter,
        juz: q.juz,
        surahName: q.surahName,
        ayahNumber: q.ayahNumber,
        label: `الربع ${q.quarter} — سورة ${q.surahName} (${q.ayahNumber})`,
      })),
    });
  });

  // Generate questions (nothing is saved here)
  app.post('/api/personal-tests/generate', async (req: Request, res: Response) => {
    if (!(await authed(req, res))) return;
    const setup = parseSetup(req.body);
    if ('error' in setup) return res.status(400).json({ error: setup.error });

    const questions = generateQuestionsInVerseRange(setup.lo, setup.hi, setup.count, setup.lines, setup.difficulty);
    if (questions.length < setup.count) {
      return res.status(422).json({
        error: 'النطاق المختار لا يتسع لهذا العدد من الأسئلة بهذا الطول. وسّع النطاق أو قلّل عدد الأسئلة أو أسطر السؤال.',
      });
    }
    res.json({ questions, points_per_error: POINTS_PER_ERROR, range_label: setup.range_label });
  });

  // Save a finished personal test (grade is computed here, never trusted from the client)
  app.post('/api/personal-tests', async (req: Request, res: Response) => {
    const user = await authed(req, res);
    if (!user) return;
    const setup = parseSetup(req.body);
    if ('error' in setup) return res.status(400).json({ error: setup.error });

    const results = req.body?.questions_results;
    if (!Array.isArray(results) || results.length !== setup.count) {
      return res.status(400).json({ error: 'عدد الأسئلة المرسلة لا يطابق عدد أسئلة الاختبار' });
    }

    const questions: PersonalTestRecord['questions'] = [];
    let prevEnd = -1;
    let totalErrors = 0;
    for (let i = 0; i < results.length; i++) {
      const q = results[i];
      const sSurah = strictInt(q?.start_surah);
      const sAyah = strictInt(q?.start_ayah);
      const eSurah = strictInt(q?.end_surah);
      const eAyah = strictInt(q?.end_ayah);
      const errs = strictInt(q?.errors_count);
      if (sSurah === null || sAyah === null || eSurah === null || eAyah === null) {
        return res.status(400).json({ error: `بيانات السؤال ${i + 1} غير صالحة` });
      }
      const sIdx = getVerseIndexBySurahAyah(sSurah, sAyah);
      const eIdx = getVerseIndexBySurahAyah(eSurah, eAyah);
      if (sIdx === undefined || eIdx === undefined || sIdx > eIdx) {
        return res.status(400).json({ error: `حدود السؤال ${i + 1} غير صحيحة` });
      }
      if (sIdx < setup.lo || eIdx > setup.hi) {
        return res.status(400).json({ error: `السؤال ${i + 1} خارج نطاق الاختبار المختار` });
      }
      if (sIdx <= prevEnd) {
        return res.status(400).json({ error: `يوجد تداخل بين السؤال ${i + 1} والذي قبله` });
      }
      prevEnd = eIdx;
      if (errs === null || errs < 0 || errs > 99) {
        return res.status(400).json({ error: `عدد الأخطاء في السؤال ${i + 1} يجب أن يكون بين 0 و 99` });
      }
      totalErrors += errs;
      const sv = ALL_VERSES[sIdx];
      const ev = ALL_VERSES[eIdx];
      const lvl = q?.difficulty_level;
      questions.push({
        question_number: i + 1,
        start_surah: sv.surah,
        start_surah_name: sv.surah_name,
        start_ayah: sv.ayah,
        end_surah: ev.surah,
        end_surah_name: ev.surah_name,
        end_ayah: ev.ayah,
        errors_count: errs,
        grade: questionGrade(errs),
        ...(lvl === 'easy' || lvl === 'medium' || lvl === 'hard' ? { difficulty_level: lvl } : {}),
      });
    }

    const grade = Math.round(questions.reduce((a, q) => a + q.grade, 0) / questions.length);
    const notes = req.body?.notes ? String(req.body.notes).trim().slice(0, 300) : '';
    const record: PersonalTestRecord = {
      id: randomUUID(),
      member_id: user.id,
      range_type: setup.range_type,
      range_label: setup.range_label,
      start_surah: setup.sS,
      start_surah_name: setup.sSName,
      end_surah: setup.eS,
      end_surah_name: setup.eSName,
      ...(setup.start_juz !== undefined ? { start_juz: setup.start_juz, end_juz: setup.end_juz } : {}),
      ...(setup.start_quarter !== undefined ? { start_quarter: setup.start_quarter, end_quarter: setup.end_quarter } : {}),
      questions_count: setup.count,
      lines_per_question: setup.lines,
      difficulty: setup.difficulty,
      questions,
      total_errors: totalErrors,
      grade,
      grade_label: gradeLabel(grade),
      ...(notes ? { notes } : {}),
      date: getTodayDate(req),
      created_at: new Date().toISOString(),
    };

    try {
      await store.add(record);
    } catch (e) {
      console.error('[Personal Test Write Error]', e instanceof Error ? e.message : e);
      return res.status(500).json({ error: 'تعذّر حفظ نتيجة اختبارك الشخصي، يرجى المحاولة مرة أخرى.' });
    }
    res.json({ success: true, record });
  });

  // My own history only
  app.get('/api/personal-tests', async (req: Request, res: Response) => {
    const user = await authed(req, res);
    if (!user) return;
    try {
      const all = (await store.listByMember(user.id))
        .filter((r) => r.member_id === user.id)
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      const records = all.slice(0, MAX_HISTORY);
      const avg = all.length ? Math.round(all.reduce((a, r) => a + r.grade, 0) / all.length) : 0;
      const best = all.length ? Math.max(...all.map((r) => r.grade)) : 0;
      res.json({ records, stats: { count: all.length, average: avg, best } });
    } catch (e) {
      console.error('[Personal Test Read Error]', e instanceof Error ? e.message : e);
      res.status(500).json({ error: 'تعذّر تحميل سجل اختباراتك الشخصية.' });
    }
  });

  // Delete one of my own records
  app.delete('/api/personal-tests/:id', async (req: Request, res: Response) => {
    const user = await authed(req, res);
    if (!user) return;
    try {
      const ok = await store.remove(user.id, req.params.id);
      if (!ok) return res.status(404).json({ error: 'السجل غير موجود' });
      res.json({ success: true });
    } catch (e) {
      console.error('[Personal Test Delete Error]', e instanceof Error ? e.message : e);
      res.status(500).json({ error: 'تعذّر حذف السجل.' });
    }
  });
}
