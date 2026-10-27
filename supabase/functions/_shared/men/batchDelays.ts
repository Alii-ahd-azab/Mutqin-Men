// Delay status of every active member of one batch on a program date, with the SAME shared code as
// the dashboards (calculateCycleInfo, getActiveCycleDates, computeMemberDelayStatus). Used by the
// peer-tests Edge Function and the batch admins' serious alerts.
import { calculateCycleInfo, getActiveCycleDates, joinedOnDateFromTimestamp } from '../logic/calculations.ts';
import { computeMemberDelayStatus, type MemberDelayStatus } from '../logic/memberDelayStatus.ts';
import type { CycleInfo } from '../logic/programTypes.ts';
import type { ProgramState } from './menData.ts';

export interface BatchDelays {
  cycleInfo: CycleInfo;
  activeDates: string[];
  /** Active members of the batch (membership role 'member'), in the program's order. */
  members: ProgramState['users'];
  delayById: Map<string, MemberDelayStatus>;
}

export function computeBatchDelays(
  program: Pick<ProgramState, 'users' | 'settings' | 'restDays' | 'recitationLogs' | 'revisionLogs'>,
  today: string
): BatchDelays {
  const cycleInfo = calculateCycleInfo(program.settings, program.restDays, today);
  const activeDates = getActiveCycleDates(program.settings.start_date, today, program.restDays, program.settings);
  const members = program.users.filter((u) => u.role === 'member' && u.is_active && !!u.batch_joined_at);
  const delayById = new Map<string, MemberDelayStatus>();
  for (const u of members) {
    delayById.set(
      u.id,
      computeMemberDelayStatus({
        memberId: u.id,
        quarterOfDay: cycleInfo.quarter_of_day,
        activeCycleDates: activeDates,
        recitations: program.recitationLogs,
        revisions: program.revisionLogs,
        todayDate: today,
        joinedOnDate: joinedOnDateFromTimestamp(u.batch_joined_at),
        startQuarter: u.batch_start_quarter,
        calendar: program.settings,
      })
    );
  }
  return { cycleInfo, activeDates, members, delayById };
}
