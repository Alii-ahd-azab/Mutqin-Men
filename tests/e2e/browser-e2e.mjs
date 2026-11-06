// Local browser test of the REAL Men app (Vite dev server, tests/e2e/vite.config.ts) with the in-memory
// Supabase stand-in (tests/e2e/fakeSupabase.ts) and a faked clock. Reduced scope: turning today into a
// «المراجعة البعيدة» day (dialog, program day, history label, stale app, next day) and the corrected
// peer-test conditions. No network and no production data: any request to Supabase fails the run.
//
//   npx vite --config tests/e2e/vite.config.ts --port 4184 --strictPort      (separate terminal)
//   PLAYWRIGHT_PATH=<playwright package dir> node tests/e2e/browser-e2e.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const APP = process.env.APP_URL || 'http://localhost:4184/';

const results = [];
const record = (check, ok, detail = '') => {
  results.push({ check, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${check}${detail ? `  (${detail})` : ''}`);
};

// ------------------------------------------------------------------ dates (Cairo, 2026-10-28 is UTC+3)
const cairo = (date, time, offset = 3) => new Date(Date.parse(`${date}T${time}Z`) - offset * 3600_000);
const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const START = '2026-10-20';
const TODAY = '2026-10-28'; // program day 9 when nothing is off
const NOON = cairo(TODAY, '12:00:00');
const VOIDED_LABEL = 'أُلغي احتسابه: تحوّل اليوم إلى مراجعة بعيدة';

// ------------------------------------------------------------------ world
const ids = { admin: 'u-admin', m1: 'u-m1', m2: 'u-m2', m3: 'u-m3', batch: 'b-a', cycle: 'c-a' };
const dateOfDay = (d) => addDays(START, d - 1);

function world({ userId, tasmia = {}, reviews = {}, rest = [], peerTests = [] }) {
  const p = (id, full_name, phone, role, is_master_admin = false) => ({
    id, full_name, phone, role, active: true, created_at: '2026-10-01T00:00:00Z', is_master_admin, firestore_id: null,
  });
  const tables = {
    profiles: [p(ids.admin, 'مشرف الدفعة', '01000000002', 'admin'), p(ids.m1, 'أحمد محمد', '01012345678', 'member'), p(ids.m2, 'خالد علي', '01022222222', 'member'), p(ids.m3, 'عمر سعيد', '01033333333', 'member')],
    batches: [{ id: ids.batch, name: 'الدفعة أ', created_at: '2026-10-01T00:00:00Z', archived_at: null }],
    cycles: [{ id: ids.cycle, batch_id: ids.batch, cycle_number: 1, starts_on: START, status: 'active', total_quarters: 240, review_window: 8, legacy_paused_days: 0, created_at: '2026-10-01T00:00:00Z' }],
    batch_memberships: [['admin', 'admin'], ['m1', 'member'], ['m2', 'member'], ['m3', 'member']].map(([u, role]) => ({
      id: `bm-${u}`, batch_id: ids.batch, user_id: ids[u], membership_role: role, joined_at: '2026-10-19T09:00:00Z', start_cycle_id: null, start_quarter: null,
    })),
    tasmia_submissions: [],
    review_confirmations: [],
    group_rest_days: rest.map((d) => ({ id: `r-${d}`, firestore_id: null, cycle_id: ids.cycle, rest_date: d, reason: 'يوم استدراك', created_by: ids.admin, created_by_name_snapshot: null, created_at: '2026-10-01T00:00:00Z' })),
    program_pauses: [],
    daily_thoughts: [],
    peer_tests: peerTests,
    peer_test_attempts: [],
    peer_test_selected_members: [],
    distant_review_assignments: [],
    distant_review_completions: [],
    notification_states: [],
    admin_notification_batch_subscriptions: [],
    admin_alert_dismissals: [],
    voided_daily_records: [],
  };
  for (const [member, quarters] of Object.entries(tasmia))
    for (const q of quarters)
      tables.tasmia_submissions.push({
        id: `t-${member}-${q}`, firestore_id: null, cycle_id: ids.cycle, user_id: ids[member], listener_id: member === 'm2' ? ids.m3 : ids.m2,
        listener_name_snapshot: member === 'm2' ? 'عمر سعيد' : 'خالد علي', listener_changed_at: null, member_name_snapshot: null, quarter_number: q,
        notes: q === 9 ? 'ملاحظة التسميع' : null, submitted_at: `${dateOfDay(q)}T08:00:00Z`, legacy_date: dateOfDay(q),
      });
  for (const [member, days] of Object.entries(reviews))
    for (const d of days)
      tables.review_confirmations.push({
        id: `v-${member}-${d}`, firestore_id: null, cycle_id: ids.cycle, user_id: ids[member], program_day: null, start_quarter: Math.max(1, d - 7), end_quarter: d,
        confirmed_at: `${dateOfDay(d)}T08:00:00Z`, legacy_date: dateOfDay(d), member_name_snapshot: null, notes: null,
      });
  return { userId, tables };
}

// ------------------------------------------------------------------ browser helpers
const browser = await chromium.launch();
async function open(instant, w) {
  const context = await browser.newContext({ locale: 'ar-EG', viewport: { width: 1280, height: 900 }, timezoneId: 'Europe/London' });
  await context.route(/supabase\.co/, (route) => {
    record('no request reaches Supabase', false, route.request().url());
    return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => record('no page error', false, e.message));
  page.on('console', (m) => m.type() === 'error' && record('no console error', false, m.text().slice(0, 200)));
  await page.clock.install({ time: instant });
  await page.addInitScript((wd) => {
    window.__E2E_WORLD__ = wd;
    if (!sessionStorage.getItem('e2e.init')) {
      localStorage.clear();
      sessionStorage.setItem('e2e.init', '1');
    }
  }, w);
  await page.goto(APP);
  await page.waitForSelector('#notifications-button', { timeout: 30000 });
  await page.waitForTimeout(400);
  return { page, context };
}
const worldTable = (page, name) => page.evaluate((n) => window.__e2e.world.tables[n], name);
const switchUser = async (page, id) => {
  await page.evaluate((u) => {
    window.__e2e.world.userId = u;
    window.__e2e.save();
  }, id);
  await page.reload();
  await page.waitForSelector('#notifications-button', { timeout: 30000 });
  await page.waitForTimeout(500);
};
const openPanel = async (page) => {
  if (!(await page.locator('#notifications-panel').count())) await page.click('#notifications-button');
  await page.waitForSelector('#notifications-panel');
};
const closePanel = async (page) => {
  if (await page.locator('#notifications-panel').count()) await page.keyboard.press('Escape');
};
const shot = async (page, name) => process.env.SCREENSHOT_DIR && page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/${name}.png` });
const pickRange = async (page, from, to) => {
  await page.click('#distant-from-button');
  await page.click(`#distant-from-option-${from}`);
  await page.click('#distant-to-button');
  await page.fill('#distant-to-search', String(to));
  await page.click(`#distant-to-option-${to}`);
};
const dayShown = async (page, n) => new RegExp(`اليوم رقم ${n}(\\D|$)`).test(await page.locator('body').innerText());
const openSettings = async (page) => {
  await page.getByRole('button', { name: /الإعدادات والإيقاف/ }).first().click();
  await page.waitForSelector('#distant-review-section');
};

try {
  // ================================================================== admin: the conversion
  // m1 already submitted today's quarter 9 and review. m2 did nothing today. m3 is behind (quarter 8 and day 8 missing).
  let { page, context } = await open(NOON, world({
    userId: ids.admin,
    tasmia: { m1: [1, 2, 3, 4, 5, 6, 7, 8, 9], m2: [1, 2, 3, 4, 5, 6, 7, 8], m3: [1, 2, 3, 4, 5, 6, 7] },
    reviews: { m1: [1, 2, 3, 4, 5, 6, 7, 8, 9], m2: [1, 2, 3, 4, 5, 6, 7, 8], m3: [1, 2, 3, 4, 5, 6, 7] },
  }));
  record('before the conversion the admin sees program day 9', await dayShown(page, 9));
  await openSettings(page);
  record('the date picker allows today for a new day', (await page.locator('#distant-review-date').getAttribute('min')) === TODAY);
  await page.fill('#distant-review-date', TODAY);
  await pickRange(page, 1, 9);
  await page.click('#add-distant-review-btn');
  await page.waitForSelector('#distant-today-dialog');
  const dialog = await page.locator('#distant-today-dialog').innerText();
  await shot(page, 'admin-today-confirm');
  record('warning shown before anything is saved', dialog.includes('سيتم تحويل اليوم إلى يوم مراجعة بعيدة وإلغاء احتساب الورد اليومي العادي لهذا اليوم') && dialog.includes('لا يمكن تعديل هذا اليوم أو حذفه بعد الحفظ'), dialog);
  record('warning counts the submissions that stop counting (quarter 9 + today\'s review)', (await page.locator('#distant-today-count').innerText()).includes('يوجد 2 من تسجيلات اليوم التي ستتوقف عن الاحتساب ضمن الورد اليومي'));
  const box = await page.locator('#distant-today-dialog').boundingBox();
  record('dialog is centred in the viewport', box.x > 200 && box.x + box.width < 1080 && box.y > 100 && box.y + box.height < 800, JSON.stringify(box));
  await page.click('#distant-today-cancel');
  await page.waitForTimeout(200);
  record('cancel changes nothing', (await page.locator('#distant-today-dialog').count()) === 0 && (await worldTable(page, 'distant_review_assignments')).length === 0 && (await worldTable(page, 'tasmia_submissions')).some((r) => r.quarter_number === 9) && (await worldTable(page, 'voided_daily_records')).length === 0);
  await page.click('#add-distant-review-btn');
  await page.locator('#distant-today-yes').dblclick();
  await page.waitForSelector(`#distant-review-item-${TODAY}`);
  await page.waitForTimeout(500);
  record('one day created (double click)', (await worldTable(page, 'distant_review_assignments')).length === 1);
  record('success message reports the voided records', (await page.locator('#distant-review-msg').innerText()).includes('أُلغي احتساب 2'));
  const item = await page.locator(`#distant-review-item-${TODAY}`).innerText();
  record('the day cannot be edited or deleted afterwards', item.includes('عرض فقط') && (await page.locator(`#edit-distant-${TODAY}`).count()) === 0 && (await page.locator(`#delete-distant-${TODAY}`).count()) === 0, item);
  record('the program goes back to day 8', await dayShown(page, 8));
  const voided = await worldTable(page, 'voided_daily_records');
  record('the rows left the live data and are preserved in the archive', voided.length === 2 && !(await worldTable(page, 'tasmia_submissions')).some((r) => r.quarter_number === 9) && !(await worldTable(page, 'review_confirmations')).some((r) => r.legacy_date === TODAY) && voided.every((v) => v.user_id === ids.m1));

  // A future day keeps its behaviour; editing it cannot move it onto today.
  await page.fill('#distant-review-date', '2026-11-02');
  await pickRange(page, 1, 5);
  await page.click('#add-distant-review-btn');
  await page.waitForSelector('#distant-review-item-2026-11-02');
  record('a future day needs no same-day warning', (await page.locator('#distant-today-dialog').count()) === 0);
  await page.click('#edit-distant-2026-11-02');
  record('editing a scheduled day keeps the future-only minimum', (await page.locator('#distant-review-date').getAttribute('min')) === '2026-10-29');
  await page.click('#delete-distant-2026-11-02');
  await page.click('#confirm-delete-distant-2026-11-02');
  await page.waitForTimeout(400);

  // ================================================================== member who had already submitted
  await switchUser(page, ids.m1);
  const heroA = await page.locator('#day-overview').innerText();
  record('member A: program day 8', /اليوم رقم 8/.test(heroA), heroA.slice(0, 60));
  record('member A: the distant review is today\'s requirement', (await page.locator('#distant-review-card').count()) === 1);
  record('member A: no normal review due today', (await page.getByRole('button', { name: /تأكيد إتمام المراجعة اليومية/ }).count()) === 0);
  const voidedT = await page.locator('#voided-tasmia-9').innerText();
  await page.locator('#voided-tasmia-9').scrollIntoViewIfNeeded();
  await shot(page, 'member-history-voided');
  record('member A: history keeps quarter 9 with the label, listener and notes', voidedT.includes('الربع رقم 9') && voidedT.includes(VOIDED_LABEL) && voidedT.includes('خالد علي') && voidedT.includes('ملاحظة التسميع'), voidedT);
  record('member A: the recitation tab counts valid quarters only (8)', (await page.getByRole('button', { name: /سجل التسميع/ }).innerText()).includes('(8)'));
  await page.getByRole('button', { name: /سجل المراجعات/ }).click();
  const voidedR = await page.locator('#voided-review-9').innerText();
  record('member A: history keeps the review with the label', voidedR.includes('مراجعة من الربع 2 إلى 9') && voidedR.includes(VOIDED_LABEL), voidedR);
  record('member A: the review tab counts valid reviews only (8)', (await page.getByRole('button', { name: /سجل المراجعات/ }).innerText()).includes('(8)'));
  await openPanel(page);
  record('member A: no fake overdue notification; the distant review is announced', (await page.locator('#notification-tasmia-overdue').count()) === 0 && (await page.locator('#notification-revision-overdue').count()) === 0 && (await page.locator('#notification-distant-day').count()) === 1);
  await closePanel(page);
  await page.click('#complete-distant-review-btn');
  await page.click('#distant-confirm-yes');
  await page.waitForTimeout(500);
  record('member A: the distant review of the converted day completes normally', (await worldTable(page, 'distant_review_completions')).length === 1);

  // ================================================================== member who did nothing today
  await switchUser(page, ids.m2);
  record('member B: program day 8, no normal requirement, nothing voided', /اليوم رقم 8/.test(await page.locator('#day-overview').innerText()) && (await page.locator('.voided-record').count()) === 0 && (await page.getByRole('button', { name: /تأكيد إتمام المراجعة اليومية/ }).count()) === 0);
  await openPanel(page);
  record('member B: no fake overdue notification', (await page.locator('#notification-tasmia-overdue').count()) === 0 && (await page.locator('#notification-revision-overdue').count()) === 0);
  await closePanel(page);

  // ================================================================== member already behind keeps only his real debt
  await switchUser(page, ids.m3);
  await openPanel(page);
  const m3Kinds = await page.locator('#notifications-panel [id^="notification-"]').evaluateAll((els) => els.map((e) => e.id));
  record('member C (quarter 8 missing): today\'s quarter is 8, so no overdue is invented; nothing voided', (await page.locator('.voided-record').count()) === 0 && !m3Kinds.includes('notification-tasmia-overdue'), JSON.stringify(m3Kinds));
  await closePanel(page);

  // ================================================================== the next active day (05:00 Cairo)
  await page.clock.fastForward('17:01:00');
  await page.waitForTimeout(800);
  const nextState = async () => {
    const hero = await page.locator('#day-overview').innerText();
    const tasmia = await page.locator('#tasmia-card').innerText();
    await openPanel(page);
    const overdue = (await page.locator('#notification-tasmia-overdue').count()) + (await page.locator('#notification-revision-overdue').count());
    await closePanel(page);
    return { day9: /اليوم رقم 9/.test(hero), tasmia9: tasmia.includes('الربع رقم 9'), reviewDue: (await page.getByRole('button', { name: /تأكيد إتمام المراجعة اليومية/ }).count()) === 1, overdue };
  };
  await switchUser(page, ids.m2);
  const b2 = await nextState();
  record('next day, member B: exactly day 9; quarter 9 and the review are due; no debt', b2.day9 && b2.tasmia9 && b2.reviewDue && b2.overdue === 0, JSON.stringify(b2));
  await switchUser(page, ids.m1);
  const a2 = await nextState();
  record('next day, member A: identical: quarter 9 and the review are owed again', a2.day9 && a2.tasmia9 && a2.reviewDue && a2.overdue === 0, JSON.stringify(a2));
  record('next day: the voided records stay in his history', (await page.locator('#voided-tasmia-9').count()) === 1);
  await page.click('#open-revision-modal-btn');
  await page.getByRole('button', { name: 'تأكيد إتمام المراجعة', exact: true }).click();
  await page.waitForTimeout(800);
  const newReview = (await worldTable(page, 'review_confirmations')).find((r) => r.user_id === ids.m1 && r.legacy_date === addDays(TODAY, 1));
  record('next day: the review is submitted again normally (2 to 9)', !!newReview && newReview.start_quarter === 2 && newReview.end_quarter === 9, JSON.stringify(newReview));
  await context.close();

  // ================================================================== an app opened before the conversion
  ({ page, context } = await open(NOON, world({
    userId: ids.m2,
    tasmia: { m1: [1, 2, 3, 4, 5, 6, 7, 8], m2: [1, 2, 3, 4, 5, 6, 7, 8] },
    reviews: { m1: [1, 2, 3, 4, 5, 6, 7, 8], m2: [1, 2, 3, 4, 5, 6, 7, 8] },
  })));
  record('stale app: opened on day 9 with the review button', /اليوم رقم 9/.test(await page.locator('#day-overview').innerText()) && (await page.getByRole('button', { name: /تأكيد إتمام المراجعة اليومية/ }).count()) === 1);
  await page.evaluate(([b, c]) => window.__e2e.createTodayBehindApp(b, c, 1, 9), [ids.batch, ids.cycle]);
  await page.click('#open-revision-modal-btn');
  await page.getByRole('button', { name: 'تأكيد إتمام المراجعة', exact: true }).click();
  await page.waitForTimeout(600);
  const revRows = (await worldTable(page, 'review_confirmations')).filter((r) => r.user_id === ids.m2 && r.legacy_date === TODAY);
  record('stale app: the cancelled review is refused, with the message shown in the dialog', revRows.length === 0 && (await page.locator('#revision-modal-error').innerText()).includes('تحوّل اليوم إلى يوم مراجعة بعيدة'));
  await page.getByRole('button', { name: 'إلغاء', exact: true }).first().click();
  await page.click('#open-recitation-modal-btn');
  await page.selectOption('#listener-select', ids.m3);
  await page.click('#submit-recitation-btn');
  await page.waitForTimeout(600);
  const stale9 = (await worldTable(page, 'tasmia_submissions')).filter((r) => r.user_id === ids.m2 && r.quarter_number === 9);
  record('stale app: the cancelled quarter is refused, with the message shown', stale9.length === 0 && (await page.locator('body').innerText()).includes('تحوّل اليوم إلى يوم مراجعة بعيدة'));
  await page.reload();
  await page.waitForSelector('#notifications-button');
  await page.waitForTimeout(500);
  record('stale app: after a refresh it shows day 8 and the distant review', /اليوم رقم 8/.test(await page.locator('#day-overview').innerText()) && (await page.locator('#distant-review-card').count()) === 1);
  await context.close();

  // ================================================================== today already a rest day
  ({ page, context } = await open(NOON, world({ userId: ids.admin, rest: [TODAY], tasmia: { m1: [1, 2, 3, 4, 5, 6, 7, 8] }, reviews: { m1: [1, 2, 3, 4, 5, 6, 7, 8] } })));
  await openSettings(page);
  await page.fill('#distant-review-date', TODAY);
  await pickRange(page, 1, 9);
  await page.click('#add-distant-review-btn');
  await page.waitForSelector('#distant-today-dialog');
  const restDialog = await page.locator('#distant-today-dialog').innerText();
  record('rest day: the dialog does not announce a cancelled program day', restDialog.includes('إضافة اليوم يومَ مراجعة بعيدة') && !restDialog.includes('إلغاء احتساب') && (await page.locator('#distant-today-count').count()) === 0, restDialog);
  await page.click('#distant-today-yes');
  await page.waitForSelector(`#distant-review-item-${TODAY}`);
  record('rest day: nothing voided; the program day does not move', (await worldTable(page, 'voided_daily_records')).length === 0 && (await dayShown(page, 8)));
  await context.close();

  // ================================================================== peer tests: «إتمام المراجعة» and the conditions text
  const liveTest = {
    id: 'pt-1', cycle_id: ids.cycle, title: 'اختبار الأرباع', range_start: 1, range_end: 5, questions_count: 2, lines_per_question: 5, max_errors: 3, test_type: 'recommended', difficulty: 'any',
    status: 'published', visible_from: null, visible_until: null, audience: 'all', require_all_quarters_completed: true, require_revision_completed: true, created_at: '2026-10-25T00:00:00Z', updated_at: '2026-10-25T00:00:00Z', finished_at: null,
  };
  ({ page, context } = await open(NOON, world({ userId: ids.admin, peerTests: [liveTest], tasmia: { m1: [1, 2, 3, 4, 5, 6, 7, 8] }, reviews: { m1: [1, 2, 3] } })));
  await page.getByRole('button', { name: /اختبار الزملاء/ }).first().click();
  await page.waitForTimeout(300);
  const adminTests = await page.locator('body').innerText();
  record('admin tests list: an old test stored with the flag does not claim it requires reviews', !adminTests.includes('يشترط إتمام المراجعة') && adminTests.includes('اختبار الأرباع'));
  await page.getByRole('button', { name: 'إنشاء اختبار', exact: true }).first().click();
  await page.waitForSelector('#peer-test-revision-note');
  const formText = await page.locator('body').innerText();
  record('admin form: «إتمام المراجعة» is no longer offered; the full-range condition stays', !formText.includes('إتمام المراجعة') && formText.includes('إتمام تسميع جميع أرباع النطاق') && (await page.locator('#peer-test-revision-note').innerText()).includes('لا يمنع تأخر المراجعة الذاتية'));
  await shot(page, 'admin-test-form');
  await context.close();

  ({ page, context } = await open(NOON, world({ userId: ids.m1, peerTests: [liveTest], tasmia: { m1: [1, 2, 3, 4, 5, 6, 7, 8, 9] }, reviews: { m1: [1, 2, 3] } })));
  await page.getByRole('button', { name: /عرض شروط الاختبار/ }).first().click();
  await page.waitForTimeout(300);
  const memberText = await page.locator('body').innerText();
  record('member: conditions state that review delay does not block; Tasmi\'a delay may (masculine wording)', memberText.includes('ولا يمنع تأخر المراجعة الذاتية من دخول الاختبار') && memberText.includes('مؤهلًا') && !memberText.includes('تأخر التسميع أو المراجعة'));
  await context.close();
} catch (e) {
  record('test run completed', false, e?.stack || String(e));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('FAILED:\n' + failed.map((f) => `  ${f.check}  ${f.detail}`).join('\n'));
  process.exitCode = 1;
}
