export type UserRole = 'member' | 'admin';

export interface User {
  id: string;
  name: string;
  phone: string;
  role: UserRole;
  is_active: boolean;
  created_at: string;
  firebase_uid?: string;
}

export interface GroupSettings {
  id: string;
  start_date: string; // ISO date YYYY-MM-DD
  total_quarters: number; // 240
  review_window: number; // 8
  current_cycle_number: number;
  is_paused: boolean;
  paused_at: string | null; // ISO date YYYY-MM-DD
  total_paused_days: number;
  pause_periods?: { from: string; to: string }[]; // فترات إيقاف منتهية (شاملة الطرفين)
  daily_thought?: string; // HTML formatted thought of the day
  daily_thought_updated_at?: string; // ISO date string
  daily_thought_updated_by?: string; // Admin display name
}

export interface RestDay {
  id: string;
  date: string; // YYYY-MM-DD
  note: string;
  added_by_admin_id: string;
  added_by_name?: string;
  created_at: string;
}

export interface RecitationLog {
  id: string;
  member_id: string;
  member_name: string;
  listener_id?: string;
  listener_name?: string;
  quarter_number: number;
  cycle_number: number;
  date: string; // YYYY-MM-DD
  notes?: string;
  created_at: string;
  // Legacy aliases for backwards compatibility
  reciter_id?: string;
  reciter_name?: string;
}

export interface RevisionLog {
  id: string;
  member_id: string;
  member_name: string;
  date: string; // YYYY-MM-DD
  cycle_number: number;
  review_start_quarter: number;
  review_end_quarter: number;
  notes?: string;
  created_at: string;
}

export interface CycleInfo {
  has_started: boolean;
  days_until_start: number;
  cycle_day: number; // 1 to 240 (or 0 if not started)
  quarter_of_day: number; // 1 to 240 (or 0 if not started)
  review_start: number;
  review_end: number;
  review_count: number;
  is_rest_day: boolean;
  rest_day_note?: string;
  is_paused: boolean;
  paused_at?: string | null;
  is_completed: boolean;
  days_elapsed: number;
  rest_days_count: number;
  paused_days_count: number;
  start_date: string;
  current_cycle_number: number;
  today_date: string;
}

export interface MemberDailyStatus {
  user: User;
  has_recited: boolean;
  recited_quarter?: number;
  listener_name?: string;
  has_reviewed: boolean;
  revision_notes?: string;
  total_recitations: number;
  total_revisions: number;
  required_quarter: number;
  is_behind: boolean;
  missed_quarters_count: number;
  missed_revision_days_count?: number;
  is_severely_behind?: boolean;
  severe_reasons?: ('recitation' | 'revision')[];
}

export interface TestPrerequisites {
  require_all_quarters_completed: boolean; // إتمام آخر ربع مطلوب
  require_revision_completed: boolean; // إتمام المراجعة
}

export interface TestDefinition {
  id: string;
  title?: string;
  range_start: number; // 1 to 240
  range_end: number; // 1 to 240
  questions_count: number; // >= 1
  lines_per_question: number; // >= 1
  prerequisites: TestPrerequisites;
  has_max_errors: boolean;
  max_errors_allowed?: number;
  test_type: 'mandatory' | 'recommended';
  is_active: boolean;
  audience?: 'all' | 'selected';
  selected_member_ids?: string[];
  difficulty?: 'any' | 'easy' | 'medium' | 'hard' | 'mixed';
  created_at: string;
  created_by_admin_id?: string;
  updated_at?: string;
  is_finished?: boolean;
  finished_at?: string;
}

export interface TestQuestion {
  question_number: number;
  start_surah: number;
  start_surah_name: string;
  start_ayah: number;
  start_text: string;
  start_page: number;
  start_line: number;
  end_surah: number;
  end_surah_name: string;
  end_ayah: number;
  end_text: string;
  end_page: number;
  end_line: number;
  target_lines: number;
  actual_lines?: number;
  difficulty_level?: 'easy' | 'medium' | 'hard';
  difficulty_score?: number;
}

export interface TestAttemptQuestionResult {
  question_number: number;
  start_surah?: number;
  start_surah_name: string;
  start_ayah: number;
  end_surah?: number;
  end_surah_name: string;
  end_ayah: number;
  errors_count: number;
  notes?: string;
}

export interface TestAttempt {
  id: string;
  test_id: string;
  candidate_id: string; // العضو المختبَر
  candidate_name: string;
  examiner_id: string; // الزميل المختبِر
  examiner_name: string;
  total_errors: number;
  passed: boolean;
  status: 'passed' | 'failed';
  date: string; // YYYY-MM-DD
  questions_results: TestAttemptQuestionResult[];
  notes?: string;
  created_at: string;
  effective_range_end?: number;
  covers_full_range?: boolean;
}

export type PersonalTestRangeType = 'surah' | 'juz' | 'quarter';

export interface PersonalTestQuestion {
  question_number: number;
  start_surah: number;
  start_surah_name: string;
  start_ayah: number;
  end_surah: number;
  end_surah_name: string;
  end_ayah: number;
  errors_count: number;
  grade: number;
  difficulty_level?: 'easy' | 'medium' | 'hard';
}

export interface PersonalTestRecord {
  id: string;
  member_id: string;
  range_type?: PersonalTestRangeType;
  range_label?: string;
  start_surah: number;
  start_surah_name: string;
  end_surah: number;
  end_surah_name: string;
  start_juz?: number;
  end_juz?: number;
  start_quarter?: number;
  end_quarter?: number;
  questions_count: number;
  lines_per_question: number;
  difficulty: string;
  questions: PersonalTestQuestion[];
  total_errors: number;
  grade: number;
  grade_label: string;
  notes?: string;
  date: string;
  created_at: string;
}

