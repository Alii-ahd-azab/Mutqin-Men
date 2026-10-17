import React, { useState, useEffect } from 'react';
import { User, TestDefinition, TestAttempt, TestQuestion } from '../types';
import { api } from '../api/client';
import {
  Award,
  Plus,
  Play,
  Pause,
  AlertCircle,
  CheckCircle2,
  XCircle,
  HelpCircle,
  Settings,
  History,
  Clock,
  Sparkles,
  Eye,
  Users,
  Search,
  BookOpen,
  AlertTriangle,
  StopCircle,
  Edit,
} from 'lucide-react';

interface AdminTestsTabProps {
  tests: TestDefinition[];
  activeTest: TestDefinition | null;
  members: User[];
  onRefresh: () => void;
}

export const AdminTestsTab: React.FC<AdminTestsTabProps> = ({
  tests,
  activeTest,
  members,
  onRefresh,
}) => {
  const [subTab, setSubTab] = useState<'current' | 'history'>('current');
  const [loading, setLoading] = useState(false);
  const [actionMsg, setActionMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Form state for creating/editing test
  const [title, setTitle] = useState<string>(activeTest?.title || '');
  const [rangeStart, setRangeStart] = useState<number>(activeTest?.range_start || 1);
  const [rangeEnd, setRangeEnd] = useState<number>(activeTest?.range_end || 240);
  const [questionsCount, setQuestionsCount] = useState<number>(activeTest?.questions_count || 5);
  const [linesPerQuestion, setLinesPerQuestion] = useState<number>(activeTest?.lines_per_question || 8);
  const [reqAllQuarters, setReqAllQuarters] = useState<boolean>(
    activeTest?.prerequisites.require_all_quarters_completed ?? true
  );
  const [reqRevision, setReqRevision] = useState<boolean>(
    activeTest?.prerequisites.require_revision_completed ?? true
  );
  const [hasMaxErrors, setHasMaxErrors] = useState<boolean>(activeTest?.has_max_errors ?? true);
  const [maxErrors, setMaxErrors] = useState<number>(activeTest?.max_errors_allowed ?? 3);
  const [testType, setTestType] = useState<'mandatory' | 'recommended'>(
    activeTest?.test_type || 'mandatory'
  );
  const [audience, setAudience] = useState<'all' | 'selected'>(
    activeTest?.audience || 'selected'
  );
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>(
    activeTest?.selected_member_ids || []
  );
  const [difficulty, setDifficulty] = useState<'any' | 'easy' | 'medium' | 'hard' | 'mixed'>(
    activeTest?.difficulty || 'any'
  );
  const [memberSearchQuery, setMemberSearchQuery] = useState('');
  const [isActive, setIsActive] = useState<boolean>(activeTest?.is_active ?? true);

  // Confirmation modal for status change
  const [confirmTestToToggle, setConfirmTestToToggle] = useState<TestDefinition | null>(null);
  const [impactLoading, setImpactLoading] = useState(false);
  const [impactData, setImpactData] = useState<{
    blocked_count: number;
    blocked_members: { id: string; name: string }[];
  } | null>(null);
  const [impactError, setImpactError] = useState(false);

  // Permanent Finish confirmation modal state
  const [confirmTestToFinish, setConfirmTestToFinish] = useState<TestDefinition | null>(null);
  const [finishLoading, setFinishLoading] = useState(false);

  // Preview Modal state
  const [previewModalOpen, setPreviewModalOpen] = useState(false);
  const [previewQuestions, setPreviewQuestions] = useState<TestQuestion[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');

  // History attempts
  const [attempts, setAttempts] = useState<TestAttempt[]>([]);
  const [attemptsLoading, setAttemptsLoading] = useState(false);

  useEffect(() => {
    if (activeTest) {
      setTitle(activeTest.title || '');
      setRangeStart(activeTest.range_start);
      setRangeEnd(activeTest.range_end);
      setQuestionsCount(activeTest.questions_count);
      setLinesPerQuestion(activeTest.lines_per_question);
      setReqAllQuarters(activeTest.prerequisites.require_all_quarters_completed);
      setReqRevision(activeTest.prerequisites.require_revision_completed);
      setHasMaxErrors(activeTest.has_max_errors);
      setMaxErrors(activeTest.max_errors_allowed ?? 3);
      setTestType(activeTest.test_type);
      setAudience(activeTest.audience || 'selected');
      setSelectedMemberIds(activeTest.selected_member_ids || []);
      setDifficulty(activeTest.difficulty || 'any');
      setIsActive(activeTest.is_active);
    }
  }, [activeTest]);

  useEffect(() => {
    loadAttempts();
  }, []);

  const loadAttempts = async () => {
    setAttemptsLoading(true);
    try {
      const res = await api.getTestAttempts();
      setAttempts(res.attempts || []);
    } catch (err: any) {
      console.error(err);
    } finally {
      setAttemptsLoading(false);
    }
  };

  const hasPriorAttempts = activeTest
    ? attempts.some((a) => a.test_id === activeTest.id)
    : false;

  const isMaterialFieldChanged = activeTest
    ? activeTest.range_start !== rangeStart ||
      activeTest.range_end !== rangeEnd ||
      activeTest.questions_count !== questionsCount ||
      activeTest.lines_per_question !== linesPerQuestion ||
      (activeTest.difficulty || 'any') !== difficulty
    : false;

  const handleSaveTest = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionMsg(null);

    if (rangeStart < 1 || rangeStart > 240 || rangeEnd < 1 || rangeEnd > 240) {
      setActionMsg({ type: 'error', text: 'نطاق الأرباع يجب أن يكون بين 1 و 240' });
      return;
    }
    if (rangeStart > rangeEnd) {
      setActionMsg({ type: 'error', text: 'بداية النطاق يجب أن تكون أقل من أو تساوي نهايته' });
      return;
    }
    if (questionsCount < 1 || questionsCount > 50) {
      setActionMsg({ type: 'error', text: 'عدد الأسئلة يجب أن يكون بين 1 و 50' });
      return;
    }
    if (linesPerQuestion < 1 || linesPerQuestion > 60) {
      setActionMsg({ type: 'error', text: 'عدد الأسطر لكل سؤال يجب أن يكون بين 1 و 60' });
      return;
    }
    if (hasMaxErrors && (maxErrors < 0 || maxErrors > 100)) {
      setActionMsg({ type: 'error', text: 'الحد الأقصى للأخطاء يجب أن يكون بين 0 و 100' });
      return;
    }
    if (audience === 'selected' && selectedMemberIds.length === 0) {
      setActionMsg({
        type: 'error',
        text: 'لقد اخترت جمهور الاختبار (أعضاء مختارون)، يرجى تحديد عضو واحد على الأقل أو تحويل الخيار إلى (كل الأعضاء).',
      });
      return;
    }

    setLoading(true);
    try {
      const isMandatoryActivation =
        testType === 'mandatory' &&
        isActive &&
        (!activeTest || !activeTest.is_active || isMaterialFieldChanged);

      const payload: Partial<TestDefinition> = {
        id: activeTest?.id,
        title: title ? title.trim().slice(0, 120) : undefined,
        range_start: Number(rangeStart),
        range_end: Number(rangeEnd),
        questions_count: Number(questionsCount),
        lines_per_question: Number(linesPerQuestion),
        prerequisites: {
          require_all_quarters_completed: reqAllQuarters,
          require_revision_completed: reqRevision,
        },
        has_max_errors: hasMaxErrors,
        max_errors_allowed: hasMaxErrors ? Number(maxErrors) : undefined,
        test_type: testType,
        difficulty,
        audience,
        selected_member_ids: audience === 'selected' ? selectedMemberIds : [],
        is_active: isMandatoryActivation ? false : isActive,
      };

      const res = await api.adminSaveTest(payload);

      if (isMandatoryActivation && res.test) {
        try {
          const impact = await api.adminGetTestImpact(res.test.id);
          if (impact.blocked_count > 0) {
            setConfirmTestToToggle(res.test);
            setImpactData(impact);
            setImpactError(false);
            setImpactLoading(false);
            setActionMsg({
              type: 'success',
              text: 'تم حفظ الاختبار. يرجى تأكيد التفعيل نظراً لوجود أعضاء سيتأثرون به فوراً.',
            });
            onRefresh();
            loadAttempts();
            return;
          } else {
            // blocked_count === 0, activate immediately as requested
            await api.adminToggleTestStatus(res.test.id, true);
            setActionMsg({ type: 'success', text: res.message || 'تم حفظ ونشر الاختبار بنجاح' });
            onRefresh();
            loadAttempts();
            return;
          }
        } catch (impactErr) {
          console.error('Failed to get test impact:', impactErr);
          setConfirmTestToToggle(res.test);
          setImpactData(null);
          setImpactError(true);
          setImpactLoading(false);
          setActionMsg({
            type: 'success',
            text: 'تم حفظ الاختبار كغير مفعّل. تعذّر حساب عدد الأعضاء المتأثرين، يرجى تأكيد قرار التفعيل.',
          });
          onRefresh();
          loadAttempts();
          return;
        }
      }

      setActionMsg({ type: 'success', text: res.message || 'تم حفظ ونشر الاختبار بنجاح' });
      onRefresh();
      loadAttempts();
    } catch (err: any) {
      setActionMsg({ type: 'error', text: err?.message || 'فشل حفظ الاختبار' });
    } finally {
      setLoading(false);
    }
  };

  const handleOpenPreview = async (testIdToPreview?: string) => {
    const targetId = testIdToPreview || activeTest?.id;
    if (!targetId) {
      setActionMsg({ type: 'error', text: 'يرجى حفظ الاختبار أولاً لتتمكن من معاينة أسئلته' });
      return;
    }

    setPreviewModalOpen(true);
    setPreviewLoading(true);
    setPreviewError('');
    setPreviewQuestions([]);

    try {
      const res = await api.adminPreviewTestQuestions(targetId);
      setPreviewQuestions(res.questions || []);
    } catch (err: any) {
      setPreviewError(err?.message || 'تعذر توليد أسئلة المعاينة');
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleRequestToggle = async (testToToggle: TestDefinition) => {
    setConfirmTestToToggle(testToToggle);
    setImpactData(null);
    setImpactError(false);

    const nextStatus = !testToToggle.is_active;
    if (nextStatus && testToToggle.test_type === 'mandatory') {
      setImpactLoading(true);
      try {
        const impact = await api.adminGetTestImpact(testToToggle.id);
        setImpactData(impact);
      } catch (err) {
        console.error('Failed to get test impact:', err);
        setImpactError(true);
      } finally {
        setImpactLoading(false);
      }
    } else {
      setImpactLoading(false);
    }
  };

  const handleConfirmToggle = async () => {
    if (!confirmTestToToggle) return;
    setLoading(true);
    try {
      const nextStatus = !confirmTestToToggle.is_active;
      await api.adminToggleTestStatus(confirmTestToToggle.id, nextStatus);
      setConfirmTestToToggle(null);
      setImpactData(null);
      setImpactError(false);
      setActionMsg({
        type: 'success',
        text: nextStatus ? 'تم استئناف الاختبار بنجاح' : 'تم إيقاف الاختبار مؤقتًا بنجاح',
      });
      onRefresh();
    } catch (err: any) {
      setActionMsg({ type: 'error', text: err?.message || 'فشل تعديل حالة الاختبار' });
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmFinish = async () => {
    if (!confirmTestToFinish) return;
    setFinishLoading(true);
    try {
      const res = await api.adminFinishTest(confirmTestToFinish.id);
      setConfirmTestToFinish(null);
      setActionMsg({
        type: 'success',
        text: res.message || 'تم إنهاء الاختبار نهائيًا بنجاح',
      });
      onRefresh();
      loadAttempts();
    } catch (err: any) {
      setActionMsg({ type: 'error', text: err?.message || 'فشل إنهاء الاختبار نهائيًا' });
    } finally {
      setFinishLoading(false);
    }
  };

  const handleEditTest = (testToEdit: TestDefinition) => {
    if (testToEdit.is_finished) return;
    setTitle(testToEdit.title || '');
    setRangeStart(testToEdit.range_start);
    setRangeEnd(testToEdit.range_end);
    setQuestionsCount(testToEdit.questions_count);
    setLinesPerQuestion(testToEdit.lines_per_question);
    setReqAllQuarters(testToEdit.prerequisites.require_all_quarters_completed);
    setReqRevision(testToEdit.prerequisites.require_revision_completed);
    setHasMaxErrors(testToEdit.has_max_errors);
    setMaxErrors(testToEdit.max_errors_allowed ?? 3);
    setTestType(testToEdit.test_type);
    setAudience(testToEdit.audience || 'selected');
    setSelectedMemberIds(testToEdit.selected_member_ids || []);
    setDifficulty(testToEdit.difficulty || 'any');
    setIsActive(testToEdit.is_active);
    setSubTab('current');
  };

  // Toggle member in selected list
  const toggleMemberSelection = (id: string) => {
    setSelectedMemberIds((prev) =>
      prev.includes(id) ? prev.filter((mId) => mId !== id) : [...prev, id]
    );
  };

  const selectAllMembers = () => {
    setSelectedMemberIds(members.map((m) => m.id));
  };

  const clearAllSelectedMembers = () => {
    setSelectedMemberIds([]);
  };

  // Filter members by search query
  const filteredMembers = members.filter((m) => {
    if (!memberSearchQuery.trim()) return true;
    const q = memberSearchQuery.toLowerCase().trim();
    return m.name.toLowerCase().includes(q) || (m.phone && m.phone.includes(q));
  });

  return (
    <div className="space-y-6">
      {/* Sub Tabs */}
      <div className="flex bg-stone-100 p-1 rounded-2xl gap-1 text-xs font-bold border border-stone-200 max-w-md">
        <button
          onClick={() => setSubTab('current')}
          className={`flex-1 py-2 px-3 rounded-xl flex items-center justify-center gap-1.5 transition ${
            subTab === 'current'
              ? 'bg-white text-emerald-900 shadow-xs border border-stone-200'
              : 'text-stone-600 hover:text-stone-900'
          }`}
        >
          <Settings className="w-3.5 h-3.5 text-emerald-700" />
          <span>إعداد الاختبار النشط</span>
        </button>

        <button
          onClick={() => setSubTab('history')}
          className={`flex-1 py-2 px-3 rounded-xl flex items-center justify-center gap-1.5 transition ${
            subTab === 'history'
              ? 'bg-white text-emerald-900 shadow-xs border border-stone-200'
              : 'text-stone-600 hover:text-stone-900'
          }`}
        >
          <History className="w-3.5 h-3.5 text-emerald-700" />
          <span>سجل الاختبارات والنتائج ({tests.length})</span>
        </button>
      </div>

      {actionMsg && (
        <div
          className={`p-4 rounded-2xl text-xs font-bold border flex items-center gap-2 ${
            actionMsg.type === 'success'
              ? 'bg-emerald-50 text-emerald-900 border-emerald-200'
              : 'bg-rose-50 text-rose-900 border-rose-200'
          }`}
        >
          {actionMsg.type === 'success' ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
          ) : (
            <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
          )}
          <span>{actionMsg.text}</span>
        </div>
      )}

      {subTab === 'current' && (
        <div className="bg-white rounded-3xl border border-stone-200 p-6 shadow-2xs space-y-6">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="p-2 rounded-xl bg-amber-100 text-amber-800">
                  <Award className="w-5 h-5" />
                </span>
                <h3 className="font-bold text-lg text-stone-900">
                  نظام اختبارات الأعضاء لبعضهم (Peer Testing)
                </h3>
              </div>
              <p className="text-xs text-stone-500 leading-relaxed max-w-2xl">
                يحدد المشرف شروط ونطاق الاختبار والجمهور المسموح له بالمشاركة، ويقوم الأعضاء باختبار بعضهم البعض وتوليد الأسئلة تلقائيًا وفق أسطر مصحف المدينة.
              </p>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              {activeTest && (
                <>
                  <button
                    type="button"
                    onClick={() => handleOpenPreview(activeTest.id)}
                    className="px-3.5 py-2 rounded-xl text-xs font-bold transition flex items-center gap-1.5 cursor-pointer bg-stone-100 hover:bg-stone-200 text-stone-800 border border-stone-200 shadow-2xs"
                  >
                    <Eye className="w-3.5 h-3.5 text-emerald-700" />
                    <span>معاينة الأسئلة</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleRequestToggle(activeTest)}
                    className={`px-3.5 py-2 rounded-xl text-xs font-bold transition flex items-center gap-1.5 cursor-pointer ${
                      activeTest.is_active
                        ? 'bg-orange-100 text-orange-900 hover:bg-orange-200 border border-orange-200'
                        : 'bg-emerald-100 text-emerald-900 hover:bg-emerald-200 border border-emerald-200'
                    }`}
                  >
                    {activeTest.is_active ? (
                      <>
                        <Pause className="w-3.5 h-3.5 text-orange-700" />
                        <span>إيقاف مؤقت</span>
                      </>
                    ) : (
                      <>
                        <Play className="w-3.5 h-3.5 text-emerald-700" />
                        <span>استئناف</span>
                      </>
                    )}
                  </button>

                  {!activeTest.is_finished && (
                    <button
                      type="button"
                      onClick={() => setConfirmTestToFinish(activeTest)}
                      className="px-3.5 py-2 rounded-xl text-xs font-bold transition flex items-center gap-1.5 cursor-pointer bg-rose-50 text-rose-800 hover:bg-rose-100 border border-rose-200 shadow-2xs"
                    >
                      <StopCircle className="w-3.5 h-3.5 text-rose-700" />
                      <span>إنهاء الاختبار نهائيًا</span>
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Warning notice when editing test with prior attempts */}
          {hasPriorAttempts && isMaterialFieldChanged && (
            <div className="p-4 rounded-2xl bg-amber-500/10 border-2 border-amber-500/40 text-amber-950 text-xs flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-800 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <span className="font-bold block">تنبيه: الاختبار يحتوي على محاولات مسجلة سابقاً</span>
                <p className="text-[11px] text-amber-900 leading-relaxed">
                  تعديلك الحالي للنطاق أو عدد الأسئلة أو الأسطر سيؤدي تلقائياً إلى حفظ الاختبار كـ{' '}
                  <strong>اختبار جديد</strong> وأرشفة الاختبار السابق، وذلك للحفاظ على نزاهة وصحة سجل المحاولات السابقة.
                </p>
              </div>
            </div>
          )}

          <form onSubmit={handleSaveTest} className="space-y-6 pt-2">
            {/* Title */}
            <div>
              <label className="block text-xs font-bold text-stone-700 mb-1">
                عنوان الاختبار (اختياري)
              </label>
              <input
                type="text"
                maxLength={120}
                placeholder={`اختبار الأرباع (${rangeStart} - ${rangeEnd})`}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full px-3.5 py-2 text-xs border border-stone-200 rounded-xl bg-white outline-hidden focus:border-emerald-600"
              />
            </div>

            {/* 1. Audience (من يرى الاختبار) — أولوية مرحلة تجريبية */}
            <div className="p-4 rounded-2xl bg-stone-50 border border-stone-200/80 space-y-3">
              <h4 className="font-bold text-xs text-stone-800 flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-emerald-800 text-white text-[10px] flex items-center justify-center">1</span>
                <span>من يرى الاختبار (الجمهور المستهدف)</span>
              </h4>

              <div className="space-y-3">
                <div className="flex flex-col sm:flex-row gap-3">
                  <label
                    className={`flex-1 p-3.5 rounded-2xl border cursor-pointer transition flex items-start gap-3 ${
                      audience === 'selected'
                        ? 'bg-emerald-50/50 border-emerald-500 text-emerald-950 shadow-2xs'
                        : 'bg-white border-stone-200 text-stone-700 hover:border-stone-300'
                    }`}
                  >
                    <input
                      type="radio"
                      name="audience_choice"
                      value="selected"
                      checked={audience === 'selected'}
                      onChange={() => setAudience('selected')}
                      className="text-emerald-700 accent-emerald-700 mt-0.5"
                    />
                    <div className="space-y-0.5">
                      <span className="text-xs font-bold block">
                        أعضاء مختارون فقط (مرحلة تجريبية)
                      </span>
                      <span className="text-[11px] text-stone-500 block leading-relaxed">
                        يظهر الاختبار للأعضاء المحددين أدناه فقط، ولن يراه باقي الأعضاء إطلاقاً.
                      </span>
                    </div>
                  </label>

                  <label
                    className={`flex-1 p-3.5 rounded-2xl border cursor-pointer transition flex items-start gap-3 ${
                      audience === 'all'
                        ? 'bg-emerald-50/50 border-emerald-500 text-emerald-950 shadow-2xs'
                        : 'bg-white border-stone-200 text-stone-700 hover:border-stone-300'
                    }`}
                  >
                    <input
                      type="radio"
                      name="audience_choice"
                      value="all"
                      checked={audience === 'all'}
                      onChange={() => setAudience('all')}
                      className="text-emerald-700 accent-emerald-700 mt-0.5"
                    />
                    <div className="space-y-0.5">
                      <span className="text-xs font-bold block">
                        كل الأعضاء (نشر عام)
                      </span>
                      <span className="text-[11px] text-stone-500 block leading-relaxed">
                        يتاح الاختبار لجميع أعضاء المقرأة المستوفين لشروط الحفظ والمراجعة.
                      </span>
                    </div>
                  </label>
                </div>

                {/* Helper text */}
                <p className="text-[11px] text-amber-800 bg-amber-50/80 p-2.5 rounded-xl border border-amber-200/80">
                  💡 <strong>نصيحة للمشرف:</strong> ابدأ بـ 2–3 أعضاء موثوقين لتجربة الميزة والتأكد من انضباط النتائج، ثم حوّلها إلى كل الأعضاء عند الاطمئنان.
                </p>

                {/* Selected members list when audience === 'selected' */}
                {audience === 'selected' && (
                  <div className="p-4 rounded-2xl bg-white border border-stone-200 space-y-3">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-2">
                        <Users className="w-4 h-4 text-emerald-700" />
                        <span className="text-xs font-bold text-stone-800">
                          قائمة الأعضاء المخولين ({selectedMemberIds.length} من {members.length})
                        </span>
                      </div>

                      <div className="flex items-center gap-2 text-xs">
                        <button
                          type="button"
                          onClick={selectAllMembers}
                          className="text-emerald-700 hover:underline font-bold"
                        >
                          تحديد الكل
                        </button>
                        <span className="text-stone-300">•</span>
                        <button
                          type="button"
                          onClick={clearAllSelectedMembers}
                          className="text-stone-500 hover:underline font-bold"
                        >
                          إلغاء التحديد
                        </button>
                      </div>
                    </div>

                    {/* Member search */}
                    <div className="relative">
                      <Search className="w-3.5 h-3.5 text-stone-400 absolute right-3 top-2.5" />
                      <input
                        type="text"
                        value={memberSearchQuery}
                        onChange={(e) => setMemberSearchQuery(e.target.value)}
                        placeholder="بحث في أسماء الأعضاء..."
                        className="w-full pl-3 pr-8 py-1.5 text-xs border border-stone-200 rounded-xl bg-stone-50 outline-hidden focus:border-emerald-600"
                      />
                    </div>

                    {/* Member checkboxes */}
                    <div className="max-h-48 overflow-y-auto space-y-1 pr-1 border border-stone-100 rounded-xl p-2 bg-stone-50/40">
                      {filteredMembers.length === 0 ? (
                        <p className="text-[11px] text-stone-400 py-3 text-center">
                          لا توجد نتائج مطابقة للبحث
                        </p>
                      ) : (
                        filteredMembers.map((m) => {
                          const isSelected = selectedMemberIds.includes(m.id);
                          return (
                            <label
                              key={m.id}
                              className={`flex items-center justify-between p-2 rounded-xl border text-xs cursor-pointer transition ${
                                isSelected
                                  ? 'bg-emerald-50/80 border-emerald-300 text-emerald-950 font-bold'
                                  : 'bg-white border-stone-200/80 text-stone-700 hover:bg-stone-50'
                              }`}
                            >
                              <div className="flex items-center gap-2.5">
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={() => toggleMemberSelection(m.id)}
                                  className="w-4 h-4 rounded text-emerald-700 accent-emerald-700"
                                />
                                <span>{m.name}</span>
                              </div>
                              <span className="text-[10px] text-stone-400 font-mono">
                                {m.phone}
                              </span>
                            </label>
                          );
                        })
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* 2. Range */}
            <div className="p-4 rounded-2xl bg-stone-50 border border-stone-200/80 space-y-3">
              <h4 className="font-bold text-xs text-stone-800 flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-emerald-800 text-white text-[10px] flex items-center justify-center">2</span>
                <span>نطاق الاختبار (بالأرباع 1 إلى 240)</span>
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[11px] font-bold text-stone-600 mb-1">
                    من الربع رقم
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="240"
                    value={rangeStart}
                    onChange={(e) => setRangeStart(parseInt(e.target.value) || 1)}
                    className="w-full px-3 py-2 text-xs border border-stone-200 rounded-xl bg-white outline-hidden focus:border-emerald-600"
                    required
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-bold text-stone-600 mb-1">
                    إلى الربع رقم
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="240"
                    value={rangeEnd}
                    onChange={(e) => setRangeEnd(parseInt(e.target.value) || 240)}
                    className="w-full px-3 py-2 text-xs border border-stone-200 rounded-xl bg-white outline-hidden focus:border-emerald-600"
                    required
                  />
                </div>
              </div>
              <p className="text-[11px] text-stone-500">
                إجمالي الأرباع المشمولة في هذا النطاق: <strong>{Math.max(0, rangeEnd - rangeStart + 1)} ربعًا</strong>
              </p>
            </div>

            {/* 3. Questions & Lines */}
            <div className="p-4 rounded-2xl bg-stone-50 border border-stone-200/80 space-y-3">
              <h4 className="font-bold text-xs text-stone-800 flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-emerald-800 text-white text-[10px] flex items-center justify-center">3</span>
                <span>عدد الأسئلة وحجم السؤال</span>
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[11px] font-bold text-stone-600 mb-1">
                    عدد الأسئلة في الاختبار (1 إلى 50)
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="50"
                    value={questionsCount}
                    onChange={(e) => setQuestionsCount(parseInt(e.target.value) || 1)}
                    className="w-full px-3 py-2 text-xs border border-stone-200 rounded-xl bg-white outline-hidden focus:border-emerald-600"
                    required
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-bold text-stone-600 mb-1">
                    حجم السؤال بالأسطر (1 إلى 60 سطرًا - مصحف المدينة 15 سطرًا/صفحة)
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="60"
                    value={linesPerQuestion}
                    onChange={(e) => setLinesPerQuestion(parseInt(e.target.value) || 1)}
                    className="w-full px-3 py-2 text-xs border border-stone-200 rounded-xl bg-white outline-hidden focus:border-emerald-600"
                    required
                  />
                  <p className="text-[10px] text-stone-400 mt-1">
                    مثال: 15 سطرًا يعادل صفحة كاملة تقريبًا.
                  </p>
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-stone-600 mb-1">
                  مستوى الصعوبة
                </label>
                <select
                  value={difficulty}
                  onChange={(e) => setDifficulty(e.target.value as any)}
                  className="w-full px-3 py-2 text-xs border border-stone-200 rounded-xl bg-white outline-hidden focus:border-emerald-600"
                >
                  <option value="any">عشوائي (any)</option>
                  <option value="easy">سهل</option>
                  <option value="medium">متوسط</option>
                  <option value="hard">صعب</option>
                  <option value="mixed">متنوع (mixed)</option>
                </select>
                <p className="text-[10px] text-stone-500 mt-1">
                  يُحسب تلقائيًا من تشابه الآيات في المصحف، وليس بالذكاء الاصطناعي وقت التشغيل.
                </p>
              </div>
            </div>

            {/* 4. Prerequisites */}
            <div className="p-4 rounded-2xl bg-stone-50 border border-stone-200/80 space-y-3">
              <h4 className="font-bold text-xs text-stone-800 flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-emerald-800 text-white text-[10px] flex items-center justify-center">4</span>
                <span>الشروط المسبقة لأهلية العضو للاختبار</span>
              </h4>
              <div className="space-y-2.5">
                <label className="flex items-start gap-3 p-3 rounded-xl bg-white border border-stone-200 cursor-pointer hover:border-emerald-500 transition">
                  <input
                    type="checkbox"
                    checked={reqAllQuarters}
                    onChange={(e) => setReqAllQuarters(e.target.checked)}
                    className="w-4 h-4 rounded text-emerald-700 accent-emerald-700 mt-0.5"
                  />
                  <div>
                    <span className="text-xs font-bold text-stone-900 block">
                      إتمام جميع أرباع نطاق الاختبار
                    </span>
                    <span className="text-[11px] text-stone-500">
                      مفعّل: لا يُختبر العضو إلا بعد أن يكون قد سمّع كل أرباع النطاق (الربع {rangeStart} إلى {rangeEnd})، ويحق له الاختبار مهما بلغ ربع اليوم. معطّل: يُختبر فيما أتمّه من النطاق فقط.
                    </span>
                  </div>
                </label>

                <label className="flex items-start gap-3 p-3 rounded-xl bg-white border border-stone-200 cursor-pointer hover:border-emerald-500 transition">
                  <input
                    type="checkbox"
                    checked={reqRevision}
                    onChange={(e) => setReqRevision(e.target.checked)}
                    className="w-4 h-4 rounded text-emerald-700 accent-emerald-700 mt-0.5"
                  />
                  <div>
                    <span className="text-xs font-bold text-stone-900 block">
                      إتمام المراجعة
                    </span>
                    <span className="text-[11px] text-stone-500">
                      يُشترط ألا يكون لدى العضو أي مراجعة فائتة، وأن يكون قد أكّد مراجعة اليوم.
                    </span>
                  </div>
                </label>
              </div>
            </div>

            {/* 5. Error Limits & Test Type */}
            <div className="p-4 rounded-2xl bg-stone-50 border border-stone-200/80 space-y-3">
              <h4 className="font-bold text-xs text-stone-800 flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-emerald-800 text-white text-[10px] flex items-center justify-center">5</span>
                <span>حد الأخطاء ونوع الاختبار</span>
              </h4>

              <div className="space-y-3">
                <div className="p-3 rounded-xl bg-white border border-stone-200 space-y-2">
                  <label className="flex items-center gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={hasMaxErrors}
                      onChange={(e) => setHasMaxErrors(e.target.checked)}
                      className="w-4 h-4 rounded text-emerald-700 accent-emerald-700"
                    />
                    <span className="text-xs font-bold text-stone-900">
                      تحديد حد أقصى للأخطاء المسموحة للاجتياز
                    </span>
                  </label>

                  {hasMaxErrors && (
                    <div className="pt-2 border-t border-stone-100 flex items-center gap-3">
                      <label className="text-[11px] font-bold text-stone-600">
                        الحد الأقصى الإجمالي للأخطاء (0 إلى 100):
                      </label>
                      <input
                        type="number"
                        min="0"
                        max="100"
                        value={maxErrors}
                        onChange={(e) => setMaxErrors(parseInt(e.target.value) || 0)}
                        className="w-24 px-3 py-1.5 text-xs border border-stone-200 rounded-xl bg-stone-50 outline-hidden font-bold"
                      />
                      <span className="text-[11px] text-stone-400">
                        (إذا زادت أخطاء العضو عن هذا الرقم يُعتبر راسبًا)
                      </span>
                    </div>
                  )}
                </div>

                <div className="p-3 rounded-xl bg-white border border-stone-200 space-y-2">
                  <label className="block text-[11px] font-bold text-stone-700 mb-1">
                    تصنيف الاختبار:
                  </label>
                  <div className="flex gap-4">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="test_type"
                        value="mandatory"
                        checked={testType === 'mandatory'}
                        onChange={() => setTestType('mandatory')}
                        className="text-emerald-700 accent-emerald-700"
                      />
                      <span className="text-xs font-bold text-rose-900">
                        إلزامي لمواصلة التسميع (القسم هـ)
                      </span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="test_type"
                        value="recommended"
                        checked={testType === 'recommended'}
                        onChange={() => setTestType('recommended')}
                        className="text-emerald-700 accent-emerald-700"
                      />
                      <span className="text-xs font-medium text-stone-700">
                        موصى به فقط
                      </span>
                    </label>
                  </div>
                </div>

                <div className="p-3 rounded-xl bg-white border border-stone-200">
                  <label className="flex items-center gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={isActive}
                      onChange={(e) => setIsActive(e.target.checked)}
                      className="w-4 h-4 rounded text-emerald-700 accent-emerald-700"
                    />
                    <span className="text-xs font-bold text-stone-900">
                      تفعيل الاختبار وإتاحته فورًا للجمهور المحدد
                    </span>
                  </label>
                </div>
              </div>
            </div>

            <div className="pt-2 flex items-center justify-between gap-3">
              {activeTest && (
                <button
                  type="button"
                  onClick={() => handleOpenPreview(activeTest.id)}
                  className="px-4 py-2.5 rounded-xl border border-stone-200 text-stone-700 hover:bg-stone-50 text-xs font-bold transition flex items-center gap-2 cursor-pointer"
                >
                  <Eye className="w-4 h-4 text-emerald-700" />
                  <span>معاينة الأسئلة قبل النشر</span>
                </button>
              )}

              <button
                type="submit"
                disabled={loading}
                className="mr-auto px-6 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold transition flex items-center gap-2 shadow-xs cursor-pointer disabled:opacity-50"
              >
                <Sparkles className="w-4 h-4 text-amber-300" />
                <span>{activeTest ? 'حفظ تعديلات الاختبار' : 'إنشاء ونشر الاختبار'}</span>
              </button>
            </div>
          </form>
        </div>
      )}

      {subTab === 'history' && (
        <div className="space-y-6">
          {/* Tests Registry List */}
          <div className="bg-white rounded-3xl border border-stone-200 p-6 shadow-2xs space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-base text-stone-900 flex items-center gap-2">
                <Award className="w-5 h-5 text-emerald-700" />
                <span>سجل الاختبارات ({tests.length})</span>
              </h3>
            </div>

            {tests.length === 0 ? (
              <p className="text-xs text-stone-400 py-4 text-center">لا توجد اختبارات مسجلة حتى الآن.</p>
            ) : (
              <div className="divide-y divide-stone-100 border border-stone-200 rounded-2xl overflow-hidden">
                {tests.map((t) => {
                  const isFinished = !!t.is_finished;
                  const testAttemptsCount = attempts.filter((a) => a.test_id === t.id).length;

                  return (
                    <div
                      key={t.id}
                      className="p-4 flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs bg-white hover:bg-stone-50/50 transition"
                    >
                      <div className="space-y-1.5 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-bold text-stone-900 text-sm">
                            {t.title || `اختبار الأرباع (${t.range_start} - ${t.range_end})`}
                          </span>

                          {/* Status Badge */}
                          {isFinished ? (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-stone-100 text-stone-700 font-bold border border-stone-300 text-[11px]">
                              <CheckCircle2 className="w-3.5 h-3.5 text-stone-500" />
                              <span>منتهٍ</span>
                              {t.finished_at && (
                                <span className="font-mono text-[10px] text-stone-500">
                                  ({t.finished_at.slice(0, 10)})
                                </span>
                              )}
                            </span>
                          ) : t.is_active ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-bold border border-emerald-200 text-[11px]">
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                              نشط حالياً
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-orange-100 text-orange-800 font-bold border border-orange-200 text-[11px]">
                              <Pause className="w-3 h-3 text-orange-600" />
                              متوقف مؤقتاً
                            </span>
                          )}

                          <span
                            className={`px-2 py-0.5 rounded-md font-bold text-[10px] ${
                              t.test_type === 'mandatory'
                                ? 'bg-rose-50 text-rose-700 border border-rose-100'
                                : 'bg-blue-50 text-blue-700 border border-blue-100'
                            }`}
                          >
                            {t.test_type === 'mandatory' ? 'إلزامي' : 'موصى به'}
                          </span>
                        </div>

                        <div className="text-[11px] text-stone-500 flex items-center gap-3 flex-wrap">
                          <span>
                            النطاق: <strong>الأرباع {t.range_start} إلى {t.range_end}</strong>
                          </span>
                          <span>• عدد الأسئلة: <strong>{t.questions_count}</strong></span>
                          <span>• المحاولات المسجلة: <strong>{testAttemptsCount}</strong></span>
                          {t.created_at && (
                            <span>
                              • تاريخ الإنشاء:{' '}
                              <span className="font-mono text-[10px]">{t.created_at.slice(0, 10)}</span>
                            </span>
                          )}
                          {isFinished && t.finished_at && (
                            <span className="text-stone-700 font-semibold">
                              • تاريخ الإنهاء:{' '}
                              <span className="font-mono text-[10px] text-stone-900">
                                {t.finished_at.slice(0, 10)}
                              </span>
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Action buttons: for finished tests, NO activate, edit, or finish buttons! */}
                      <div className="flex items-center gap-2 shrink-0">
                        {isFinished ? (
                          <span className="text-[11px] text-stone-400 font-medium px-2.5 py-1 bg-stone-50 rounded-xl border border-stone-200">
                            مغلق نهائياً ومحفوظ بالسجل
                          </span>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => handleRequestToggle(t)}
                              className={`px-3 py-1.5 rounded-xl font-bold transition flex items-center gap-1.5 text-xs cursor-pointer ${
                                t.is_active
                                  ? 'bg-orange-100 text-orange-900 hover:bg-orange-200 border border-orange-200'
                                  : 'bg-emerald-100 text-emerald-900 hover:bg-emerald-200 border border-emerald-200'
                              }`}
                            >
                              {t.is_active ? (
                                <>
                                  <Pause className="w-3.5 h-3.5 text-orange-700" />
                                  <span>إيقاف مؤقت</span>
                                </>
                              ) : (
                                <>
                                  <Play className="w-3.5 h-3.5 text-emerald-700" />
                                  <span>استئناف</span>
                                </>
                              )}
                            </button>

                            <button
                              type="button"
                              onClick={() => handleEditTest(t)}
                              className="px-3 py-1.5 rounded-xl font-bold transition flex items-center gap-1.5 text-xs cursor-pointer bg-stone-100 text-stone-700 hover:bg-stone-200 border border-stone-200"
                            >
                              <Edit className="w-3.5 h-3.5 text-stone-600" />
                              <span>تعديل</span>
                            </button>

                            <button
                              type="button"
                              onClick={() => setConfirmTestToFinish(t)}
                              className="px-3 py-1.5 rounded-xl font-bold transition flex items-center gap-1.5 text-xs cursor-pointer bg-rose-50 text-rose-800 hover:bg-rose-100 border border-rose-200"
                            >
                              <StopCircle className="w-3.5 h-3.5 text-rose-700" />
                              <span>إنهاء نهائي</span>
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Results and Attempts Log */}
          <div className="bg-white rounded-3xl border border-stone-200 p-6 shadow-2xs space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-base text-stone-900 flex items-center gap-2">
              <History className="w-5 h-5 text-emerald-700" />
              <span>نتائج وسجل الاختبارات المنفذة</span>
            </h3>
            <button
              onClick={loadAttempts}
              className="text-xs text-emerald-700 hover:underline font-bold"
            >
              تحديث النتائج
            </button>
          </div>

          {attemptsLoading ? (
            <p className="text-xs text-stone-400 py-6 text-center">جاري تحميل النتائج...</p>
          ) : attempts.length === 0 ? (
            <div className="py-12 text-center space-y-2">
              <Award className="w-8 h-8 text-stone-300 mx-auto" />
              <p className="text-xs text-stone-500 font-medium">لم يتم إجراء أي اختبارات حتى الآن.</p>
            </div>
          ) : (
            <div className="divide-y divide-stone-100 border border-stone-200 rounded-2xl overflow-hidden">
              {attempts.map((att) => (
                <div key={att.id} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-stone-900 text-sm">{att.candidate_name}</span>
                      <span className="text-stone-300">•</span>
                      <span className="text-stone-600">المختبِر: {att.examiner_name}</span>
                      <span className="text-stone-300">•</span>
                      <span className="text-stone-400 font-mono text-[11px]">{att.date}</span>
                    </div>
                    <div className="text-[11px] text-stone-500 flex items-center gap-3">
                      <span>إجمالي الأخطاء: <strong>{att.total_errors}</strong></span>
                      {att.notes && <span>• ملاحظات: "{att.notes}"</span>}
                    </div>
                  </div>

                  <div>
                    {att.passed ? (
                      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-100 text-emerald-800 font-bold border border-emerald-200 text-xs">
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                        اجتاز بنجاح
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-rose-100 text-rose-800 font-bold border border-rose-200 text-xs">
                        <XCircle className="w-3.5 h-3.5 text-rose-600" />
                        لم يجتز
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        </div>
      )}

      {/* Confirmation Modal for Toggle */}
      {confirmTestToToggle && (
        <div className="fixed inset-0 z-50 bg-stone-900/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl border border-stone-200 max-w-md w-full p-6 shadow-xl space-y-4 animate-in fade-in zoom-in-95">
            <div className="flex items-start gap-3">
              <div
                className={`w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 mt-0.5 ${
                  impactData && impactData.blocked_count > 0
                    ? 'bg-rose-100 text-rose-700'
                    : impactError
                    ? 'bg-amber-100 text-amber-700'
                    : 'bg-amber-100 text-amber-700'
                }`}
              >
                {impactData && impactData.blocked_count > 0 ? (
                  <AlertTriangle className="w-5 h-5 text-rose-700" />
                ) : (
                  <AlertCircle className="w-5 h-5 text-amber-700" />
                )}
              </div>
              <div className="space-y-1.5 flex-1">
                <h3 className="font-bold text-sm text-stone-900">
                  {confirmTestToToggle.is_active ? 'تأكيد إيقاف الاختبار مؤقتًا' : 'تأكيد استئناف الاختبار'}
                </h3>

                {impactLoading ? (
                  <p className="text-xs text-stone-500 py-1">
                    جاري فحص تأثير استئناف الاختبار على الأعضاء...
                  </p>
                ) : impactError ? (
                  <div className="space-y-1">
                    <p className="text-xs text-amber-900 font-bold bg-amber-50 p-2.5 rounded-xl border border-amber-200">
                      تعذّر حساب عدد الأعضاء المتأثرين
                    </p>
                    <p className="text-xs text-stone-600">
                      هل تريد المتابعة واستئناف هذا الاختبار على أي حال؟
                    </p>
                  </div>
                ) : impactData && impactData.blocked_count > 0 ? (
                  <div className="space-y-2 pt-0.5">
                    <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-950 text-xs leading-relaxed space-y-1.5">
                      <p className="font-bold">
                        سيُمنع {impactData.blocked_count} عضوًا فورًا من تسجيل التسميع:
                      </p>
                      <div className="max-h-28 overflow-y-auto bg-white/90 p-2 rounded-lg border border-rose-100 font-semibold text-rose-900 text-[11px] leading-relaxed">
                        ({impactData.blocked_members.map((m) => m.name).join('، ')})
                      </div>
                      <p className="font-bold pt-0.5 text-stone-800">
                        هل تريد المتابعة؟
                      </p>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-stone-500">
                    هل أنت متأكد من رغبتك في {confirmTestToToggle.is_active ? 'إيقاف هذا الاختبار مؤقتًا' : 'استئناف هذا الاختبار'}؟
                  </p>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => {
                  setConfirmTestToToggle(null);
                  setImpactData(null);
                  setImpactError(false);
                }}
                disabled={loading}
                className="px-4 py-2 rounded-xl text-stone-600 hover:bg-stone-100 text-xs font-bold cursor-pointer"
              >
                إلغاء
              </button>
              <button
                onClick={handleConfirmToggle}
                disabled={loading || impactLoading}
                className={`px-5 py-2 rounded-xl text-white text-xs font-bold shadow-xs cursor-pointer disabled:opacity-50 ${
                  impactData && impactData.blocked_count > 0
                    ? 'bg-rose-700 hover:bg-rose-800'
                    : 'bg-stone-900 hover:bg-black'
                }`}
              >
                {impactData && impactData.blocked_count > 0 ? 'نعم' : (confirmTestToToggle.is_active ? 'إيقاف مؤقت' : 'استئناف')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Modal for Permanent Finish */}
      {confirmTestToFinish && (
        <div className="fixed inset-0 z-50 bg-stone-900/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl border border-stone-200 max-w-md w-full p-6 shadow-xl space-y-4 animate-in fade-in zoom-in-95">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 mt-0.5 bg-rose-100 text-rose-700">
                <AlertTriangle className="w-5 h-5 text-rose-700" />
              </div>
              <div className="space-y-1.5 flex-1">
                <h3 className="font-bold text-sm text-stone-900">
                  تأكيد إنهاء الاختبار نهائيًا
                </h3>
                <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-950 text-xs leading-relaxed space-y-2">
                  <p className="font-medium text-[12px] leading-relaxed">
                    سيُغلق هذا الاختبار نهائيًا ولن يمكن إعادة تفعيله. يختفي من لوحات الأعضاء ويزول أي حجب إلزامي مرتبط به فورًا، وتبقى كل نتائجه ومحاولاته محفوظة في السجل. هل تريد المتابعة؟
                  </p>
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setConfirmTestToFinish(null)}
                disabled={finishLoading}
                className="px-4 py-2 rounded-xl text-stone-600 hover:bg-stone-100 text-xs font-bold cursor-pointer"
              >
                إلغاء
              </button>
              <button
                onClick={handleConfirmFinish}
                disabled={finishLoading}
                className="px-5 py-2 rounded-xl text-white text-xs font-bold shadow-xs cursor-pointer bg-rose-700 hover:bg-rose-800 disabled:opacity-50"
              >
                {finishLoading ? 'جاري الإنهاء...' : 'تأكيد الإنهاء النهائي'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Admin Question Preview Modal (Requirement أ.5) */}
      {previewModalOpen && (
        <div className="fixed inset-0 z-50 bg-stone-900/60 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-3xl border border-stone-200 max-w-2xl w-full p-6 shadow-2xl space-y-5 my-8 max-h-[90vh] flex flex-col">
            <div className="flex items-start justify-between gap-4 border-b border-stone-100 pb-4 shrink-0">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="p-2 rounded-xl bg-emerald-100 text-emerald-800">
                    <Eye className="w-5 h-5" />
                  </span>
                  <h3 className="font-bold text-lg text-stone-900">
                    معاينة عيّنة أسئلة الاختبار (شاشة المشرف)
                  </h3>
                </div>
                <p className="text-xs text-stone-500">
                  هذه المعاينة توضح شكل الأسئلة ونصوص الآيات التي ستظهر للزميل المُختبِر عند تقييم زميله دون حفظ أي سجل.
                </p>
              </div>

              <button
                onClick={() => setPreviewModalOpen(false)}
                className="p-2 text-stone-400 hover:text-stone-700 rounded-xl hover:bg-stone-100 transition cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="overflow-y-auto flex-1 space-y-4 pr-1">
              {previewLoading && (
                <div className="py-12 text-center text-xs text-stone-500">
                  جاري توليد نموذج الأسئلة وتحديد أسطر مصحف المدينة...
                </div>
              )}

              {previewError && (
                <div className="p-3.5 rounded-2xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-bold flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                  <span>{previewError}</span>
                </div>
              )}

              {!previewLoading && previewQuestions.length > 0 && (
                <div className="space-y-3">
                  {previewQuestions.map((q, idx) => (
                    <div
                      key={idx}
                      className="p-4 rounded-2xl border border-stone-200 bg-stone-50/60 space-y-3"
                    >
                      <div className="flex items-center justify-between gap-2 border-b border-stone-200/60 pb-2 flex-wrap">
                        <div className="flex items-center gap-2">
                          <span className="px-2.5 py-1 rounded-lg bg-emerald-800 text-white font-bold text-xs">
                            السؤال {q.question_number}
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
                              {typeof q.difficulty_score === 'number' ? ` (${q.difficulty_score}%)` : ''}
                            </span>
                          )}
                        </div>
                        <span className="text-[11px] font-bold text-stone-600">
                          الطول المستهدف: {q.target_lines} أسطر (الفعلي: {q.actual_lines || q.target_lines} سطرًا)
                        </span>
                      </div>

                      {/* Question details */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                        <div className="p-2.5 rounded-xl bg-white border border-stone-200/80 space-y-1">
                          <span className="text-[10px] font-bold text-emerald-800 uppercase block">
                            ابدأ من:
                          </span>
                          <p className="font-bold text-stone-900">
                            سورة {q.start_surah_name} — آية {q.start_ayah}
                          </p>
                          <p className="text-[11px] text-stone-500">
                            صفحة {q.start_page} • سطر {q.start_line}
                          </p>
                          <p className="text-[11px] text-stone-700 bg-stone-50 p-1.5 rounded-lg border border-stone-100 font-serif leading-relaxed line-clamp-2">
                            "{q.start_text}"
                          </p>
                        </div>

                        <div className="p-2.5 rounded-xl bg-white border border-stone-200/80 space-y-1">
                          <span className="text-[10px] font-bold text-amber-800 uppercase block">
                            توقف عند:
                          </span>
                          <p className="font-bold text-stone-900">
                            سورة {q.end_surah_name} — آية {q.end_ayah}
                          </p>
                          <p className="text-[11px] text-stone-500">
                            صفحة {q.end_page} • سطر {q.end_line}
                          </p>
                          <p className="text-[11px] text-stone-700 bg-stone-50 p-1.5 rounded-lg border border-stone-100 font-serif leading-relaxed line-clamp-2">
                            "{q.end_text}"
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="pt-2 border-t border-stone-100 flex items-center justify-between shrink-0">
              <button
                type="button"
                onClick={() => handleOpenPreview()}
                disabled={previewLoading}
                className="px-4 py-2 rounded-xl bg-stone-100 hover:bg-stone-200 text-stone-800 text-xs font-bold transition flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                <Sparkles className="w-3.5 h-3.5 text-emerald-700" />
                <span>توليد نموذج أسئلة آخر</span>
              </button>

              <button
                type="button"
                onClick={() => setPreviewModalOpen(false)}
                className="px-5 py-2 rounded-xl bg-stone-900 hover:bg-black text-white text-xs font-bold cursor-pointer"
              >
                إغلاق
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
