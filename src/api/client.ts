import {
  User,
  GroupSettings,
  RestDay,
  RecitationLog,
  RevisionLog,
  CycleInfo,
  MemberDailyStatus,
  TestDefinition,
  TestAttempt,
  TestQuestion,
} from '../types';
import { formatDate } from '../lib/calculations';

const TOKEN_KEY = 'motqin_auth_token';

export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setStoredToken(token: string | null): void {
  try {
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    // ignore
  }
}

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const token = getStoredToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // Pass user device local date to ensure server calendar calculations match user timezone
  try {
    const localDate = formatDate(new Date());
    if (localDate) {
      headers['X-Client-Date'] = localDate;
    }
  } catch {
    // ignore
  }

  const response = await fetch(endpoint, {
    ...options,
    headers,
  });

  if (response.status === 401 && token && !endpoint.startsWith('/api/auth/login')) {
    // Session is no longer valid: go back to login instead of silently failing saves.
    setStoredToken(null);
    try { window.location.reload(); } catch { /* ignore */ }
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const errorMsg = data?.error || data?.message || `خطأ في الاتصال (${response.status})`;
    throw new Error(errorMsg);
  }

  return data as T;
}

export const api = {
  // Auth
  async login(phone: string, password: string): Promise<{ user: User; token: string }> {
    const res = await request<{ user: User; token: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ phone, password }),
    });
    setStoredToken(res.token);
    return res;
  },

  async logout(): Promise<void> {
    try {
      await request('/api/auth/logout', { method: 'POST' });
    } finally {
      setStoredToken(null);
    }
  },

  async getMe(): Promise<{ user: User }> {
    return request<{ user: User }>('/api/auth/me');
  },

  async changePassword(payload: {
    currentPassword: string;
    newPassword: string;
    confirmPassword?: string;
  }): Promise<{ message: string }> {
    return request<{ message: string }>('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  // Bootstrap
  async getBootstrap(params?: { client_date?: string }): Promise<{
    cycleInfo: CycleInfo;
    settings: GroupSettings;
    restDays: RestDay[];
    users: User[];
    todayRecitations: RecitationLog[];
    todayRevisions: RevisionLog[];
    tests?: TestDefinition[];
    activeTest?: TestDefinition | null;
    testAttempts?: TestAttempt[];
  }> {
    const today = params?.client_date || formatDate(new Date());
    return request(`/api/bootstrap?client_date=${today}`);
  },

  // Recitations
  async getRecitations(params?: {
    member_id?: string;
    reciter_id?: string;
    date?: string;
  }): Promise<{ recitations: RecitationLog[] }> {
    const query = new URLSearchParams(params as Record<string, string>).toString();
    return request(`/api/recitations${query ? `?${query}` : ''}`);
  },

  async recordRecitation(payload: {
    quarter_number: number;
    listener_id: string;
    notes?: string;
    date?: string;
  }): Promise<{ recitation: RecitationLog; message: string }> {
    return request('/api/recitations', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  // Revisions
  async getRevisions(params?: {
    member_id?: string;
    date?: string;
  }): Promise<{ revisions: RevisionLog[] }> {
    const query = new URLSearchParams(params as Record<string, string>).toString();
    return request(`/api/revisions${query ? `?${query}` : ''}`);
  },

  async recordRevision(payload: {
    notes?: string;
    date?: string;
  }): Promise<{ revision: RevisionLog; message: string }> {
    // Server is idempotent per member+day, so retrying after a network failure is safe.
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await request<{ revision: RevisionLog; message: string }>('/api/revisions', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      } catch (e) {
        lastErr = e;
        const m = e instanceof Error ? e.message : '';
        const inFlight = m.includes('جارٍ حفظ');
        if (!(e instanceof TypeError) && !inFlight) throw e; // real server answer: do not retry
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('تعذر الاتصال بالخادم');
  },

  // Admin APIs
  async adminAddMember(payload: {
    name: string;
    phone: string;
    password: string;
    role: 'member' | 'admin';
  }): Promise<{ user: User; message: string }> {
    return request('/api/admin/members', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async adminUpdateMember(
    id: string,
    payload: {
      name?: string;
      phone?: string;
      password?: string;
      role?: 'member' | 'admin';
      is_active?: boolean;
    }
  ): Promise<{ user: User; message: string }> {
    return request(`/api/admin/members/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  },

  async adminDeleteMemberCompletely(id: string): Promise<{ success: boolean; message: string }> {
    return request(`/api/admin/members/${id}/completely`, {
      method: 'DELETE',
    });
  },

  async adminAddRestDay(payload: {
    date: string;
    note: string;
  }): Promise<{ restDay: RestDay; message: string }> {
    return request('/api/admin/rest-days', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async adminDeleteRestDay(id: string): Promise<{ success: boolean; message: string }> {
    return request(`/api/admin/rest-days/${id}`, {
      method: 'DELETE',
    });
  },

  async adminPause(): Promise<{
    settings: GroupSettings;
    cycleInfo: CycleInfo;
    message: string;
  }> {
    return request('/api/admin/pause', {
      method: 'POST',
    });
  },

  async adminResume(): Promise<{
    settings: GroupSettings;
    cycleInfo: CycleInfo;
    message: string;
  }> {
    return request('/api/admin/resume', {
      method: 'POST',
    });
  },

  async adminAddPausePeriod(from: string, to: string): Promise<{ settings: GroupSettings; message: string }> {
    return request('/api/admin/pause-periods', { method: 'POST', body: JSON.stringify({ from, to }) });
  },

  async adminBackfillRevisions(until: string): Promise<{ created: number; message: string }> {
    return request('/api/admin/backfill-revisions', {
      method: 'POST',
      body: JSON.stringify({ until }),
    });
  },

  async adminUpdateSettings(payload: {
    start_date?: string;
  }): Promise<{ settings: GroupSettings; message: string }> {
    return request('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  },

  async adminUpdateDailyThought(payload: {
    daily_thought: string;
  }): Promise<{ settings: GroupSettings; message: string }> {
    return request('/api/admin/daily-thought', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  },

  async adminDeleteDailyThought(): Promise<{ settings: GroupSettings; message: string }> {
    return request('/api/admin/daily-thought', {
      method: 'DELETE',
    });
  },

  async adminFactoryReset(): Promise<{
    success: boolean;
    message: string;
    cycleInfo: CycleInfo;
    settings: GroupSettings;
  }> {
    return request('/api/admin/factory-reset', {
      method: 'POST',
    });
  },

  async adminGetStats(): Promise<{
    total_members: number;
    completed_recitation_count: number;
    completed_revision_count: number;
    pending_recitation_today: any[];
    pending_revision_today: any[];
    member_stats: any[];
  }> {
    return request('/api/admin/stats');
  },

  async getFirestoreStatus(): Promise<{
    projectId: string;
    databaseId: string;
    connected: boolean;
    error: string | null;
  }> {
    return request('/api/firestore/status');
  },

  // Peer Testing API methods
  async getTests(): Promise<{ tests: TestDefinition[]; activeTest: TestDefinition | null }> {
    return request('/api/tests');
  },

  async adminSaveTest(payload: Partial<TestDefinition>): Promise<{
    success: boolean;
    message: string;
    test: TestDefinition;
  }> {
    return request('/api/admin/tests', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async adminToggleTestStatus(id: string, is_active: boolean): Promise<{
    success: boolean;
    message: string;
    test: TestDefinition;
  }> {
    return request(`/api/admin/tests/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ is_active }),
    });
  },

  async adminFinishTest(id: string): Promise<{
    success: boolean;
    message: string;
    test: TestDefinition;
  }> {
    return request(`/api/admin/tests/${id}/finish`, {
      method: 'POST',
    });
  },

  async adminPreviewTestQuestions(testId: string): Promise<{
    test_id: string;
    questions: TestQuestion[];
  }> {
    return request(`/api/admin/tests/${testId}/preview-questions`);
  },

  async adminGetTestImpact(testId: string): Promise<{
    test_id: string;
    test_type: 'mandatory' | 'recommended';
    range_start: number;
    range_end: number;
    blocked_count: number;
    blocked_members: { id: string; name: string }[];
  }> {
    return request(`/api/admin/tests/${testId}/impact`);
  },

  async getEligibleCandidates(testId: string): Promise<{
    test: TestDefinition;
    candidates: {
      id: string;
      name: string;
      phone: string;
      is_eligible: boolean;
      ineligibility_reasons: string[];
      has_passed: boolean;
      attempts_count: number;
      effective_range_end?: number;
      covers_full_range?: boolean;
    }[];
  }> {
    return request(`/api/tests/${testId}/eligible-candidates`);
  },

  async generateTestQuestions(testId: string, candidateId?: string): Promise<{
    test_id: string;
    effective_range_end?: number;
    questions: TestQuestion[];
  }> {
    const q = candidateId ? `?candidate_id=${encodeURIComponent(candidateId)}` : '';
    return request(`/api/tests/${testId}/generate-questions${q}`);
  },

  async recordTestAttempt(payload: {
    test_id: string;
    candidate_id: string;
    questions_results: {
      start_surah: number;
      start_ayah: number;
      end_surah: number;
      end_ayah: number;
      errors_count: number;
      notes?: string;
    }[];
    notes?: string;
  }): Promise<{
    success: boolean;
    message: string;
    attempt: TestAttempt;
  }> {
    return request('/api/tests/attempts', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async getTestAttempts(params?: {
    test_id?: string;
    candidate_id?: string;
    examiner_id?: string;
  }): Promise<{ attempts: TestAttempt[] }> {
    const query = new URLSearchParams(params as Record<string, string>).toString();
    return request(`/api/tests/attempts${query ? `?${query}` : ''}`);
  },

  // ---------- Personal self-tests (separate from the program and from the admin) ----------
  async personalTestSurahs(): Promise<{ surahs: { number: number; name: string; ayah_count: number }[] }> {
    return request('/api/personal-tests/surahs');
  },

  async personalTestMeta(): Promise<{
    surahs: { number: number; name: string; ayah_count: number }[];
    juzList: {
      juz: number;
      start_surah: number;
      start_surah_name: string;
      start_ayah: number;
      end_surah: number;
      end_surah_name: string;
      end_ayah: number;
      label: string;
    }[];
    quartersList: {
      quarter: number;
      juz: number;
      surahName: string;
      ayahNumber: number;
      label: string;
    }[];
  }> {
    return request('/api/personal-tests/meta');
  },

  async personalTestGenerate(setup: {
    range_type?: 'surah' | 'juz' | 'quarter';
    start_surah?: number;
    end_surah?: number;
    start_juz?: number;
    end_juz?: number;
    start_quarter?: number;
    end_quarter?: number;
    questions_count: number;
    lines_per_question: number;
    difficulty: string;
  }): Promise<{ questions: TestQuestion[]; points_per_error: number; range_label?: string }> {
    return request('/api/personal-tests/generate', { method: 'POST', body: JSON.stringify(setup) });
  },

  async personalTestSave(payload: any): Promise<{ success: boolean; record: any }> {
    return request('/api/personal-tests', { method: 'POST', body: JSON.stringify(payload) });
  },

  async personalTestHistory(): Promise<{
    records: any[];
    stats: { count: number; average: number; best: number };
  }> {
    return request('/api/personal-tests');
  },

  async personalTestDelete(id: string): Promise<{ success: boolean }> {
    return request(`/api/personal-tests/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
};

