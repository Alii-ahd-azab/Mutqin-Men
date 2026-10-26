// Personal self-tests (اختبر نفسك) — Men only. Question generation runs in the peer-tests Edge
// Function (the Mushaf data never ships to the browser); results are saved by an owner-checked RPC.
import {
  ALL_VERSES,
  ALL_QUARTERS,
  getQuarterStartIndex,
  getQuarterEndIndex,
  getSurahs,
  getJuzList,
  generateQuestionsInVerseRange,
  type TestDifficulty,
} from './testGenerator.ts';

export class RuleError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export const POINTS_PER_ERROR = 15;
const MAX_QUESTIONS = 30;
const MAX_LINES = 30;
const DIFFICULTIES = ['any', 'easy', 'medium', 'hard', 'mixed'];

export interface PersonalSetup {
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

function strictInt(v: unknown): number | null {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

/** Parses a personal-test setup exactly as the former /api/personal-tests routes did. */
export function parsePersonalSetup(body: any): PersonalSetup {
  const rangeType = (body?.range_type || 'surah') as 'surah' | 'juz' | 'quarter';
  const count = strictInt(body?.questions_count);
  const lines = strictInt(body?.lines_per_question);
  const difficulty = (body?.difficulty ?? 'any') as string;
  if (count === null || count < 1 || count > MAX_QUESTIONS) throw new RuleError(`عدد الأسئلة يجب أن يكون رقمًا صحيحًا بين 1 و ${MAX_QUESTIONS}`);
  if (lines === null || lines < 1 || lines > MAX_LINES) throw new RuleError(`طول السؤال يجب أن يكون رقمًا صحيحًا بين 1 و ${MAX_LINES} سطرًا`);
  if (!DIFFICULTIES.includes(difficulty)) throw new RuleError('مستوى الصعوبة غير صالح');

  const fromQuarters = (sQ: number, eQ: number) => {
    const lo = getQuarterStartIndex(sQ);
    const hi = getQuarterEndIndex(eQ);
    return { lo, hi, sV: ALL_VERSES[lo], eV: ALL_VERSES[hi] };
  };
  const base = { count, lines, difficulty: difficulty as TestDifficulty };

  if (rangeType === 'quarter') {
    const sQ = strictInt(body?.start_quarter);
    const eQ = strictInt(body?.end_quarter);
    if (sQ === null || eQ === null || sQ < 1 || eQ > 240 || sQ > eQ) {
      throw new RuleError('نطاق الأرباع غير صالح (يجب أن يكون ربع البداية بين 1 و 240 وقبل أو يساوي ربع النهاية)');
    }
    const { lo, hi, sV, eV } = fromQuarters(sQ, eQ);
    const range_label = sQ === eQ ? `الربع ${sQ} (${sV.surah_name})` : `الأرباع ${sQ} ← ${eQ} (${sV.surah_name} إلى ${eV.surah_name})`;
    return { ...base, range_type: 'quarter', lo, hi, sS: sV.surah, eS: eV.surah, sSName: sV.surah_name, eSName: eV.surah_name, start_quarter: sQ, end_quarter: eQ, range_label };
  }
  if (rangeType === 'juz') {
    const sJ = strictInt(body?.start_juz);
    const eJ = strictInt(body?.end_juz);
    if (sJ === null || eJ === null || sJ < 1 || eJ > 30 || sJ > eJ) {
      throw new RuleError('نطاق الأجزاء غير صالح (يجب أن يكون جزء البداية بين 1 و 30 وقبل أو يساوي جزء النهاية)');
    }
    const sQ = (sJ - 1) * 8 + 1;
    const eQ = eJ * 8;
    const { lo, hi, sV, eV } = fromQuarters(sQ, eQ);
    const range_label = sJ === eJ ? `الجزء ${sJ} (${sV.surah_name})` : `الأجزاء ${sJ} ← ${eJ} (${sV.surah_name} إلى ${eV.surah_name})`;
    return { ...base, range_type: 'juz', lo, hi, sS: sV.surah, eS: eV.surah, sSName: sV.surah_name, eSName: eV.surah_name, start_juz: sJ, end_juz: eJ, start_quarter: sQ, end_quarter: eQ, range_label };
  }
  const surahs = getSurahs();
  const sS = strictInt(body?.start_surah);
  const eS = strictInt(body?.end_surah);
  if (sS === null || eS === null || sS < 1 || eS > 114 || sS > eS) {
    throw new RuleError('نطاق السور غير صالح (يجب أن تكون سورة البداية قبل أو تساوي سورة النهاية)');
  }
  const sSName = surahs[sS - 1].name;
  const eSName = surahs[eS - 1].name;
  return {
    ...base,
    range_type: 'surah',
    lo: surahs[sS - 1].first_idx,
    hi: surahs[eS - 1].last_idx,
    sS,
    eS,
    sSName,
    eSName,
    range_label: sS === eS ? `سورة ${sSName}` : `سورة ${sSName} ← سورة ${eSName}`,
  };
}

export function generatePersonalQuestions(setup: PersonalSetup) {
  const questions = generateQuestionsInVerseRange(setup.lo, setup.hi, setup.count, setup.lines, setup.difficulty);
  if (questions.length < setup.count) {
    throw new RuleError('النطاق المختار لا يتسع لهذا العدد من الأسئلة بهذا الطول. وسّع النطاق أو قلّل عدد الأسئلة أو أسطر السؤال.', 422);
  }
  return {
    questions,
    points_per_error: POINTS_PER_ERROR,
    range_label: setup.range_label,
    // Resolved range, sent back with the results to the men_save_personal_test RPC.
    setup: {
      range_type: setup.range_type,
      range_label: setup.range_label,
      start_surah: setup.sS,
      start_surah_name: setup.sSName,
      end_surah: setup.eS,
      end_surah_name: setup.eSName,
      start_juz: setup.start_juz ?? null,
      end_juz: setup.end_juz ?? null,
      start_quarter: setup.start_quarter ?? null,
      end_quarter: setup.end_quarter ?? null,
      questions_count: setup.count,
      lines_per_question: setup.lines,
      difficulty: setup.difficulty,
    },
  };
}

export function personalMeta() {
  return {
    surahs: getSurahs().map((s) => ({ number: s.number, name: s.name, ayah_count: s.ayah_count })),
    juzList: getJuzList(),
    quartersList: ALL_QUARTERS.map((q) => ({
      quarter: q.quarter,
      juz: q.juz,
      surahName: q.surahName,
      ayahNumber: q.ayahNumber,
      label: `الربع ${q.quarter} — سورة ${q.surahName} (${q.ayahNumber})`,
    })),
  };
}
