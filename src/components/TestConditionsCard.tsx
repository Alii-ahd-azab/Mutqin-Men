import React from 'react';
import {
  BookOpen,
  CheckCircle2,
  AlertCircle,
  HelpCircle,
  ShieldAlert,
  RefreshCw,
  Award,
  Layers,
  Sparkles,
  Info,
} from 'lucide-react';
import { TestDefinition } from '../types';
import { ALL_VERSES, getQuarterStartIndex, getQuarterEndIndex } from '../lib/testGenerator';

interface TestConditionsCardProps {
  test: TestDefinition;
  effectiveRangeEnd?: number;
  isPartial?: boolean;
  candidateName?: string;
  className?: string;
}

export const TestConditionsCard: React.FC<TestConditionsCardProps> = ({
  test,
  effectiveRangeEnd,
  isPartial,
  candidateName,
  className = '',
}) => {
  const startIdx = getQuarterStartIndex(test.range_start);
  const startVerse = ALL_VERSES[startIdx];

  const targetEnd = effectiveRangeEnd !== undefined ? effectiveRangeEnd : test.range_end;
  const actualIsPartial = Boolean(
    isPartial || (effectiveRangeEnd !== undefined && effectiveRangeEnd < test.range_end)
  );

  const endIdx = getQuarterEndIndex(targetEnd);
  const endVerse = ALL_VERSES[endIdx];

  const fullEndIdx = getQuarterEndIndex(test.range_end);
  const fullEndVerse = ALL_VERSES[fullEndIdx];

  const difficultyMap: Record<string, { label: string; desc: string }> = {
    any: { label: 'تلقائي / عشوائي', desc: 'توزيع عشوائي متوازن لمواضع الآيات' },
    easy: { label: 'سهل', desc: 'بدايات واضحة ومواضع ميسرة' },
    medium: { label: 'متوسط', desc: 'مواضع معتدلة وتفاوت في السياق' },
    hard: { label: 'صعب', desc: 'مواضع متشابهات وانتقالات دقيقة' },
    mixed: { label: 'متنوع', desc: 'مزيج متدرج بين السهل والمتوسط والصعب' },
  };

  const difficultyInfo = difficultyMap[test.difficulty || 'any'] || difficultyMap.any;

  return (
    <div
      className={`rounded-2xl bg-amber-50/60 border border-amber-200/90 p-4 text-xs text-stone-700 space-y-3.5 shadow-2xs ${className}`}
      dir="rtl"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-amber-200/60 pb-2.5">
        <div className="flex items-center gap-2">
          <Award className="w-4 h-4 text-amber-800" />
          <h4 className="font-bold text-sm text-stone-900">
            شروط الاختبار كما حدّدها المشرف
          </h4>
        </div>
        <span
          className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
            test.test_type === 'mandatory'
              ? 'bg-rose-100 text-rose-900 border-rose-300'
              : 'bg-emerald-100 text-emerald-900 border-emerald-300'
          }`}
        >
          {test.test_type === 'mandatory' ? 'اختبار إلزامي' : 'اختبار موصى به'}
        </span>
      </div>

      {/* Partial testing alert callout */}
      {actualIsPartial && (
        <div className="p-2.5 rounded-xl bg-amber-100/90 border border-amber-300/80 text-amber-950 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-amber-800 shrink-0 mt-0.5" />
          <div className="space-y-0.5">
            <span className="font-bold block">
              سيُختبر {candidateName ? `${candidateName} ` : ''}حتى الربع {targetEnd} فقط
            </span>
            <p className="text-[11px] text-amber-900/90 leading-relaxed">
              هذا اختبار جزئي لما أتمّه الزميل من النطاق (من الربع {test.range_start} إلى {targetEnd} من أصل {test.range_end}). اجتيازه لا يُعد نجاحًا نهائيًا ولا يرفع الحجب الإلزامي، ويمكن إعادة اختباره لاحقًا بعد إتمام بقية الأرباع.
            </p>
          </div>
        </div>
      )}

      {/* Grid of properties */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-[11px]">
        {/* 1. Quran Range */}
        <div className="p-2.5 rounded-xl bg-white/90 border border-amber-200/70 space-y-1">
          <div className="flex items-center gap-1.5 text-stone-500 font-medium">
            <BookOpen className="w-3.5 h-3.5 text-amber-700" />
            <span>نطاق الاختبار بالأرباع</span>
          </div>
          <div className="font-bold text-stone-900 text-xs">
            من الربع {test.range_start} إلى الربع {targetEnd}
            {actualIsPartial && (
              <span className="text-amber-700 text-[10px] mr-1">
                (نطاق جزئي من أصل {test.range_end})
              </span>
            )}
          </div>
          <p className="text-[10px] text-stone-500 leading-snug">
            من: {startVerse?.surah_name} [آية {startVerse?.ayah}]
            <br />
            إلى: {endVerse?.surah_name} [آية {endVerse?.ayah}]
            {actualIsPartial && (
              <span className="block text-stone-400 mt-0.5">
                (نهاية النطاق الكامل: {fullEndVerse?.surah_name} [آية {fullEndVerse?.ayah}])
              </span>
            )}
          </p>
        </div>

        {/* 2. Questions & Length */}
        <div className="p-2.5 rounded-xl bg-white/90 border border-amber-200/70 space-y-1">
          <div className="flex items-center gap-1.5 text-stone-500 font-medium">
            <Layers className="w-3.5 h-3.5 text-amber-700" />
            <span>عدد وطول الأسئلة</span>
          </div>
          <div className="font-bold text-stone-900 text-xs">
            {test.questions_count} {test.questions_count === 1 ? 'سؤال' : test.questions_count === 2 ? 'سؤالان' : 'أسئلة'} • {test.lines_per_question} أسطر لكل سؤال
          </div>
          <p className="text-[10px] text-stone-500">
            يتم احتساب الطول تلقائيًا وفق أسطر مصحف المدينة المنورة (15 سطرًا لكل صفحة تقريبًا).
          </p>
        </div>

        {/* 3. Difficulty */}
        <div className="p-2.5 rounded-xl bg-white/90 border border-amber-200/70 space-y-1">
          <div className="flex items-center gap-1.5 text-stone-500 font-medium">
            <Sparkles className="w-3.5 h-3.5 text-amber-700" />
            <span>مستوى الصعوبة</span>
          </div>
          <div className="font-bold text-stone-900 text-xs">
            {difficultyInfo.label}
          </div>
          <p className="text-[10px] text-stone-500">
            {difficultyInfo.desc} (يُحسب حتميًا من تشابه الآيات في المصحف).
          </p>
        </div>

        {/* 4. Errors Allowance */}
        <div className="p-2.5 rounded-xl bg-white/90 border border-amber-200/70 space-y-1">
          <div className="flex items-center gap-1.5 text-stone-500 font-medium">
            <ShieldAlert className="w-3.5 h-3.5 text-amber-700" />
            <span>حد الأخطاء المسموح</span>
          </div>
          <div className="font-bold text-stone-900 text-xs">
            {test.has_max_errors && typeof test.max_errors_allowed === 'number'
              ? `${test.max_errors_allowed} أخطاء كحد أقصى`
              : 'بدون حد أقصى (تسجيل للمتابعة فقط)'}
          </div>
          <p className="text-[10px] text-stone-500">
            {test.has_max_errors
              ? 'تجاوز هذا الحد يؤدي إلى رسوب العضو في المحاولة.'
              : 'تُحسب جميع الأخطاء وتُسجل للتوثيق دون رسوب.'}
          </p>
        </div>
      </div>

      {/* Rules & Policy footer */}
      <div className="space-y-1.5 pt-1 border-t border-amber-200/60 text-[11px] leading-relaxed">
        <div className="flex items-start gap-1.5">
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-700 shrink-0 mt-0.5" />
          <div>
            <strong className="text-stone-900">شروط التأهل: </strong>
            {test.prerequisites.require_all_quarters_completed ? (
              <span>يشترط إتمام جميع أرباع النطاق حتى الربع {test.range_end}.</span>
            ) : (
              <span>
                يكفي إتمام الربع الأول ({test.range_start})، ويُختبر العضو فيما أتمّه متصلًا حتى الربع الذي بلغه.
              </span>
            )}
            {test.prerequisites.require_revision_completed && (
              <span> • يشترط عدم وجود أيام مراجعة فائتة وتأكيد مراجعة اليوم.</span>
            )}
            {test.audience === 'selected' ? (
              <span> • مخصص لأعضاء محددين فقط من قِبَل المشرف.</span>
            ) : (
              <span> • متاح لجميع أعضاء المقرأة.</span>
            )}
          </div>
        </div>

        <div className="flex items-start gap-1.5">
          <Info className="w-3.5 h-3.5 text-blue-700 shrink-0 mt-0.5" />
          <div>
            <strong className="text-stone-900">نوع الاختبار وأثره: </strong>
            {test.test_type === 'mandatory' ? (
              <span>
                إلزامي: اجتيازه شرط لمتابعة تسميع الأرباع التالية للربع {test.range_end}. لا يمكن تسجيل الأرباع التالية إلا بعد اجتياز النطاق كاملاً بنجاح.
              </span>
            ) : (
              <span>
                موصى به: تشجيعي لقياس الإتقان ولا يمنع تسجيل التسميع اليومي.
              </span>
            )}
          </div>
        </div>

        <div className="flex items-start gap-1.5">
          <RefreshCw className="w-3.5 h-3.5 text-stone-600 shrink-0 mt-0.5" />
          <div>
            <strong className="text-stone-900">إمكانية الإعادة: </strong>
            <span>
              {actualIsPartial
                ? 'اجتياز الاختبار جزئيًا لا يمنع إعادة الاختبار لاحقًا بعد إتمام أرباع إضافية من النطاق.'
                : 'في حال عدم الاجتياز، يمكن إعادة المحاولة مع زميل آخر حتى تحقيق النجاح.'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
