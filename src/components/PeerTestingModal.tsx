import React, { useState, useEffect } from 'react';
import { User, TestDefinition, TestQuestion, TestAttempt } from '../types';
import { api } from '../api/client';
import { TestConditionsCard } from './TestConditionsCard';
import {
  Award,
  Users,
  CheckCircle2,
  XCircle,
  AlertCircle,
  HelpCircle,
  Sparkles,
  ArrowRight,
  BookOpen,
  ChevronDown,
  ChevronUp,
  FileText,
  Clock,
  ShieldAlert,
} from 'lucide-react';

interface PeerTestingModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: User;
  activeTest: TestDefinition;
  onCompleted: () => void;
}

export const PeerTestingModal: React.FC<PeerTestingModalProps> = ({
  isOpen,
  onClose,
  currentUser,
  activeTest,
  onCompleted,
}) => {
  const [candidates, setCandidates] = useState<any[]>([]);
  const [loadingCandidates, setLoadingCandidates] = useState(true);
  const [selectedCandidate, setSelectedCandidate] = useState<any | null>(null);

  // Active testing session state
  const [questions, setQuestions] = useState<TestQuestion[]>([]);
  const [loadingQuestions, setLoadingQuestions] = useState(false);
  const [questionErrors, setQuestionErrors] = useState<number[]>([]);
  const [questionNotes, setQuestionNotes] = useState<string[]>([]);
  const [overallNotes, setOverallNotes] = useState('');
  const [expandedQuestionIdx, setExpandedQuestionIdx] = useState<number | null>(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [submittedAttempt, setSubmittedAttempt] = useState<TestAttempt | null>(null);

  useEffect(() => {
    if (isOpen && activeTest) {
      loadCandidates();
      setSelectedCandidate(null);
      setQuestions([]);
      setSubmittedAttempt(null);
      setSubmitError('');
    }
  }, [isOpen, activeTest]);

  const loadCandidates = async () => {
    setLoadingCandidates(true);
    try {
      const res = await api.getEligibleCandidates(activeTest.id);
      // Filter out current user from candidate list (peer testing: you cannot test yourself)
      const list = (res.candidates || []).filter((c) => c.id !== currentUser.id);
      setCandidates(list);
    } catch (err: any) {
      console.error(err);
    } finally {
      setLoadingCandidates(false);
    }
  };

  const handleStartTesting = async (candidate: any) => {
    setSelectedCandidate(candidate);
    setLoadingQuestions(true);
    setSubmitError('');
    try {
      const res = await api.generateTestQuestions(activeTest.id, candidate.id);
      setQuestions(res.questions || []);
      setQuestionErrors(new Array(res.questions.length).fill(0));
      setQuestionNotes(new Array(res.questions.length).fill(''));
      setExpandedQuestionIdx(0);
    } catch (err: any) {
      setSubmitError(err?.message || 'تعذر توليد أسئلة الاختبار');
    } finally {
      setLoadingQuestions(false);
    }
  };

  const handleUpdateErrorCount = (qIdx: number, delta: number) => {
    setQuestionErrors((prev) => {
      const next = [...prev];
      next[qIdx] = Math.max(0, (next[qIdx] || 0) + delta);
      return next;
    });
  };

  const totalErrors = questionErrors.reduce((sum, e) => sum + (e || 0), 0);
  const hasMax = activeTest.has_max_errors && typeof activeTest.max_errors_allowed === 'number';
  const wouldPass = !hasMax || totalErrors <= (activeTest.max_errors_allowed ?? 0);

  const handleSubmitAttempt = async () => {
    if (!selectedCandidate) return;
    setSubmitting(true);
    setSubmitError('');

    try {
      const questionsResults = questions.map((q, idx) => ({
        start_surah: q.start_surah,
        start_ayah: q.start_ayah,
        end_surah: q.end_surah,
        end_ayah: q.end_ayah,
        errors_count: questionErrors[idx] || 0,
        notes: questionNotes[idx] ? questionNotes[idx].trim().slice(0, 300) : undefined,
      }));

      const payload = {
        test_id: activeTest.id,
        candidate_id: selectedCandidate.id,
        questions_results: questionsResults,
        notes: overallNotes ? overallNotes.trim().slice(0, 300) : undefined,
      };

      const res = await api.recordTestAttempt(payload);
      setSubmittedAttempt(res.attempt);
      onCompleted();
    } catch (err: any) {
      setSubmitError(err?.message || 'فشل إرسال نتيجة الاختبار');
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-stone-900/60 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-3xl border border-stone-200 max-w-2xl w-full p-6 sm:p-7 shadow-2xl space-y-6 my-8 animate-in fade-in zoom-in-95 max-h-[90vh] flex flex-col">
        {/* Modal Header */}
        <div className="flex items-start justify-between gap-4 border-b border-stone-100 pb-4 shrink-0">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="p-2 rounded-xl bg-amber-100 text-amber-800">
                <Award className="w-5 h-5" />
              </span>
              <h3 className="font-bold text-lg text-stone-900">
                اختبار الزملاء (Peer Testing)
              </h3>
            </div>
            <p className="text-xs text-stone-500">
              نطاق الاختبار: <strong>من الربع {activeTest.range_start} إلى الربع {activeTest.range_end}</strong> • {activeTest.questions_count} أسئلة ({activeTest.lines_per_question} أسطر لكل سؤال)
            </p>
          </div>

          <button
            onClick={onClose}
            className="p-2 text-stone-400 hover:text-stone-700 rounded-xl hover:bg-stone-100 transition"
          >
            ✕
          </button>
        </div>

        {/* Modal Body */}
        <div className="overflow-y-auto flex-1 space-y-5 pr-1">
          {submitError && (
            <div className="p-3.5 rounded-2xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-bold flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
              <span>{submitError}</span>
            </div>
          )}

          {submittedAttempt ? (
            /* Result Screen */
            <div className="py-8 text-center space-y-5">
              <div
                className={`w-16 h-16 rounded-full mx-auto flex items-center justify-center ${
                  submittedAttempt.passed
                    ? 'bg-emerald-100 text-emerald-700'
                    : 'bg-rose-100 text-rose-700'
                }`}
              >
                {submittedAttempt.passed ? (
                  <CheckCircle2 className="w-10 h-10" />
                ) : (
                  <XCircle className="w-10 h-10" />
                )}
              </div>

              <div className="space-y-1">
                <h4 className="text-xl font-bold text-stone-900">
                  {submittedAttempt.passed
                    ? 'تم اجتياز الاختبار بنجاح وبإتقان مبارك!'
                    : 'تم تسجيل نتيجة الاختبار (لم يجتز العضو)'}
                </h4>
                <p className="text-xs text-stone-500">
                  العضو المُختبَر: <strong>{submittedAttempt.candidate_name}</strong> • تم الاختبار بواسطة: <strong>{currentUser.name}</strong>
                </p>
              </div>

              <div className="inline-flex items-center gap-4 p-4 rounded-2xl bg-stone-50 border border-stone-200 text-xs">
                <div>
                  <span className="text-stone-400 block text-[11px]">مجموع الأخطاء</span>
                  <span className="text-lg font-bold font-mono text-stone-800">
                    {submittedAttempt.total_errors}
                  </span>
                </div>
                {hasMax && (
                  <div>
                    <span className="text-stone-400 block text-[11px]">الحد الأقصى المسموح</span>
                    <span className="text-lg font-bold font-mono text-stone-800">
                      {activeTest.max_errors_allowed}
                    </span>
                  </div>
                )}
                <div>
                  <span className="text-stone-400 block text-[11px]">النتيجة الرسمية</span>
                  <span
                    className={`font-bold text-xs ${
                      submittedAttempt.passed ? 'text-emerald-700' : 'text-rose-700'
                    }`}
                  >
                    {submittedAttempt.passed ? 'ناجح ومعتمد' : 'يحتاج استدراك'}
                  </span>
                </div>
              </div>

              <div className="pt-4">
                <button
                  onClick={onClose}
                  className="px-6 py-2.5 rounded-xl bg-stone-800 hover:bg-stone-900 text-white font-bold text-xs shadow-xs"
                >
                  إغلاق النافذة
                </button>
              </div>
            </div>
          ) : !selectedCandidate ? (
            /* STEP 1: Candidate Selection */
            <div className="space-y-4">
              <TestConditionsCard test={activeTest} />

              <div>
                <h4 className="font-bold text-sm text-stone-900 flex items-center gap-2">
                  <Users className="w-4 h-4 text-emerald-700" />
                  <span>اختر الزميل الذي ترغب في اختباره:</span>
                </h4>
                <p className="text-xs text-stone-500 mt-0.5">
                  تظهر قائمة الزملاء المستوفين لشروط الاختبار المسبقة المحددة من قِبَل المشرف.
                </p>
              </div>

              {loadingCandidates ? (
                <div className="py-12 text-center text-xs text-stone-400">
                  جاري فحص استيفاء شروط الزملاء...
                </div>
              ) : candidates.length === 0 ? (
                <div className="p-8 text-center space-y-2 rounded-2xl bg-stone-50 border border-stone-200">
                  <Users className="w-8 h-8 text-stone-300 mx-auto" />
                  <p className="text-xs text-stone-600 font-bold">
                    لا يوجد زملاء آخرون مسجلون حاليًا في المقرأة.
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-stone-100 border border-stone-200 rounded-2xl overflow-hidden">
                  {candidates.map((cand) => (
                    <div
                      key={cand.id}
                      className={`p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs transition ${
                        cand.is_eligible ? 'bg-white hover:bg-stone-50/80' : 'bg-stone-50/60 opacity-75'
                      }`}
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-stone-900 text-sm">{cand.name}</span>
                          {cand.has_passed && (
                            <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[10px] font-bold">
                              سبق له الاجتياز
                            </span>
                          )}
                        </div>

                        {cand.is_eligible && cand.covers_full_range === false && cand.effective_range_end && (
                          <p className="text-[11px] text-amber-700 font-medium">
                            سيُختبر حتى الربع {cand.effective_range_end} فقط
                          </p>
                        )}

                        {!cand.is_eligible && cand.ineligibility_reasons?.length > 0 && (
                          <div className="space-y-0.5">
                            {cand.ineligibility_reasons.map((r: string, i: number) => (
                              <p key={i} className="text-[11px] text-amber-700 flex items-center gap-1 font-medium">
                                <span>• {r}</span>
                              </p>
                            ))}
                          </div>
                        )}
                      </div>

                      <div>
                        {cand.is_eligible ? (
                          <button
                            onClick={() => handleStartTesting(cand)}
                            className="w-full sm:w-auto px-4 py-2 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-xs transition shadow-xs flex items-center justify-center gap-1.5 cursor-pointer"
                          >
                            <span>بدء اختبار الزميل</span>
                            <ArrowRight className="w-3.5 h-3.5 rotate-180" />
                          </button>
                        ) : (
                          <span className="text-[11px] text-stone-400 font-medium px-2 py-1 bg-stone-100 rounded-lg inline-block">
                            غير مستوفٍ للشروط
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            /* STEP 2: Questions & Error Tracking */
            <div className="space-y-5">
              <TestConditionsCard
                test={activeTest}
                effectiveRangeEnd={selectedCandidate?.effective_range_end}
                isPartial={selectedCandidate?.covers_full_range === false}
                candidateName={selectedCandidate?.name}
              />

              <div className="p-3.5 rounded-2xl bg-emerald-50/70 border border-emerald-200/80 flex items-center justify-between gap-3 text-xs">
                <div>
                  <span className="text-emerald-900/70 block text-[11px]">أنت تختبر الآن زميلك:</span>
                  <span className="font-bold text-emerald-950 text-sm">{selectedCandidate.name}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedCandidate(null)}
                  className="text-[11px] text-stone-500 hover:text-stone-800 underline font-medium"
                >
                  تغيير الزميل
                </button>
              </div>

              {loadingQuestions ? (
                <div className="py-12 text-center text-xs text-stone-400">
                  جاري توليد أسئلة الاختبار من مصحف المدينة...
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-bold text-stone-700">
                      الأسئلة المولدة ({questions.length} أسئلة):
                    </span>
                    <span className="text-stone-500 text-[11px]">
                      مجموع الأخطاء المسجلة حتى الآن: <strong className="font-mono text-stone-900">{totalErrors}</strong>
                    </span>
                  </div>

                  {questions.map((q, idx) => {
                    const isExpanded = expandedQuestionIdx === idx;
                    const errCount = questionErrors[idx] || 0;

                    return (
                      <div
                        key={idx}
                        className="rounded-2xl border border-stone-200 bg-white overflow-hidden shadow-2xs"
                      >
                        {/* Question Header */}
                        <div
                          onClick={() => setExpandedQuestionIdx(isExpanded ? null : idx)}
                          className="p-3.5 bg-stone-50 hover:bg-stone-100/80 cursor-pointer flex items-center justify-between gap-3 text-xs select-none"
                        >
                          <div className="flex items-center gap-2.5">
                            <span className="w-6 h-6 rounded-full bg-emerald-800 text-amber-200 text-xs font-bold flex items-center justify-center shrink-0">
                              {q.question_number}
                            </span>
                            <div className="space-y-0.5">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-bold text-stone-900">
                                  السؤال {q.question_number}: {q.start_surah_name} [آية {q.start_ayah}] ⟵ {q.end_surah_name} [آية {q.end_ayah}]
                                </span>
                                {q.difficulty_level && (
                                  <span
                                    className={`px-2 py-0.5 rounded-md text-[10px] font-bold ${
                                      q.difficulty_level === 'easy'
                                        ? 'bg-emerald-100 text-emerald-800'
                                        : q.difficulty_level === 'hard'
                                        ? 'bg-rose-100 text-rose-800'
                                        : 'bg-amber-100 text-amber-800'
                                    }`}
                                  >
                                    {q.difficulty_level === 'easy'
                                      ? 'سهل'
                                      : q.difficulty_level === 'hard'
                                      ? 'صعب'
                                      : 'متوسط'}
                                  </span>
                                )}
                                {q.actual_lines !== undefined && (
                                  <span className="text-[10px] text-stone-600 bg-stone-200/70 px-1.5 py-0.5 rounded-md font-mono">
                                    {q.actual_lines} أسطر
                                  </span>
                                )}
                              </div>
                              <span className="text-[11px] text-stone-500 block">
                                الصفحة {q.start_page} (سطر {q.start_line}) إلى الصفحة {q.end_page} (سطر {q.end_line})
                              </span>
                            </div>
                          </div>

                          <div className="flex items-center gap-3">
                            <span
                              className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${
                                errCount === 0
                                  ? 'bg-emerald-100 text-emerald-800'
                                  : 'bg-rose-100 text-rose-800'
                              }`}
                            >
                              {errCount} أخطاء
                            </span>
                            {isExpanded ? (
                              <ChevronUp className="w-4 h-4 text-stone-400" />
                            ) : (
                              <ChevronDown className="w-4 h-4 text-stone-400" />
                            )}
                          </div>
                        </div>

                        {/* Question Content */}
                        {isExpanded && (
                          <div className="p-4 space-y-4 border-t border-stone-100 bg-white">
                            <div className="space-y-2 p-3.5 rounded-xl bg-amber-50/50 border border-amber-200/60">
                              <p className="text-[11px] text-amber-900 font-bold">
                                اطلب من الزميل التلاوة من بداية هذه الآية حتى نهاية الآية المحددة:
                              </p>

                              <div className="space-y-1 text-xs text-stone-800">
                                <div>
                                  <span className="text-emerald-800 font-bold ml-1.5">ابدأ من:</span>
                                  <span className="font-quran text-sm text-stone-900">{q.start_text}</span>
                                  <span className="text-[11px] text-stone-400 mr-2">
                                    ({q.start_surah_name} - الآية {q.start_ayah})
                                  </span>
                                </div>

                                <div className="pt-1 border-t border-amber-100">
                                  <span className="text-emerald-800 font-bold ml-1.5">توقف عند نهاية:</span>
                                  <span className="font-quran text-sm text-stone-900">{q.end_text}</span>
                                  <span className="text-[11px] text-stone-400 mr-2">
                                    ({q.end_surah_name} - الآية {q.end_ayah})
                                  </span>
                                </div>
                              </div>
                            </div>

                            {/* Error Counter for this question */}
                            <div className="flex items-center justify-between gap-4 pt-1">
                              <span className="text-xs font-bold text-stone-700">
                                تسجيل أخطاء هذا السؤال:
                              </span>

                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => handleUpdateErrorCount(idx, -1)}
                                  disabled={errCount <= 0}
                                  className="w-8 h-8 rounded-xl bg-stone-100 hover:bg-stone-200 text-stone-800 font-bold text-sm flex items-center justify-center disabled:opacity-30"
                                >
                                  -
                                </button>
                                <span className="w-8 text-center font-bold font-mono text-base text-stone-900">
                                  {errCount}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => handleUpdateErrorCount(idx, 1)}
                                  className="w-8 h-8 rounded-xl bg-rose-100 hover:bg-rose-200 text-rose-800 font-bold text-sm flex items-center justify-center"
                                >
                                  +
                                </button>
                              </div>
                            </div>

                            <div>
                              <input
                                type="text"
                                placeholder="ملاحظة حول أداء الزميل في هذا السؤال (اختياري)..."
                                value={questionNotes[idx] || ''}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setQuestionNotes((prev) => {
                                    const next = [...prev];
                                    next[idx] = val;
                                    return next;
                                  });
                                }}
                                className="w-full px-3 py-1.5 text-xs border border-stone-200 rounded-xl bg-stone-50 outline-hidden"
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {/* Summary & Overall notes */}
                  <div className="p-4 rounded-2xl bg-stone-50 border border-stone-200 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-stone-800">
                        النتيجة الإجمالية المحتسبة:
                      </span>
                      <div className="flex items-center gap-3">
                        <span className="text-xs font-bold text-stone-600">
                          إجمالي الأخطاء: <strong className="font-mono text-stone-900">{totalErrors}</strong>
                        </span>
                        {hasMax && (
                          <span
                            className={`text-xs font-bold px-2.5 py-0.5 rounded-full ${
                              wouldPass
                                ? 'bg-emerald-100 text-emerald-800'
                                : 'bg-rose-100 text-rose-800'
                            }`}
                          >
                            {wouldPass ? 'مستوفٍ للاجتياز' : 'تجاوز حد الأخطاء'}
                          </span>
                        )}
                      </div>
                    </div>

                    <textarea
                      rows={2}
                      placeholder="ملاحظات ختامية للزميل حول الاختبار كله (اختياري)..."
                      value={overallNotes}
                      onChange={(e) => setOverallNotes(e.target.value)}
                      className="w-full px-3 py-2 text-xs border border-stone-200 rounded-xl bg-white outline-hidden"
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Modal Footer */}
        {selectedCandidate && !submittedAttempt && (
          <div className="border-t border-stone-100 pt-4 flex items-center justify-between gap-3 shrink-0">
            <button
              type="button"
              onClick={() => setSelectedCandidate(null)}
              className="px-4 py-2 text-stone-600 hover:bg-stone-100 rounded-xl text-xs font-bold"
            >
              رجوع لاختيار زميل آخر
            </button>

            <button
              type="button"
              onClick={handleSubmitAttempt}
              disabled={submitting || loadingQuestions}
              className="px-6 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-xs shadow-xs transition flex items-center gap-2 cursor-pointer disabled:opacity-50"
            >
              <CheckCircle2 className="w-4 h-4 text-amber-300" />
              <span>{submitting ? 'جاري الإرسال...' : 'إرسال واعتماد نتيجة الاختبار'}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
