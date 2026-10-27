// In-app notifications (Men): DERIVED from the current program status, never stored. They read the
// results of the authoritative calculations (calculateMemberRequiredQuarter,
// calculateMemberRevisionStatus, calculateMemberDistantReviewStatus, computeMemberDelayStatus) and
// add no rule of their own, so a notification exists exactly while its condition does: catching up
// lowers or removes it, and the program date (05:00 Africa/Cairo) decides when a day becomes overdue.
// Master admins have no notifications. Pure TypeScript (bundled by Vite and Deno).

import { formatArabicDateWithDayName } from './calculations.ts';
import { SEVERE_DELAY_THRESHOLD, type MemberDelayStatus } from './memberDelayStatus.ts';

/** Overdue days in one category that make the warning serious (and alert the batch admins). */
export const SERIOUS_DEBT_THRESHOLD = 3;

/** 1 day: light (yellow), 2 days: stronger (orange), 3 or more: serious (red). */
export type DebtLevel = 'light' | 'strong' | 'serious';

export function debtLevel(count: number): DebtLevel | null {
  if (count <= 0) return null;
  if (count >= SERIOUS_DEBT_THRESHOLD) return 'serious';
  return count === 2 ? 'strong' : 'light';
}

/** 3 or more overdue days: «3 أيام متأخرة» … «10 أيام متأخرة», «11 يومًا متأخرًا» … */
export function arabicLateDays(n: number): string {
  return n <= 10 ? `${n} أيام متأخرة` : `${n} يومًا متأخرًا`;
}

export type MemberNotificationKind = 'tasmia-overdue' | 'revision-overdue' | 'distant-overdue' | 'rest-day' | 'distant-day';
export type NotificationTone = DebtLevel | 'info' | 'distant';

/** Where opening the notification leads on the member dashboard. */
export type MemberNotificationTarget =
  | { kind: 'tasmia'; quarter: number }
  | { kind: 'revision'; date: string }
  | { kind: 'distant'; assignmentId: string }
  | { kind: 'rest-day' };

export interface MemberNotification {
  /** Stable per condition (one per category, not per missed day). */
  id: string;
  kind: MemberNotificationKind;
  tone: NotificationTone;
  title: string;
  body: string;
  note?: string;
  count?: number;
  /** Changes whenever what the notification says changes (a read one becomes unread again). */
  signature: string;
  target: MemberNotificationTarget;
}

export interface MemberNotificationInput {
  /** The program date (05:00 Africa/Cairo). */
  today: string;
  isActive: boolean;
  hasStarted: boolean;
  isCompleted: boolean;
  isRestDay: boolean;
  restDayNote?: string;
  /** calculateMemberRequiredQuarter: past missed quarters (one per program day) and the next one owed. */
  tasmia: { pastMissedCount: number; requiredQuarter: number };
  /** calculateMemberRevisionStatus: past program days with no review (oldest first). */
  revision: { pastMissedDates: string[] };
  /** calculateMemberDistantReviewStatus (active cycle). */
  distant: {
    overdue: { id: string; review_date: string }[];
    todayAssignment: { id: string; start_quarter: number; end_quarter: number; note?: string | null } | null;
    hasCompletedToday: boolean;
  };
}

const TONE_ORDER: Record<NotificationTone, number> = { serious: 0, strong: 1, light: 2, distant: 3, info: 4 };

export function distantRangeLabel(start: number, end: number): string {
  return `من بداية الربع ${start} حتى بداية الربع ${end}`;
}

/**
 * A member's notifications: one per overdue category (Tasmi'a, normal review, distant review — never
 * merged into one number) plus today's schedule information (rest day, distant-review day).
 * Overdue warnings follow the dashboard's own delay alert: only for an active member of a running
 * program.
 */
export function buildMemberNotifications(input: MemberNotificationInput): MemberNotification[] {
  const out: MemberNotification[] = [];
  const debtsApply = input.isActive && input.hasStarted && !input.isCompleted;

  if (debtsApply) {
    const n = input.tasmia.pastMissedCount;
    const level = debtLevel(n);
    if (level) {
      const q = input.tasmia.requiredQuarter;
      out.push({
        id: 'tasmia-overdue',
        kind: 'tasmia-overdue',
        tone: level,
        count: n,
        title:
          level === 'light'
            ? 'لديك يوم تسميع متأخر'
            : level === 'strong'
            ? 'لديك يومان متأخران في التسميع'
            : `تنبيه شديد: لديك ${arabicLateDays(n)} في التسميع`,
        body:
          level === 'light'
            ? `الربع ${q} لم يُسمَّع في موعده، فبادر باستدراكه.`
            : level === 'strong'
            ? `بادر باستدراك التسميع قبل أن يتراكم، بدءًا من الربع ${q}.`
            : `أنت تقترب من حد الاستبعاد. يرجى استدراك التسميع سريعًا بدءًا من الربع ${q} حتى لا تصبح عرضة للاستبعاد.`,
        signature: `${n}:${q}`,
        target: { kind: 'tasmia', quarter: q },
      });
    }

    const dates = input.revision.pastMissedDates;
    const rLevel = debtLevel(dates.length);
    if (rLevel) {
      const first = dates[0];
      const firstLabel = formatArabicDateWithDayName(first);
      out.push({
        id: 'revision-overdue',
        kind: 'revision-overdue',
        tone: rLevel,
        count: dates.length,
        title:
          rLevel === 'light'
            ? 'لديك يوم مراجعة متأخر'
            : rLevel === 'strong'
            ? 'لديك يومان متأخران في المراجعة'
            : `تنبيه شديد: لديك ${arabicLateDays(dates.length)} في المراجعة`,
        body:
          rLevel === 'light'
            ? `مراجعة ${firstLabel} لم تُؤكَّد بعد، فبادر باستدراكها.`
            : rLevel === 'strong'
            ? `بادر باستدراك المراجعة قبل أن تتراكم، بدءًا من مراجعة ${firstLabel}.`
            : `أنت تقترب من حد الاستبعاد. يرجى استدراك المراجعة سريعًا بدءًا من مراجعة ${firstLabel} حتى لا تصبح عرضة للاستبعاد.`,
        signature: dates.join(','),
        target: { kind: 'revision', date: first },
      });
    }

    // «المراجعة البعيدة»: its own debt, separate from the normal review (not part of the elimination rule).
    const overdue = input.distant.overdue;
    if (overdue.length > 0) {
      const first = overdue[0];
      const firstLabel = formatArabicDateWithDayName(first.review_date);
      out.push({
        id: 'distant-overdue',
        kind: 'distant-overdue',
        tone: overdue.length === 1 ? 'light' : 'strong',
        count: overdue.length,
        title:
          overdue.length === 1
            ? 'لديك مراجعة بعيدة متأخرة'
            : overdue.length === 2
            ? 'لديك مراجعتان بعيدتان متأخرتان'
            : `لديك ${overdue.length} ${overdue.length <= 10 ? 'مراجعات بعيدة متأخرة' : 'مراجعة بعيدة متأخرة'}`,
        body: `المراجعة البعيدة ليوم ${firstLabel} لم تُؤكَّد بعد. وهي مستقلة عن ورد المراجعة اليومي.`,
        signature: overdue.map((a) => a.id).join(','),
        target: { kind: 'distant', assignmentId: first.id },
      });
    }
  }

  if (input.hasStarted && input.isRestDay) {
    out.push({
      id: `rest-day:${input.today}`,
      kind: 'rest-day',
      tone: 'info',
      title: 'اليوم يوم استدراك وراحة',
      body: 'اليوم راحة من التقدم المعتاد للبرنامج: لا ربع تسميع جديد ولا مراجعة يومية جديدة. وما كان عليك من أوراد متأخرة سابقة يبقى مطلوبًا للاستدراك.',
      note: input.restDayNote || undefined,
      signature: input.restDayNote || '',
      target: { kind: 'rest-day' },
    });
  }

  const todayDistant = input.distant.todayAssignment;
  if (input.hasStarted && todayDistant) {
    out.push({
      id: `distant-day:${todayDistant.id}`,
      kind: 'distant-day',
      tone: 'distant',
      title: 'اليوم مراجعة بعيدة',
      body: `المطلوب: ${distantRangeLabel(todayDistant.start_quarter, todayDistant.end_quarter)}. التقدم المعتاد للبرنامج (التسميع والمراجعة اليومية) متوقف اليوم.${
        input.distant.hasCompletedToday ? ' وقد أتممتها اليوم، بارك الله فيك.' : ''
      }`,
      note: todayDistant.note || undefined,
      signature: `${todayDistant.start_quarter}-${todayDistant.end_quarter}:${todayDistant.note || ''}:${input.distant.hasCompletedToday ? 1 : 0}`,
      target: { kind: 'distant', assignmentId: todayDistant.id },
    });
  }

  return out.sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone]);
}

/** A batch admin's alert: one member, one category, at 3 or more overdue days. */
export interface BatchAdminAlert {
  id: string;
  batchId: string;
  batchName: string;
  memberId: string;
  memberName: string;
  phone: string;
  category: 'tasmia' | 'revision';
  count: number;
  /** The existing «مؤهل للإقصاء» rule (SEVERE_DELAY_THRESHOLD) — unchanged. */
  eligibleForExclusion: boolean;
  signature: string;
}

/**
 * Serious alerts of one batch: active members with 3 or more overdue days in Tasmi'a or in the normal
 * review (each category on its own). Fewer days never alert the admin. `delays` comes from
 * computeMemberDelayStatus (computeBatchDelays), the same status the admin dashboard shows.
 */
export function buildBatchAdminAlerts(
  batch: { id: string; name: string },
  members: { id: string; name: string; phone: string }[],
  delays: Map<string, MemberDelayStatus>
): BatchAdminAlert[] {
  const out: BatchAdminAlert[] = [];
  for (const m of members) {
    const d = delays.get(m.id);
    if (!d) continue;
    const categories: [BatchAdminAlert['category'], number][] = [
      ['tasmia', d.missedQuartersCount],
      ['revision', d.missedRevisionDaysCount],
    ];
    for (const [category, count] of categories) {
      if (count < SERIOUS_DEBT_THRESHOLD) continue;
      out.push({
        id: `${batch.id}:${m.id}:${category}`,
        batchId: batch.id,
        batchName: batch.name,
        memberId: m.id,
        memberName: m.name,
        phone: m.phone,
        category,
        count,
        eligibleForExclusion: count >= SEVERE_DELAY_THRESHOLD,
        signature: String(count),
      });
    }
  }
  return out.sort((a, b) => b.count - a.count || a.memberName.localeCompare(b.memberName, 'ar'));
}
