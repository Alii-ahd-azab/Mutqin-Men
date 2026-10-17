import React, { useEffect, useMemo, useState } from 'react';
import {
  GraduationCap,
  CheckCircle2,
  AlertCircle,
  Trash2,
  History,
  Plus,
  Minus,
  BookOpen,
  Layers,
  Bookmark,
} from 'lucide-react';
import { api } from '../api/client';
import { TestQuestion } from '../types';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

type RangeType = 'surah' | 'juz' | 'quarter';
type Tab = 'new' | 'history';
type Surah = { number: number; name: string; ayah_count: number };
type JuzInfo = {
  juz: number;
  start_surah: number;
  start_surah_name: string;
  start_ayah: number;
  end_surah: number;
  end_surah_name: string;
  end_ayah: number;
  label: string;
};
type QuarterInfo = {
  quarter: number;
  juz: number;
  surahName: string;
  ayahNumber: number;
  label: string;
};

// Must match POINTS_PER_ERROR on the server (the server recomputes every grade itself).
const POINTS_PER_ERROR = 15;
const qGrade = (errors: number) => Math.max(0, 100 - errors * POINTS_PER_ERROR);
const label = (g: number) =>
  g >= 90 ? 'ممتاز' : g >= 80 ? 'جيد جدًا' : g >= 65 ? 'جيد' : g >= 50 ? 'مقبول' : 'يحتاج مراجعة';
const gradeColor = (g: number) =>
  g >= 80 ? 'text-emerald-700' : g >= 50 ? 'text-amber-700' : 'text-rose-700';

const DIFF_LABEL: Record<string, string> = {
  any: 'عشوائي',
  easy: 'سهل',
  medium: 'متوسط',
  hard: 'صعب',
  mixed: 'متنوع',
};

const clean = (t: string) => t.replace(/[\u0660-\u0669\u06DD]+/g, '').trim(); // drop ayah-number marks
const firstWords = (t: string, n: number) => clean(t).split(/\s+/).slice(0, n).join(' ');
const lastWords = (t: string, n: number) => clean(t).split(/\s+/).slice(-n).join(' ');

export const PersonalTestModal: React.FC<Props> = ({ isOpen, onClose }) => {
  const [tab, setTab] = useState<Tab>('new');
  const [rangeType, setRangeType] = useState<RangeType>('surah');

  // Metadata
  const [surahs, setSurahs] = useState<Surah[]>([]);
  const [juzList, setJuzList] = useState<JuzInfo[]>([]);
  const [quartersList, setQuartersList] = useState<QuarterInfo[]>([]);

  // Surah range selection
  const [startSurah, setStartSurah] = useState(78);
  const [endSurah, setEndSurah] = useState(114);

  // Juz range selection
  const [startJuz, setStartJuz] = useState(1);
  const [endJuz, setEndJuz] = useState(1);

  // Quarter range selection
  const [startQuarter, setStartQuarter] = useState(1);
  const [endQuarter, setEndQuarter] = useState(8);

  // Common parameters
  const [count, setCount] = useState(5);
  const [lines, setLines] = useState(8);
  const [difficulty, setDifficulty] = useState('any');

  // Active test state
  const [questions, setQuestions] = useState<TestQuestion[]>([]);
  const [errors, setErrors] = useState<number[]>([]);
  const [setupUsed, setSetupUsed] = useState<any>(null);
  const [activeRangeLabel, setActiveRangeLabel] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [confirmFinish, setConfirmFinish] = useState(false);
  const [result, setResult] = useState<any | null>(null);

  // History state
  const [history, setHistory] = useState<{
    records: any[];
    stats: { count: number; average: number; best: number };
  } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setError('');
    api
      .personalTestMeta()
      .then((meta) => {
        setSurahs(meta.surahs || []);
        setJuzList(meta.juzList || []);
        setQuartersList(meta.quartersList || []);
      })
      .catch(() => {
        // Fallback to basic surah endpoint if meta fails
        api
          .personalTestSurahs()
          .then((r) => setSurahs(r.surahs))
          .catch(() => setError('تعذّر تحميل بيانات نطاقات الاختبار'));
      });
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && tab === 'history') loadHistory();
  }, [isOpen, tab]);

  const loadHistory = async () => {
    try {
      setHistory(await api.personalTestHistory());
    } catch (e: any) {
      setError(e?.message || 'تعذّر تحميل السجل');
    }
  };

  const running = questions.length > 0 && !result;
  const grades = useMemo(() => errors.map(qGrade), [errors]);
  const overall = grades.length ? Math.round(grades.reduce((a, b) => a + b, 0) / grades.length) : 0;
  const totalErrors = errors.reduce((a, b) => a + b, 0);

  const reset = () => {
    setQuestions([]);
    setErrors([]);
    setResult(null);
    setSetupUsed(null);
    setActiveRangeLabel('');
    setConfirmFinish(false);
    setError('');
  };

  const start = async () => {
    setLoading(true);
    setError('');
    try {
      const setup: any = {
        range_type: rangeType,
        questions_count: count,
        lines_per_question: lines,
        difficulty,
      };

      if (rangeType === 'surah') {
        setup.start_surah = startSurah;
        setup.end_surah = endSurah;
      } else if (rangeType === 'juz') {
        setup.start_juz = startJuz;
        setup.end_juz = endJuz;
      } else if (rangeType === 'quarter') {
        setup.start_quarter = startQuarter;
        setup.end_quarter = endQuarter;
      }

      const r = await api.personalTestGenerate(setup);
      setSetupUsed(setup);
      setActiveRangeLabel(r.range_label || '');
      setQuestions(r.questions);
      setErrors(r.questions.map(() => 0));
      setConfirmFinish(false);
    } catch (e: any) {
      setError(e?.message || 'تعذّر توليد الأسئلة');
    } finally {
      setLoading(false);
    }
  };

  const finish = async () => {
    setLoading(true);
    setError('');
    try {
      const r = await api.personalTestSave({
        ...setupUsed,
        questions_results: questions.map((q, i) => ({
          start_surah: q.start_surah,
          start_ayah: q.start_ayah,
          end_surah: q.end_surah,
          end_ayah: q.end_ayah,
          errors_count: errors[i],
          difficulty_level: q.difficulty_level,
        })),
      });
      setResult(r.record);
      setConfirmFinish(false);
    } catch (e: any) {
      setError(e?.message || 'تعذّر حفظ النتيجة');
    } finally {
      setLoading(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await api.personalTestDelete(id);
      setConfirmDelete(null);
      await loadHistory();
    } catch (e: any) {
      setError(e?.message || 'تعذّر الحذف');
    }
  };

  if (!isOpen) return null;

  const selectCls =
    'w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-xs sm:text-sm text-stone-800 focus:outline-none focus:ring-2 focus:ring-emerald-500';

  return (
    <div
      className="fixed inset-0 z-50 bg-stone-900/60 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto"
      dir="rtl"
    >
      <div className="bg-white rounded-3xl border border-stone-200 max-w-2xl w-full p-6 shadow-2xl my-8 max-h-[90vh] flex flex-col space-y-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-stone-100 pb-3 shrink-0">
          <div>
            <div className="flex items-center gap-2">
              <span className="p-2 rounded-xl bg-emerald-100 text-emerald-800">
                <GraduationCap className="w-5 h-5" />
              </span>
              <h3 className="font-bold text-lg text-stone-900">اختبر نفسك</h3>
            </div>
            <p className="text-xs text-stone-500 mt-1">
              اختبار شخصي بالسور أو بالأجزاء أو بالأرباع، منفصل عن البرنامج ولا يراه المشرف ولا يؤثر على درجاتك.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-stone-400 hover:text-stone-700 rounded-xl hover:bg-stone-100 cursor-pointer"
          >
            ✕
          </button>
        </div>

        {/* Tab switch */}
        <div className="flex gap-2 shrink-0">
          {(
            [
              ['new', 'اختبار جديد', GraduationCap],
              ['history', 'سجلي ودرجاتي', History],
            ] as const
          ).map(([k, t, Icon]) => (
            <button
              key={k}
              onClick={() => setTab(k as Tab)}
              className={`flex-1 px-3 py-2 rounded-xl text-xs font-bold border flex items-center justify-center gap-1.5 cursor-pointer transition ${
                tab === k
                  ? 'bg-emerald-700 text-white border-emerald-700 shadow-xs'
                  : 'bg-white text-stone-600 border-stone-200 hover:bg-stone-50'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {t}
            </button>
          ))}
        </div>

        {/* Main Content Area */}
        <div className="overflow-y-auto flex-1 space-y-4 pr-1">
          {error && (
            <div className="p-3 rounded-2xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-bold flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {tab === 'new' && !running && !result && (
            <div className="space-y-4">
              {/* Range Type Selection: Surah, Juz, Quarter */}
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-stone-700 block">نطاق الاختبار</label>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => setRangeType('surah')}
                    className={`py-2 px-3 rounded-xl border text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer transition ${
                      rangeType === 'surah'
                        ? 'bg-emerald-100 border-emerald-600 text-emerald-900 shadow-xs'
                        : 'bg-stone-50 border-stone-200 text-stone-600 hover:bg-stone-100'
                    }`}
                  >
                    <BookOpen className="w-3.5 h-3.5" />
                    <span>بالسور</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setRangeType('juz')}
                    className={`py-2 px-3 rounded-xl border text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer transition ${
                      rangeType === 'juz'
                        ? 'bg-emerald-100 border-emerald-600 text-emerald-900 shadow-xs'
                        : 'bg-stone-50 border-stone-200 text-stone-600 hover:bg-stone-100'
                    }`}
                  >
                    <Layers className="w-3.5 h-3.5" />
                    <span>بالأجزاء</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setRangeType('quarter')}
                    className={`py-2 px-3 rounded-xl border text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer transition ${
                      rangeType === 'quarter'
                        ? 'bg-emerald-100 border-emerald-600 text-emerald-900 shadow-xs'
                        : 'bg-stone-50 border-stone-200 text-stone-600 hover:bg-stone-100'
                    }`}
                  >
                    <Bookmark className="w-3.5 h-3.5" />
                    <span>بالأرباع</span>
                  </button>
                </div>
              </div>

              {/* By Surah */}
              {rangeType === 'surah' && (
                <div className="grid grid-cols-2 gap-3 p-3.5 rounded-2xl bg-stone-50 border border-stone-200">
                  <label className="text-xs font-bold text-stone-700 space-y-1">
                    <span>من سورة</span>
                    <select
                      className={selectCls}
                      value={startSurah}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setStartSurah(v);
                        if (endSurah < v) setEndSurah(v);
                      }}
                    >
                      {surahs.map((s) => (
                        <option key={s.number} value={s.number}>
                          {s.number}. {s.name} ({s.ayah_count} آية)
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs font-bold text-stone-700 space-y-1">
                    <span>إلى سورة</span>
                    <select
                      className={selectCls}
                      value={endSurah}
                      onChange={(e) => setEndSurah(Number(e.target.value))}
                    >
                      {surahs
                        .filter((s) => s.number >= startSurah)
                        .map((s) => (
                          <option key={s.number} value={s.number}>
                            {s.number}. {s.name} ({s.ayah_count} آية)
                          </option>
                        ))}
                    </select>
                  </label>
                </div>
              )}

              {/* By Juz */}
              {rangeType === 'juz' && (
                <div className="grid grid-cols-2 gap-3 p-3.5 rounded-2xl bg-stone-50 border border-stone-200">
                  <label className="text-xs font-bold text-stone-700 space-y-1">
                    <span>من الجزء</span>
                    <select
                      className={selectCls}
                      value={startJuz}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setStartJuz(v);
                        if (endJuz < v) setEndJuz(v);
                      }}
                    >
                      {Array.from({ length: 30 }, (_, i) => i + 1).map((j) => {
                        const info = juzList.find((x) => x.juz === j);
                        return (
                          <option key={j} value={j}>
                            الجزء {j} {info ? `(${info.start_surah_name})` : ''}
                          </option>
                        );
                      })}
                    </select>
                  </label>
                  <label className="text-xs font-bold text-stone-700 space-y-1">
                    <span>إلى الجزء</span>
                    <select
                      className={selectCls}
                      value={endJuz}
                      onChange={(e) => setEndJuz(Number(e.target.value))}
                    >
                      {Array.from({ length: 30 }, (_, i) => i + 1)
                        .filter((j) => j >= startJuz)
                        .map((j) => {
                          const info = juzList.find((x) => x.juz === j);
                          return (
                            <option key={j} value={j}>
                              الجزء {j} {info ? `(${info.end_surah_name})` : ''}
                            </option>
                          );
                        })}
                    </select>
                  </label>
                </div>
              )}

              {/* By Quarter */}
              {rangeType === 'quarter' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3.5 rounded-2xl bg-stone-50 border border-stone-200">
                  <label className="text-xs font-bold text-stone-700 space-y-1">
                    <span>من الربع</span>
                    <select
                      className={selectCls}
                      value={startQuarter}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setStartQuarter(v);
                        if (endQuarter < v) setEndQuarter(v);
                      }}
                    >
                      {quartersList.length > 0 ? (
                        quartersList.map((q) => (
                          <option key={q.quarter} value={q.quarter}>
                            {q.label}
                          </option>
                        ))
                      ) : (
                        Array.from({ length: 240 }, (_, i) => i + 1).map((q) => (
                          <option key={q} value={q}>
                            الربع {q}
                          </option>
                        ))
                      )}
                    </select>
                  </label>
                  <label className="text-xs font-bold text-stone-700 space-y-1">
                    <span>إلى الربع</span>
                    <select
                      className={selectCls}
                      value={endQuarter}
                      onChange={(e) => setEndQuarter(Number(e.target.value))}
                    >
                      {(quartersList.length > 0
                        ? quartersList.filter((q) => q.quarter >= startQuarter)
                        : Array.from({ length: 240 }, (_, i) => i + 1).filter((q) => q >= startQuarter).map((q) => ({
                            quarter: q,
                            label: `الربع ${q}`,
                          }))
                      ).map((q) => (
                        <option key={q.quarter} value={q.quarter}>
                          {q.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}

              {/* Questions count, lines, difficulty */}
              <div className="grid grid-cols-3 gap-3">
                <label className="text-xs font-bold text-stone-700 space-y-1">
                  <span>عدد الأسئلة</span>
                  <input
                    type="number"
                    min={1}
                    max={30}
                    value={count}
                    onChange={(e) => setCount(Math.max(1, Math.min(30, Number(e.target.value) || 1)))}
                    className={selectCls}
                  />
                </label>
                <label className="text-xs font-bold text-stone-700 space-y-1">
                  <span>أسطر السؤال</span>
                  <input
                    type="number"
                    min={1}
                    max={30}
                    value={lines}
                    onChange={(e) => setLines(Math.max(1, Math.min(30, Number(e.target.value) || 1)))}
                    className={selectCls}
                  />
                </label>
                <label className="text-xs font-bold text-stone-700 space-y-1">
                  <span>الصعوبة</span>
                  <select
                    className={selectCls}
                    value={difficulty}
                    onChange={(e) => setDifficulty(e.target.value)}
                  >
                    {Object.entries(DIFF_LABEL).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="rounded-xl bg-amber-50/70 border border-amber-200/80 p-3 text-[11px] text-amber-900 leading-relaxed">
                <strong>نظام التقييم:</strong> كل سؤال من 100، ويُخصم {POINTS_PER_ERROR} درجة عن كل خطأ (بحد أدنى صفر)، والدرجة النهائية هي متوسط درجات الأسئلة. مواضع الأسئلة تبدأ وتنتهي عند رؤوس الآيات وتتغير عشوائيًا في كل اختبار.
              </div>

              <button
                onClick={start}
                disabled={loading || (rangeType === 'surah' && surahs.length === 0)}
                className="w-full px-5 py-3 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-sm disabled:opacity-50 cursor-pointer shadow-md transition"
              >
                {loading ? 'جاري توليد الأسئلة...' : 'ابدأ الاختبار'}
              </button>
            </div>
          )}

          {/* Running Test */}
          {tab === 'new' && running && (
            <div className="space-y-3">
              {activeRangeLabel && (
                <div className="text-xs font-bold text-emerald-900 bg-emerald-50 px-3.5 py-2 rounded-xl border border-emerald-200 flex items-center justify-between">
                  <span>النطاق المختار: {activeRangeLabel}</span>
                  <span className="text-stone-500 font-normal">{questions.length} أسئلة</span>
                </div>
              )}
              <div className="p-3 rounded-2xl bg-stone-50 border border-stone-200 flex items-center justify-between text-xs">
                <span>
                  إجمالي الأخطاء: <strong className="font-mono text-stone-900">{totalErrors}</strong>
                </span>
                <span>
                  الدرجة الحالية: <strong className={`font-mono text-sm ${gradeColor(overall)}`}>{overall}%</strong>{' '}
                  ({label(overall)})
                </span>
              </div>
              {questions.map((q, i) => (
                <div key={i} className="p-3.5 rounded-2xl border border-stone-200 space-y-2 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-stone-900">السؤال {i + 1}</span>
                    <span className="flex items-center gap-1.5">
                      {q.difficulty_level && (
                        <span className="px-2 py-0.5 rounded-full bg-stone-100 text-stone-700 text-[10px] font-bold">
                          {DIFF_LABEL[q.difficulty_level]}
                        </span>
                      )}
                      <span className="text-stone-500 font-mono">{q.actual_lines ?? q.target_lines} سطر</span>
                    </span>
                  </div>
                  <p className="leading-relaxed text-stone-800">
                    <strong className="text-emerald-800">من بداية:</strong> سورة {q.start_surah_name} آية {q.start_ayah} (ص{q.start_page}) — «{firstWords(q.start_text, 6)}…»
                  </p>
                  <p className="leading-relaxed text-stone-800">
                    <strong className="text-emerald-800">إلى نهاية:</strong> سورة {q.end_surah_name} آية {q.end_ayah} — «…{lastWords(q.end_text, 5)}»
                  </p>
                  <div className="flex items-center justify-between pt-1">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() =>
                          setErrors((e) => e.map((v, j) => (j === i ? Math.max(0, v - 1) : v)))
                        }
                        className="w-8 h-8 rounded-lg border border-stone-300 flex items-center justify-center hover:bg-stone-100 cursor-pointer transition"
                      >
                        <Minus className="w-4 h-4" />
                      </button>
                      <span className="w-8 text-center font-mono font-bold text-base text-stone-900">
                        {errors[i]}
                      </span>
                      <button
                        onClick={() =>
                          setErrors((e) => e.map((v, j) => (j === i ? Math.min(99, v + 1) : v)))
                        }
                        className="w-8 h-8 rounded-lg border border-stone-300 flex items-center justify-center hover:bg-stone-100 cursor-pointer transition"
                      >
                        <Plus className="w-4 h-4" />
                      </button>
                      <span className="text-stone-500">أخطاء</span>
                    </div>
                    <span className={`font-bold font-mono text-sm ${gradeColor(grades[i])}`}>
                      {grades[i]}%
                    </span>
                  </div>
                </div>
              ))}

              {confirmFinish ? (
                <div className="p-3.5 rounded-2xl bg-amber-50 border border-amber-200 space-y-2 text-xs">
                  <p className="font-bold text-amber-950">حفظ النتيجة في سجلك؟ لا يمكن تعديل الأخطاء بعد الحفظ.</p>
                  <div className="flex gap-2">
                    <button
                      onClick={finish}
                      disabled={loading}
                      className="px-4 py-2 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold disabled:opacity-50 cursor-pointer"
                    >
                      {loading ? 'جاري الحفظ...' : 'نعم، احفظ'}
                    </button>
                    <button
                      onClick={() => setConfirmFinish(false)}
                      className="px-4 py-2 rounded-xl border border-stone-300 font-bold hover:bg-stone-100 cursor-pointer"
                    >
                      رجوع
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex gap-2">
                  <button
                    onClick={() => setConfirmFinish(true)}
                    className="flex-1 px-4 py-3 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-sm cursor-pointer shadow-sm transition"
                  >
                    إنهاء الاختبار وحساب الدرجة
                  </button>
                  <button
                    onClick={reset}
                    className="px-4 py-3 rounded-xl border border-stone-300 text-stone-600 font-bold text-sm hover:bg-stone-50 cursor-pointer"
                  >
                    إلغاء
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Result View */}
          {tab === 'new' && result && (
            <div className="text-center space-y-4 py-4">
              <CheckCircle2 className={`w-14 h-14 mx-auto ${gradeColor(result.grade)}`} />
              <div>
                <div className={`text-5xl font-bold font-mono ${gradeColor(result.grade)}`}>
                  {result.grade}%
                </div>
                <div className="text-lg font-bold text-stone-900 mt-1">{result.grade_label}</div>
                <p className="text-xs text-stone-600 mt-1">
                  {result.range_label || `من سورة ${result.start_surah_name} إلى سورة ${result.end_surah_name}`} •{' '}
                  {result.total_errors} أخطاء في {result.questions_count} أسئلة
                </p>
              </div>
              <div className="flex gap-2 justify-center pt-2">
                <button
                  onClick={reset}
                  className="px-5 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-xs cursor-pointer"
                >
                  اختبار جديد
                </button>
                <button
                  onClick={() => {
                    reset();
                    setTab('history');
                  }}
                  className="px-5 py-2.5 rounded-xl border border-stone-300 font-bold text-xs hover:bg-stone-50 cursor-pointer"
                >
                  عرض سجلي
                </button>
              </div>
            </div>
          )}

          {/* History Tab */}
          {tab === 'history' && (
            <div className="space-y-3">
              {!history ? (
                <p className="text-center text-xs text-stone-400 py-8">جاري التحميل...</p>
              ) : history.records.length === 0 ? (
                <p className="text-center text-xs text-stone-500 py-8">
                  لا توجد اختبارات شخصية بعد. ابدأ أول اختبار من تبويب «اختبار جديد».
                </p>
              ) : (
                <>
                  <div className="grid grid-cols-3 gap-2 text-center text-xs">
                    <div className="p-3 rounded-2xl bg-stone-50 border border-stone-200">
                      <div className="text-stone-500">عدد الاختبارات</div>
                      <div className="text-lg font-bold font-mono text-stone-900">{history.stats.count}</div>
                    </div>
                    <div className="p-3 rounded-2xl bg-stone-50 border border-stone-200">
                      <div className="text-stone-500">متوسط الدرجات</div>
                      <div className={`text-lg font-bold font-mono ${gradeColor(history.stats.average)}`}>
                        {history.stats.average}%
                      </div>
                    </div>
                    <div className="p-3 rounded-2xl bg-stone-50 border border-stone-200">
                      <div className="text-stone-500">أفضل درجة</div>
                      <div className="text-lg font-bold font-mono text-emerald-700">{history.stats.best}%</div>
                    </div>
                  </div>
                  {history.records.map((r) => (
                    <div key={r.id} className="rounded-2xl border border-stone-200 text-xs bg-white">
                      <button
                        className="w-full p-3 flex items-center justify-between gap-3 text-right cursor-pointer hover:bg-stone-50/70 transition rounded-2xl"
                        onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                      >
                        <div>
                          <span className="font-bold text-stone-900 block">
                            {r.range_label ||
                              (r.start_surah_name +
                                (r.end_surah !== r.start_surah ? ` ← ${r.end_surah_name}` : ''))}
                          </span>
                          <span className="text-stone-500 text-[11px]">
                            {r.date} • {r.questions_count} أسئلة • {r.total_errors} أخطاء •{' '}
                            {DIFF_LABEL[r.difficulty] || ''}
                          </span>
                        </div>
                        <span className={`font-bold font-mono text-base ${gradeColor(r.grade)}`}>
                          {r.grade}%
                        </span>
                      </button>
                      {expanded === r.id && (
                        <div className="border-t border-stone-100 p-3 space-y-1.5 bg-stone-50/40 rounded-b-2xl">
                          {r.questions.map((q: any) => (
                            <div key={q.question_number} className="flex justify-between text-stone-700">
                              <span>
                                س{q.question_number}: {q.start_surah_name} {q.start_ayah} ← {q.end_surah_name}{' '}
                                {q.end_ayah}
                              </span>
                              <span>
                                {q.errors_count} أخطاء •{' '}
                                <strong className={`font-mono ${gradeColor(q.grade)}`}>{q.grade}%</strong>
                              </span>
                            </div>
                          ))}
                          {confirmDelete === r.id ? (
                            <div className="flex items-center gap-2 pt-2 border-t border-stone-200">
                              <span className="text-rose-800 font-bold">حذف هذا السجل نهائيًا؟</span>
                              <button
                                onClick={() => remove(r.id)}
                                className="px-3 py-1.5 rounded-lg bg-rose-700 hover:bg-rose-800 text-white font-bold cursor-pointer"
                              >
                                حذف
                              </button>
                              <button
                                onClick={() => setConfirmDelete(null)}
                                className="px-3 py-1.5 rounded-lg border border-stone-300 font-bold hover:bg-stone-100 cursor-pointer"
                              >
                                إلغاء
                              </button>
                            </div>
                          ) : (
                            <div className="pt-2 border-t border-stone-200 flex justify-end">
                              <button
                                onClick={() => setConfirmDelete(r.id)}
                                className="text-rose-700 hover:text-rose-800 font-bold flex items-center gap-1 cursor-pointer"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                                حذف السجل
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
