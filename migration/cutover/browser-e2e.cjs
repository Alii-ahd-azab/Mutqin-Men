// Browser end-to-end test of the built Men SPA (served by `vite preview --port 4173`) against Men Supabase.
// Temporary smoke accounts only; everything they create is deleted at the end.
//   npm run build && npx vite preview --port 4173 --strictPort   (separate terminal)
//   [APP_URL=https://<deployed site>/] BCRYPTJS_PATH=<bcryptjs dir> PLAYWRIGHT_PATH=<playwright dir> node --env-file=.env.local migration/cutover/browser-e2e.cjs
const path = require("path");
const { randomBytes } = require("crypto");
const MEN = process.cwd();
const req = require("module").createRequire(path.join(MEN, "package.json"));
const { createClient } = req("@supabase/supabase-js");
const bcrypt = require(process.env.BCRYPTJS_PATH || "bcryptjs");
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");

// APP_URL: the deployed site for the final go-live check (default: local `vite preview`).
const URL_APP = process.env.APP_URL || "http://localhost:4173/";
const url = process.env.SUPABASE_URL;
if (!url.includes("uaublandjewfzmhnbflc")) throw new Error("not the Men project");
const service = createClient(url, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const results = [];
const record = (check, ok, detail) => results.push({ check, ok: !!ok, detail });
const email = (p) => `${p}@members.mutqin.local`;

// The program date (day starts at 05:00 Africa/Cairo) `offset` days ago, and the instant a program date
// starts — same rule as supabase/functions/_shared/logic/programDate.ts.
const cairoParts = (d) =>
  Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .formatToParts(d)
      .map((p) => [p.type, p.value])
  );
const addDays = (date, n) => {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const programDay = (offset = 0) => {
  const p = cairoParts(new Date());
  const today = `${p.year}-${p.month}-${p.day}`;
  return addDays(Number(p.hour) < 5 ? addDays(today, -1) : today, -offset);
};
const programDayStart = (date) => {
  const wanted = Date.parse(date + "T05:00:00Z");
  let t = wanted;
  for (let i = 0; i < 3; i++) {
    const p = cairoParts(new Date(t));
    t = wanted - (Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`) - t);
  }
  return new Date(t);
};

async function counts() {
  const c = async (t) => (await service.from(t).select("*", { count: "exact", head: true })).count;
  return {
    profiles: await c("profiles"), tasmia: await c("tasmia_submissions"), reviews: await c("review_confirmations"), attempts: await c("peer_test_attempts"),
    batches: await c("batches"), cycles: await c("cycles"), rest_days: await c("group_rest_days"),
    distant_reviews: await c("distant_review_assignments"), distant_completions: await c("distant_review_completions"),
    notification_states: await c("notification_states"), notification_follows: await c("admin_notification_batch_subscriptions"),
    alert_dismissals: await c("admin_alert_dismissals"),
  };
}

(async () => {
  const before = await counts();
  const authBefore = (await service.auth.admin.listUsers({ perPage: 1000 })).data.users.length;
  const batchId = (await service.from("batches").select("id").is("archived_at", null).limit(1).single()).data.id;
  const created = [];
  let smokeBatchId = null;
  let expectedRefusal = 0;
  const extraBatchIds = [];
  async function account(key, phone, role, memberBatchId = batchId) {
    const pw = randomBytes(12).toString("base64url");
    const { data, error } = await service.auth.admin.createUser({ email: email(phone), email_confirm: true, password_hash: bcrypt.hashSync(pw, 10) });
    if (error) throw error;
    created.push({ id: data.user.id, role });
    const r = await service.rpc("create_profile_with_membership", { p_id: data.user.id, p_full_name: `SMOKE ${key}`, p_phone: phone, p_role: role, p_is_master_admin: role === "admin", p_member_batch_id: role === "member" ? memberBatchId : null, p_admin_batch_ids: [], p_actor: null });
    if (r.error) throw r.error;
    return { id: data.user.id, phone, pw };
  }
  const browser = await chromium.launch();
  let page = null;
  try {
    const M = await account("BROWSER M", "000000000011", "member");
    const X = await account("BROWSER X", "000000000012", "admin");
    const s2 = await service.rpc("create_batch_with_cycle", { p_name: `SMOKE S2 ${randomBytes(3).toString("hex")}`, p_start_date: programDay(9), p_actor: null });
    if (s2.error) throw s2.error;
    extraBatchIds.push(s2.data.id);
    const S2 = s2.data.id;
    const s2Cycle = (await service.from("cycles").select("id").eq("batch_id", S2).single()).data.id;
    const H2 = await account("BROWSER H2", "000000000016", "admin");
    await service.from("profiles").update({ is_master_admin: false }).eq("id", H2.id);
    await service.rpc("set_admin_batches", { p_user_id: H2.id, p_batch_ids: [S2], p_actor: null });

    const ctx = await browser.newContext();
    page = await ctx.newPage();
    // E2E_SHOTS: optional directory for screenshots of the main screens (visual review).
    const shot = async (name) => process.env.E2E_SHOTS && page.screenshot({ path: path.join(process.env.E2E_SHOTS, name + ".png"), fullPage: true });
    const hosts = new Set();
    const consoleErrors = [];
    page.on("request", (r) => { hosts.add(new URL(r.url()).host); });
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    const failed = [];
    page.on("requestfailed", async (r) => (await r.response().catch(() => null)) || failed.push(new URL(r.url()).pathname + " " + (r.failure()?.errorText || "")));

    await page.goto(URL_APP);
    await page.getByText("تسجيل الدخول للمقرأة").waitFor({ timeout: 20000 });
    record("login page loads", true);

    const login = async (acct) => {
      await page.locator("input").nth(0).fill(acct.phone);
      await page.locator("input").nth(1).fill(acct.pw);
      await page.locator('button[type="submit"]').click();
    };
    // Wrong password first
    await login({ phone: M.phone, pw: "wrong-password" });
    await page.getByText("رقم الهاتف أو كلمة المرور غير صحيحة").waitFor({ timeout: 20000 });
    record("wrong password shows the Arabic error", true);

    consoleErrors.length = 0; // the 400 above is the expected answer to the wrong password
    await login(M);
    await page.getByText("SMOKE BROWSER M").first().waitFor({ timeout: 30000 });
    record("member signs in (imported bcrypt hash) and the dashboard loads", true);
    const batchName = (await service.from("batches").select("name").eq("id", batchId).single()).data.name;
    await page.getByText(batchName).first().waitFor({ timeout: 20000 });
    record("member dashboard shows his batch (Sisters multi-batch)", true);
    await shot("member");

    await page.reload();
    await page.getByText("SMOKE BROWSER M").first().waitFor({ timeout: 30000 });
    record("session persists across a page reload", true);

    // On an active day the member confirms today's review; on a rest/pause day (the real batch may be
    // paused) there is no new obligation and no "today" card (Sisters rule, no duplicated range).
    await page.locator("#open-revision-modal-btn, #revision-no-obligation-status, #revision-completed-status").first().waitFor({ timeout: 20000 });
    if (await page.locator("#open-revision-modal-btn").count()) {
      await page.locator("#open-revision-modal-btn").click();
      await page.getByRole("button", { name: "تأكيد إتمام المراجعة", exact: true }).click();
      await page.waitForTimeout(4000);
      const revs = (await service.from("review_confirmations").select("legacy_date, start_quarter, end_quarter").eq("user_id", M.id)).data || [];
      record("review recorded through the UI is stored in Men Supabase", revs.length === 1, JSON.stringify(revs));
    } else {
      record("rest/pause day: no new review card for a member with nothing overdue", (await page.locator("#revision-no-obligation-status").count()) === 1);
    }
    failed.length = 0; // requests cut off by the reload below are expected
    // «اختبر نفسك» is gone (header button, menu entry and dashboard card); the bell takes its place.
    record("«اختبر نفسك» header button is gone", (await page.locator('button[title="اختبر نفسك (اختبار فردي)"]').count()) === 0);
    await page.getByText("SMOKE BROWSER M").first().click();
    record("«اختبر نفسك» is nowhere in the app (no dashboard card, no menu entry)", (await page.getByText("اختبر نفسك").count()) === 0);
    await page.keyboard.press("Escape");
    await page.getByText("SMOKE BROWSER M").first().click();
    record("member sees the notification button in its place", (await page.locator("#notifications-button").count()) === 1);

    // Edge Function call from the browser origin (CORS + bearer token); the personal-test action is gone.
    expectedRefusal = consoleErrors.length; // the browser logs the 400 this check expects
    const edge = await page.evaluate(async (base) => {
      const key = Object.keys(localStorage).find((k) => k.startsWith("sb-") && k.endsWith("-auth-token"));
      const token = key ? JSON.parse(localStorage.getItem(key)).access_token : null;
      const r = await fetch(`${base}/functions/v1/peer-tests`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ action: "personal-meta" }) });
      const j = await r.json();
      return { status: r.status, error: j.error, hasToken: !!token };
    }, url);
    record("Edge Function works from the browser (CORS + session token); the personal-test action is removed", edge.status === 400 && edge.error === "إجراء غير معروف" && edge.hasToken, JSON.stringify(edge));
    consoleErrors.splice(expectedRefusal);

    // Logout through the header menu
    await page.getByText("SMOKE BROWSER M").first().click();
    await page.getByText(/تسجيل الخروج/).first().click();
    await page.getByText("تسجيل الدخول للمقرأة").waitFor({ timeout: 20000 });
    record("logout returns to the login page", true);
    await page.waitForTimeout(3000);

    await login(X);
    await page.getByText("لوحة تحكم المشرف").first().waitFor({ timeout: 30000 });
    record("admin signs in and the admin dashboard loads", true);
    // Read the members count straight away: the previous member's data must never be shown.
    const firstLabel = await page.getByText(/إدارة الأعضاء \(\d+\)/).first().textContent();
    record("admin dashboard never shows the previous member's data", Number((firstLabel.match(/\((\d+)\)/) || [])[1]) === before.profiles + 2, firstLabel);
    await page.getByText(/إدارة الأعضاء \(\d+\)/).first().click();
    const membersLabel = await page.getByText(/إدارة الأعضاء \(\d+\)/).first().textContent();
    const shown = Number((membersLabel.match(/\((\d+)\)/) || [])[1]);
    record("admin sees every account (30 real + 2 smoke), not cached member data", shown === before.profiles + 2, membersLabel);

    // Sisters admin layer: batch selector, admin accounts, peer-test form with the Men audience fields.
    await page.getByText("الدفعة الحالية").first().waitFor({ timeout: 20000 });
    record("admin batch selector is shown", true);
    await shot("admin-today");
    await page.getByText(/الإعدادات والإيقاف/).first().click();
    await page.getByText("المشرفين وصلاحيات الدفعات").first().waitFor({ timeout: 20000 });
    await page.getByText("SMOKE BROWSER X").first().waitFor({ timeout: 20000 });
    record("master admin manages admin accounts and batch permissions", true);
    await shot("admin-settings");
    await page.getByText("تسجيل فترة إيقاف سابقة").first().waitFor({ timeout: 20000 });
    record("Men pause-period tool is available", true);
    await page.getByRole("button", { name: /اختبار الزملاء/ }).first().click();
    await page.getByText(/اختبارات الدورة الحالية/).first().waitFor({ timeout: 20000 });
    await page.getByRole("button", { name: "إنشاء اختبار" }).click();
    await page.getByText("الأعضاء المشمولون بالاختبار").waitFor({ timeout: 20000 });
    await page.getByRole("button", { name: "أعضاء مختارون" }).click();
    await page.getByText("SMOKE BROWSER M").first().waitFor({ timeout: 20000 });
    await page.getByText("إتمام تسميع جميع أرباع النطاق").waitFor({ timeout: 20000 });
    record("peer-test form offers the Men audience and prerequisites", true);
    await shot("admin-peer-form");
    await page.getByRole("button", { name: "إلغاء" }).first().click();

    // ---- Fresh-start member created through the UI in the selected batch ----
    const mainCycle = (await service.from("cycles").select("id").eq("batch_id", batchId).eq("status", "active").single()).data.id;
    const groupQuarter = Number((await page.locator("text=/الربع المطلوب اليوم:/").first().textContent()).match(/الربع (\d+)/)[1]);
    await page.getByText(/إدارة الأعضاء \(\d+\)/).first().click();
    await page.getByRole("button", { name: /إضافة عضو جديد/ }).first().click();
    const fPw = randomBytes(9).toString("base64url");
    await page.locator("#new-member-name").fill("SMOKE BROWSER F");
    await page.locator("#new-member-phone").fill("000000000017");
    await page.locator("#new-member-password").fill(fPw);
    await page.locator("#new-member-fresh-start").check();
    await page.locator("#confirm-add-member-btn").click();
    await page.locator("#confirm-add-member-btn").waitFor({ state: "detached", timeout: 30000 });
    const fRow = (await service.from("profiles").select("id").eq("phone", "000000000017").single()).data;
    created.push({ id: fRow.id, role: "member" });
    const fMem = (await service.from("batch_memberships").select("start_quarter, start_cycle_id").eq("user_id", fRow.id).single()).data;
    record("admin creates a fresh-start member from the UI (baseline = batch quarter)", fMem.start_quarter === groupQuarter && fMem.start_cycle_id === mainCycle, JSON.stringify({ groupQuarter, fMem }));

    // ---- Rename through the UI (master admin) ----
    await page.locator("#batch-selector").selectOption(S2);
    await page.locator("#open-rename-batch-btn").click();
    const masterName = `SMOKE S2 ماستر ${randomBytes(2).toString("hex")}`;
    await page.locator("#rename-batch-input").fill(masterName);
    await page.locator("#confirm-rename-batch-btn").click();
    await page.locator(`#batch-selector option:text-is("${masterName}")`).waitFor({ state: "attached", timeout: 20000 });
    record("master admin renames a batch in the UI and the selector shows it immediately", (await service.from("batches").select("name").eq("id", S2).single()).data.name === masterName);

    // ---- Regression: rest days added after reviews (temporary smoke batch, real data untouched) ----
    // Batch started 6 days ago (d0..d6 = today). Reviews on d0, d2, d3 and d6; then the admin adds rest
    // days on d3 (retroactive) and d6 (today). Active days: d0 d1 d2 d4 d5 (program days 1..5). Review
    // identity: the d3 row holds range 1→4 (stored before d3 became a rest day) → day 4; the row on the
    // rest day d6 → day 5 (its date). Genuinely missed: only day 2 (d1). No "today" card on the rest day.
    const sb = await service.rpc("create_batch_with_cycle", { p_name: `SMOKE E2E ${randomBytes(3).toString("hex")}`, p_start_date: programDay(6), p_actor: null });
    if (sb.error) throw sb.error;
    smokeBatchId = sb.data.id;
    const sCycle = (await service.from("cycles").select("id").eq("batch_id", smokeBatchId).single()).data.id;
    const R = await account("BROWSER R", "000000000013", "member", smokeBatchId);
    await service.from("batch_memberships").update({ joined_at: programDay(6) + "T00:00:00+03:00" }).eq("user_id", R.id);
    for (const n of [6, 4, 3, 0]) {
      const r = await service.from("review_confirmations").insert({ cycle_id: sCycle, user_id: R.id, legacy_date: programDay(n) });
      if (r.error) throw r.error;
    }
    for (const n of [3, 0]) await service.from("group_rest_days").insert({ cycle_id: sCycle, rest_date: programDay(n), reason: "SMOKE" });
    const rCtx = await browser.newContext();
    const rPage = await rCtx.newPage();
    page = rPage; // failure screenshots show the active page
    rPage.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    await rPage.goto(URL_APP);
    await rPage.getByText("تسجيل الدخول للمقرأة").waitFor({ timeout: 20000 });
    await rPage.locator("input").nth(0).fill(R.phone);
    await rPage.locator("input").nth(1).fill(R.pw);
    await rPage.locator('button[type="submit"]').click();
    await rPage.getByText("SMOKE BROWSER R").first().waitFor({ timeout: 30000 });
    await rPage.locator("#open-revision-modal-btn").waitFor({ timeout: 20000 });
    const endOf = async () => Number((await rPage.locator('div:text-is("إلى الربع") + div').first().textContent()).trim());
    const overdueEnd = await endOf();
    const counters = await rPage.getByText(/^\s*\d+ من \d+\s*$/).count();
    if (process.env.E2E_SHOTS) await rPage.screenshot({ path: path.join(process.env.E2E_SHOTS, "rest-day-reviews.png"), fullPage: true });
    record("after adding rest days: only the genuinely missed review is overdue (no false overdue)", counters === 0 && /متأخر/.test(await rPage.locator("#open-revision-modal-btn").textContent()), String(counters));
    record("the overdue card is the unreviewed day with its own range (1→2)", overdueEnd === 2, String(overdueEnd));
    record("no duplicated 'today' review card on the rest day", (await rPage.getByRole("button", { name: /تأكيد إتمام المراجعة اليومية/ }).count()) === 0);
    await rCtx.close();

    // ---- Historical false overdue repaired (S2, started 9 days ago: d0..d9 = today) ----
    // The member reviews d0..d4; the batch then records 2 undated paused days (as the migrated program
    // did), so dates d5/d6 were not real program days; he reviews d7 and skips d8. The old date-based
    // matching showed d5 and d6 as overdue although their ranges were completed; only d8 is genuine.
    const R2 = await account("BROWSER R2", "000000000018", "member", S2);
    await service.from("batch_memberships").update({ joined_at: programDay(9) + "T00:00:00+03:00" }).eq("user_id", R2.id);
    for (const n of [9, 8, 7, 6, 5]) await service.from("review_confirmations").insert({ cycle_id: s2Cycle, user_id: R2.id, legacy_date: programDay(n) });
    await service.from("cycles").update({ legacy_paused_days: 2 }).eq("id", s2Cycle);
    await service.from("review_confirmations").insert({ cycle_id: s2Cycle, user_id: R2.id, legacy_date: programDay(2) });
    const rRows = (await service.from("review_confirmations").select("legacy_date, end_quarter").eq("user_id", R2.id).order("legacy_date")).data;
    const r2Ctx = await browser.newContext();
    const r2 = await r2Ctx.newPage();
    page = r2; // failure screenshots show the active page
    r2.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    await r2.goto(URL_APP);
    await r2.locator("input").nth(0).fill(R2.phone);
    await r2.locator("input").nth(1).fill(R2.pw);
    await r2.locator('button[type="submit"]').click();
    await r2.getByText("SMOKE BROWSER R2").first().waitFor({ timeout: 30000 });
    await r2.getByText(/^\s*1 من \d+\s*$/).first().waitFor({ timeout: 20000 });
    const r2Counter = (await r2.getByText(/^\s*1 من \d+\s*$/).first().textContent()).trim();
    const r2End = Number((await r2.locator('div:text-is("إلى الربع") + div').first().textContent()).trim());
    if (process.env.E2E_SHOTS) await r2.screenshot({ path: path.join(process.env.E2E_SHOTS, "historical-repair.png"), fullPage: true });
    record("historical completed reviews are not overdue; the genuine gap is the only overdue card", r2Counter === "1 من 2" && r2End === 7, JSON.stringify({ r2Counter, r2End, rRows }));
    // A member has no authority to rename a batch (server-side, from his own session).
    expectedRefusal = consoleErrors.length; // the browser logs the refusal this check expects
    const memberRename = await r2.evaluate(async ({ base, batch }) => {
      const key = Object.keys(localStorage).find((k) => k.startsWith("sb-") && k.endsWith("-auth-token"));
      const token = JSON.parse(localStorage.getItem(key)).access_token;
      const r = await fetch(`${base}/functions/v1/admin-actions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ action: "rename-batch", batch_id: batch, name: "x" }) });
      return r.status;
    }, { base: url, batch: S2 });
    record("member cannot rename a batch", memberRename === 403, String(memberRename));
    consoleErrors.splice(expectedRefusal);
    await r2Ctx.close();

    // ---- Fresh-start member: starts at the batch quarter, no earlier debt, sequential from there ----
    const fCtx = await browser.newContext();
    const fp = await fCtx.newPage();
    page = fp; // failure screenshots show the active page
    fp.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    await fp.goto(URL_APP);
    await fp.locator("input").nth(0).fill("000000000017");
    await fp.locator("input").nth(1).fill(fPw);
    await fp.locator('button[type="submit"]').click();
    await fp.getByText("SMOKE BROWSER F").first().waitFor({ timeout: 30000 });
    await fp.getByText(`الربع رقم ${groupQuarter}`).first().waitFor({ timeout: 20000 });
    const debtAlert = await fp.getByText("تنبيه بوجود أوراد متأخرة يلزم استدراكها").count();
    record("fresh-start member: first required quarter is the batch quarter, no old debt shown", debtAlert === 0, `alerts: ${debtAlert}`);
    expectedRefusal = consoleErrors.length; // the browser logs the refusal this check expects
    const skip = await fp.evaluate(async ({ base, key, cycle, me, listener, q }) => {
      const k = Object.keys(localStorage).find((x) => x.startsWith("sb-") && x.endsWith("-auth-token"));
      const token = JSON.parse(localStorage.getItem(k)).access_token;
      const r = await fetch(`${base}/rest/v1/tasmia_submissions`, { method: "POST", headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${token}` }, body: JSON.stringify({ cycle_id: cycle, user_id: me, listener_id: listener, quarter_number: q }) });
      return { status: r.status, body: await r.text() };
    }, { base: url, key: process.env.SUPABASE_PUBLISHABLE_KEY, cycle: mainCycle, me: fRow.id, listener: M.id, q: groupQuarter + 1 });
    record("fresh-start member cannot skip his first quarter", skip.status >= 400, skip.body.slice(0, 120));
    consoleErrors.splice(expectedRefusal);
    await fp.locator("#open-recitation-modal-btn").click();
    await fp.locator("#listener-select").selectOption(M.id);
    await fp.locator("#submit-recitation-btn").click();
    await fp.waitForTimeout(4000);
    const fRecs = (await service.from("tasmia_submissions").select("quarter_number").eq("user_id", fRow.id)).data || [];
    record("fresh-start member records quarter N through the UI", fRecs.length === 1 && fRecs[0].quarter_number === groupQuarter, JSON.stringify(fRecs));
    await fCtx.close();
    // A member created without the option keeps the normal baseline.
    const mMem = (await service.from("batch_memberships").select("start_quarter").eq("user_id", M.id).single()).data;
    record("member created without the option: normal baseline (quarter 1)", mMem.start_quarter === null);

    // ---- Batch admin: renames his assigned batch in the UI; another batch is refused ----
    const hCtx = await browser.newContext();
    const hp = await hCtx.newPage();
    page = hp; // failure screenshots show the active page
    hp.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    await hp.goto(URL_APP);
    await hp.locator("input").nth(0).fill(H2.phone);
    await hp.locator("input").nth(1).fill(H2.pw);
    await hp.locator('button[type="submit"]').click();
    await hp.getByText("لوحة تحكم المشرف").first().waitFor({ timeout: 30000 });
    await hp.locator("#open-rename-batch-btn").click();
    const adminName = `SMOKE S2 مشرف ${randomBytes(2).toString("hex")}`;
    await hp.locator("#rename-batch-input").fill(adminName);
    await hp.locator("#confirm-rename-batch-btn").click();
    await hp.locator(`#batch-selector option:text-is("${adminName}")`).waitFor({ state: "attached", timeout: 20000 });
    record("assigned batch admin renames his batch in the UI", (await service.from("batches").select("name").eq("id", S2).single()).data.name === adminName);
    expectedRefusal = consoleErrors.length; // the browser logs the refusal this check expects
    const otherRename = await hp.evaluate(async ({ base, batch }) => {
      const key = Object.keys(localStorage).find((k) => k.startsWith("sb-") && k.endsWith("-auth-token"));
      const token = JSON.parse(localStorage.getItem(key)).access_token;
      const r = await fetch(`${base}/functions/v1/admin-actions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ action: "rename-batch", batch_id: batch, name: "x" }) });
      return r.status;
    }, { base: url, batch: batchId });
    record("batch admin cannot rename an unassigned batch", otherRename === 403, String(otherRename));
    consoleErrors.splice(expectedRefusal);
    const realName = (await service.from("batches").select("name").eq("id", batchId).single()).data.name;
    record("real batch name untouched", realName.length > 0 && !realName.startsWith("SMOKE"));
    await hCtx.close();

    // ---- «المراجعة البعيدة» (temporary batch S3 started 6 days ago: d0..d6 = today) ----
    const s3 = await service.rpc("create_batch_with_cycle", { p_name: `SMOKE S3 ${randomBytes(3).toString("hex")}`, p_start_date: programDay(6), p_actor: null });
    if (s3.error) throw s3.error;
    extraBatchIds.push(s3.data.id);
    const S3 = s3.data.id;
    const s3Cycle = (await service.from("cycles").select("id").eq("batch_id", S3).single()).data.id;
    const DM = await account("BROWSER DM", "000000000019", "member", S3);
    await service.from("batch_memberships").update({ joined_at: programDay(6) + "T00:00:00+03:00" }).eq("user_id", DM.id);
    await service.from("group_rest_days").insert({ cycle_id: s3Cycle, rest_date: programDay(-5), reason: "SMOKE" });
    const xCtx = await browser.newContext();
    const xp = await xCtx.newPage();
    page = xp; // failure screenshots show the active page
    xp.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    await xp.goto(URL_APP);
    await xp.locator("input").nth(0).fill(X.phone);
    await xp.locator("input").nth(1).fill(X.pw);
    await xp.locator('button[type="submit"]').click();
    await xp.getByText("لوحة تحكم المشرف").first().waitFor({ timeout: 30000 });
    await xp.locator("#batch-selector").selectOption(S3);
    await xp.getByText(/الإعدادات والإيقاف/).first().click();
    await xp.locator("#distant-review-section").waitFor({ timeout: 20000 });
    const order = await xp.evaluate(() => {
      const h = [...document.querySelectorAll("h3")].map((x) => x.textContent.trim());
      return [h.findIndex((t) => t.startsWith("التحكم في سريان البرنامج")), h.findIndex((t) => t === "المراجعة البعيدة"), h.findIndex((t) => t.startsWith("أيام الاستدراك والراحة المحددة مسبقًا"))];
    });
    record("distant-review section sits between program pause control and rest days", order[0] >= 0 && order[0] < order[1] && order[1] < order[2], JSON.stringify(order));
    const rows = async () => (await service.from("distant_review_assignments").select("review_date, start_quarter, end_quarter, note").eq("batch_id", S3).order("review_date")).data || [];
    const pick = async (id, query) => {
      await xp.locator(`#${id}-button`).click();
      await xp.locator(`#${id}-search`).fill(query);
      await xp.locator(`#${id}-search`).press("Enter");
    };
    // Labels: the colored «من» / «إلى» chip + «الربع», no second copy of the word.
    const labels = await xp.evaluate(() => ["distant-from", "distant-to"].map((id) => document.querySelector(`label[for="${id}-button"]`).innerText.replace(/\s+/g, " ").trim()));
    const formText = await xp.locator("#distant-review-form").innerText();
    record("no duplicated من/إلى: labels are «من الربع» / «إلى الربع» once each", labels[0] === "من الربع" && labels[1] === "إلى الربع" && !/من\s+من/.test(formText) && !/إلى\s+إلى/.test(formText), JSON.stringify(labels));
    // FROM 1 / TO 9: stop at the BEGINNING of quarter 9 (2:142), never at quarter 10 (2:158).
    await xp.locator("#distant-from-button").click();
    await xp.locator("#distant-from-search").fill("9");
    const meta9 = await xp.locator("#distant-from-option-9").innerText();
    record("quarter option metadata: الجزء • الحزب • الصفحة • الآية", /الجزء 2 • الحزب 3 • الصفحة 22 • الآية 142/.test(meta9), meta9);
    await xp.locator("#distant-from-search").fill("1");
    await xp.locator("#distant-from-search").press("Enter");
    await xp.locator("#distant-to-button").click();
    record("TO cannot equal FROM (it is the stopping boundary)", (await xp.locator("#distant-to-option-1").getAttribute("aria-disabled")) === "true");
    await xp.locator("#distant-to-search").fill("9");
    const toMeta = await xp.locator("#distant-to-option-9").innerText();
    await xp.locator("#distant-to-search").press("Enter");
    const p19 = await xp.locator("#distant-review-preview").innerText();
    record("TO selector options carry the page too", /الصفحة 22/.test(toMeta), toMeta);
    record("FROM 1 / TO 9 preview: starts at quarter 1, stops at the BEGINNING of quarter 9 (2:142), not quarter 10", /من بداية الربع 1 حتى بداية الربع 9/.test(p19) && /توقف عند:\s*بداية الربع 9 — سورة البقرة - الآية 142/.test(p19) && /سَيَقُولُ/.test(p19) && !/الآية 158/.test(p19) && /8 أرباع/.test(p19), p19.replace(/\s+/g, " ").slice(0, 300));
    await shot("admin-distant-preview-1-9");
    // First day: search FROM by number, TO by number; preview; note; add.
    await xp.locator("#distant-review-date").fill(programDay(-3));
    await xp.locator("#distant-from-button").click();
    await xp.locator("#distant-from-search").fill("23");
    const firstHit = await xp.locator('#distant-from-list [role="option"]').first().getAttribute("id");
    const hitText = await xp.locator('#distant-from-list [role="option"]').first().textContent();
    record("searchable FROM selector: typing 23 finds «الربع 23» first, with surah and opening", firstHit === "distant-from-option-23" && /الربع 23 — آل عمران — بداية:/.test(hitText), hitText);
    await xp.locator("#distant-from-search").press("Enter");
    await xp.locator("#distant-to-button").click();
    const disabledBefore = await xp.locator("#distant-to-option-5").getAttribute("aria-disabled");
    record("TO selector cannot go before FROM", disabledBefore === "true", disabledBefore);
    await xp.locator("#distant-to-search").fill("البقرة");
    const surahHits = await xp.locator('#distant-to-list [role="option"]').count();
    await xp.locator("#distant-to-search").fill("30");
    await xp.locator("#distant-to-search").press("Enter");
    record("search by surah name works too", surahHits > 10, String(surahHits));
    const preview = await xp.locator("#distant-review-preview").textContent();
    record("range preview «المراجعة المطلوبة» shows the chosen range and its bounds", /المراجعة المطلوبة/.test(preview) && /من بداية الربع 23 حتى بداية الربع 30/.test(preview) && /ابدأ من/.test(preview) && /توقف عند/.test(preview), preview.slice(0, 120));
    await xp.locator("#distant-review-note").fill("SMOKE مراجعة ما سبق قبل الاختبار");
    await xp.locator("#add-distant-review-btn").click();
    await xp.locator("#distant-review-msg").waitFor({ timeout: 20000 });
    let r = await rows();
    record("admin adds ONE distant-review day from the UI", r.length === 1 && r[0].review_date === programDay(-3) && r[0].start_quarter === 23 && r[0].end_quarter === 30 && r[0].note === "SMOKE مراجعة ما سبق قبل الاختبار", JSON.stringify(r));
    const formReset = (await xp.locator("#distant-review-date").inputValue()) === "" && (await xp.locator("#distant-review-preview").count()) === 0;
    record("form resets after adding", formReset);
    // Second, separate day.
    await xp.locator("#distant-review-date").fill(programDay(-10));
    await pick("distant-from", "1");
    await pick("distant-to", "12");
    await xp.locator("#add-distant-review-btn").click();
    await xp.locator(`#distant-review-item-${programDay(-10)}`).waitFor({ timeout: 20000 });
    r = await rows();
    record("a second day is created manually as its own assignment", r.length === 2 && r[1].review_date === programDay(-10) && r[1].start_quarter === 1 && r[1].end_quarter === 12, JSON.stringify(r));
    // Validation and conflict messages.
    await xp.locator("#distant-review-date").fill(programDay(-3));
    await pick("distant-from", "1");
    await pick("distant-to", "2");
    await xp.locator("#add-distant-review-btn").click();
    const dupMsg = await xp.locator("#distant-review-error").textContent();
    record("conflict message: a second distant review on the same date", /يوجد يوم مراجعة بعيدة/.test(dupMsg), dupMsg);
    record("the refused attempt wrote nothing", (await rows()).length === 2);
    await xp.locator("#distant-review-date").fill(programDay(-5));
    await xp.locator("#add-distant-review-btn").click();
    await xp.locator(`#distant-review-item-${programDay(-5)}`).waitFor({ timeout: 20000 });
    const onRest = (await rows()).find((x) => x.review_date === programDay(-5));
    record("a distant review can be scheduled on a rest-day date (it takes priority)", !!onRest && /تبقى مطلوبة رغم الإيقاف\/الراحة/.test(await xp.locator(`#distant-review-item-${programDay(-5)}`).textContent()));
    await service.from("distant_review_assignments").delete().eq("batch_id", S3).eq("review_date", programDay(-5));
    await xp.reload();
    await xp.getByText("لوحة تحكم المشرف").first().waitFor({ timeout: 30000 });
    await xp.locator("#batch-selector").selectOption(S3);
    await xp.getByText(/الإعدادات والإيقاف/).first().click();
    await xp.locator("#distant-review-section").waitFor({ timeout: 20000 });
    // Edit a future day, then delete another.
    await xp.locator(`#edit-distant-${programDay(-10)}`).click();
    await pick("distant-to", "15");
    await xp.locator("#distant-review-note").fill("SMOKE تعديل");
    await xp.locator("#add-distant-review-btn").click();
    await xp.locator("#distant-review-msg").waitFor({ timeout: 20000 });
    r = await rows();
    record("admin edits a future day (range and note)", r.length === 2 && r[1].end_quarter === 15 && r[1].note === "SMOKE تعديل", JSON.stringify(r));
    await xp.locator(`#delete-distant-${programDay(-3)}`).click();
    await xp.locator(`#confirm-delete-distant-${programDay(-3)}`).click();
    await xp.locator(`#distant-review-item-${programDay(-3)}`).waitFor({ state: "detached", timeout: 20000 });
    r = await rows();
    record("admin deletes a future day", r.length === 1 && r[0].review_date === programDay(-10), JSON.stringify(r));
    await shot("admin-distant-review");

    // Member: yesterday's day (missed) and today's day (written by the service role; the UI schedules future dates only).
    const dIns = await service.from("distant_review_assignments").insert([
      { cycle_id: s3Cycle, batch_id: S3, review_date: programDay(1), start_quarter: 1, end_quarter: 4 },
      { cycle_id: s3Cycle, batch_id: S3, review_date: programDay(0), start_quarter: 5, end_quarter: 8, note: "SMOKE مراجعة اليوم" },
      { cycle_id: s3Cycle, batch_id: S3, review_date: programDay(-1), start_quarter: 9, end_quarter: 12, note: "SMOKE مراجعة الغد" },
    ]).select("id, review_date");
    if (dIns.error) throw dIns.error;
    const dmCtx = await browser.newContext();
    const dp = await dmCtx.newPage();
    page = dp; // failure screenshots show the active page
    dp.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    await dp.goto(URL_APP);
    await dp.locator("input").nth(0).fill(DM.phone);
    await dp.locator("input").nth(1).fill(DM.pw);
    await dp.locator('button[type="submit"]').click();
    await dp.getByText("SMOKE BROWSER DM").first().waitFor({ timeout: 30000 });
    await dp.locator("#distant-review-banner").waitFor({ timeout: 20000 });
    const banner = await dp.locator("#distant-review-banner").textContent();
    record("member banner: today is a distant-review day, normal progression paused, range shown", /اليوم راحة من التقدم المعتاد للبرنامج/.test(banner) && /من بداية الربع 5 حتى بداية الربع 8/.test(banner), banner.slice(0, 160));
    const dayTitle = await dp.getByText(/^اليوم رقم \d+$/).first().textContent();
    record("normal progression paused: 2 distant days do not advance the program day (5, not 7)", dayTitle.trim() === "اليوم رقم 5", dayTitle);
    record("no new normal daily-review card today", (await dp.getByRole("button", { name: /تأكيد إتمام المراجعة اليومية/ }).count()) === 0);
    record("separate distant-review debt indicator", /مراجعات بعيدة متأخرة: 1/.test(await dp.locator("#distant-overdue-alert").textContent()));
    const counter = (await dp.locator("#distant-review-counter").textContent()).trim();
    const firstTitle = await dp.locator("#distant-review-title").textContent();
    record("missed distant review is overdue, separate from today's (1 من 2)", counter === "1 من 2" && /مراجعة بعيدة متأخرة/.test(firstTitle) && (await dp.locator("#distant-review-to").textContent()).trim() === "4", `${counter} ${firstTitle}`);
    await shot("member-distant-overdue");
    await dp.locator("#distant-next").click();
    const todayTitle = (await dp.locator("#distant-review-title").textContent()).trim();
    const todayRange = [(await dp.locator("#distant-review-from").textContent()).trim(), (await dp.locator("#distant-review-to").textContent()).trim()];
    record("today's distant-review card: range and admin note", todayTitle === "المراجعة البعيدة" && todayRange.join("-") === "5-8" && /SMOKE مراجعة اليوم/.test(await dp.locator("#distant-review-note-text").textContent()), `${todayTitle} ${todayRange}`);
    await shot("member-distant-today");
    // Notifications: today's distant-review day (range + note) and the missed one, separately.
    await dp.locator("#notifications-button").click();
    await dp.locator("#notification-distant-day").waitFor({ timeout: 15000 });
    const dDay = (await dp.locator("#notification-distant-day").textContent()).replace(/\s+/g, " ");
    const dOver = (await dp.locator("#notification-distant-overdue").textContent()).replace(/\s+/g, " ");
    const dTom = (await dp.locator("#notification-distant-tomorrow").textContent()).replace(/\s+/g, " ");
    record("tomorrow's distant review: non-urgent notice with its date, range and note", /غدًا مراجعة بعيدة/.test(dTom) && /من بداية الربع 9 حتى بداية الربع 12/.test(dTom) && /SMOKE مراجعة الغد/.test(dTom) && (await dp.locator("#notification-distant-tomorrow").getAttribute("data-urgent")) === "false", dTom);
    record("distant-review day notification shows the required range and the admin note", /اليوم مراجعة بعيدة/.test(dDay) && /المطلوب: من بداية الربع 5 حتى بداية الربع 8/.test(dDay) && /SMOKE مراجعة اليوم/.test(dDay) && /متوقف اليوم/.test(dDay), dDay);
    const dRev = await dp.locator("#notification-revision-overdue").count() ? (await dp.locator("#notification-revision-overdue").textContent()) : "";
    record("missed distant review has its own overdue notification, separate from the normal review", /لديك مراجعة بعيدة متأخرة/.test(dOver) && !/بعيدة/.test(dRev), `${dOver} | ${dRev}`);
    await shot("member-distant-notifications");
    await dp.locator("#notification-distant-overdue").click();
    await dp.waitForTimeout(800);
    record("distant overdue notification opens the overdue distant-review card", /مراجعة بعيدة متأخرة/.test(await dp.locator("#distant-review-title").textContent()) && (await dp.locator("#distant-review-counter").textContent()).trim() === "1 من 2");
    await dp.locator("#notifications-button").click();
    await dp.locator("#notification-distant-day").click();
    await dp.waitForTimeout(800);
    const focusedTitle = (await dp.locator("#distant-review-title").textContent()).trim();
    const focusedInView = await dp.locator("#distant-review-card").evaluate((el) => { const r = el.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; });
    record("distant-review day notification opens today's distant-review card (not the normal review)", focusedTitle === "المراجعة البعيدة" && focusedInView && (await dp.locator("#distant-review-counter").textContent()).trim() === "2 من 2", focusedTitle);
    await dp.locator("#complete-distant-review-btn").click();
    await dp.locator("#distant-confirm-yes").click();
    await dp.waitForFunction(() => !document.querySelector("#distant-review-counter"), null, { timeout: 20000 });
    const dmDone = async () => (await service.from("distant_review_completions").select("assignment_id, completed_on").eq("user_id", DM.id)).data || [];
    let comps = await dmDone();
    const tId = dIns.data.find((x) => x.review_date === programDay(0)).id;
    const yId = dIns.data.find((x) => x.review_date === programDay(1)).id;
    record("member confirms today's distant review from the UI", comps.length === 1 && comps[0].assignment_id === tId && comps[0].completed_on === programDay(0), JSON.stringify(comps));
    record("the missed one stays owed after today's confirmation", /مراجعة بعيدة متأخرة/.test(await dp.locator("#distant-review-title").textContent()));
    await dp.locator("#complete-distant-review-btn").click();
    await dp.locator("#distant-confirm-yes").click();
    await dp.locator("#distant-review-completed-status").waitFor({ timeout: 20000 });
    comps = await dmDone();
    record("late completion through the UI removes the debt", comps.length === 2 && comps.some((c) => c.assignment_id === yId && c.completed_on === programDay(0)) && (await dp.locator("#distant-overdue-alert").count()) === 0, JSON.stringify(comps));
    await dp.locator("#history-tab-distant").click();
    const lateRow = await dp.locator(`#distant-history-${programDay(1)}`).textContent();
    const todayRow = await dp.locator(`#distant-history-${programDay(0)}`).textContent();
    record("history: late entry shows assigned and actual dates; today's shows done", /تم الإنجاز \(متأخرًا\)/.test(lateRow) && /موعدها/.test(lateRow) && /تمت/.test(lateRow) && /تم الإنجاز/.test(todayRow) && /من بداية الربع 5 حتى بداية الربع 8/.test(todayRow), `${lateRow.slice(0, 120)} | ${todayRow.slice(0, 80)}`);
    await shot("member-distant-history");
    await dmCtx.close();

    // Admin history: today's day is view-only with its completion statistics.
    page = xp;
    await xp.reload();
    await xp.getByText("لوحة تحكم المشرف").first().waitFor({ timeout: 30000 });
    await xp.locator("#batch-selector").selectOption(S3);
    await xp.getByText(/الإعدادات والإيقاف/).first().click();
    await xp.locator(`#distant-review-stats-${programDay(0)}`).waitFor({ timeout: 20000 });
    const stats = await xp.locator(`#distant-review-stats-${programDay(0)}`).textContent();
    const todayItem = await xp.locator(`#distant-review-item-${programDay(0)}`).textContent();
    record("admin history: today's day shows status, completion statistics and is view-only", /1 \/ 1 أتموا المراجعة/.test(stats) && /اليوم/.test(todayItem) && /عرض فقط/.test(todayItem) && (await xp.locator(`#edit-distant-${programDay(0)}`).count()) === 0, `${stats} | ${todayItem.slice(0, 120)}`);
    await xCtx.close();


    // ================= Notifications (members and batch admins; never master admins) =================
    const plain = (s) => (s || "").replace(/\s+/g, " ").trim();
    async function openAs(acct, ctxOptions = {}, beforeGoto) {
      const c = await browser.newContext(ctxOptions);
      const p = await c.newPage();
      page = p; // failure screenshots show the active page
      p.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
      // Requests cancelled by our own reloads (ERR_ABORTED) are expected; anything else is a failure.
      p.on("requestfailed", async (r) => {
        if ((await r.response().catch(() => null)) || /ERR_ABORTED/.test(r.failure()?.errorText || "")) return;
        failed.push(new URL(r.url()).pathname + " " + (r.failure()?.errorText || ""));
      });
      if (beforeGoto) await beforeGoto(p);
      await p.goto(URL_APP);
      await p.locator("input").nth(0).fill(acct.phone);
      await p.locator("input").nth(1).fill(acct.pw);
      await p.locator('button[type="submit"]').click();
      return { c, p };
    }
    const openBell = async (p) => {
      if (!(await p.locator("#notifications-panel").count())) await p.locator("#notifications-button").click();
      await p.locator("#notifications-panel").waitFor({ timeout: 15000 });
    };
    const inView = (p, sel) => p.locator(sel).evaluate((el) => { const r = el.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; });
    const mkBatch = async (label, startOffset) => {
      const r = await service.rpc("create_batch_with_cycle", { p_name: `SMOKE ${label} ${randomBytes(3).toString("hex")}`, p_start_date: programDay(startOffset), p_actor: null });
      if (r.error) throw r.error;
      extraBatchIds.push(r.data.id);
      const cyc = (await service.from("cycles").select("id").eq("batch_id", r.data.id).single()).data.id;
      return { id: r.data.id, name: r.data.name, cycle: cyc };
    };
    // Joined on that program date (its Makkah calendar date is the same day at noon).
    const joinOn = (acct, offset) => service.from("batch_memberships").update({ joined_at: programDay(offset) + "T12:00:00+03:00" }).eq("user_id", acct.id);
    const recite = async (b, acct, listener, quarters) => {
      for (const q of quarters) {
        const r = await service.from("tasmia_submissions").insert({ cycle_id: b.cycle, user_id: acct.id, listener_id: listener.id, quarter_number: q });
        if (r.error) throw new Error(`tasmia ${q}: ${r.error.message}`);
      }
    };
    const reviewOn = async (b, acct, offsets) => {
      for (const n of offsets) {
        const r = await service.from("review_confirmations").insert({ cycle_id: b.cycle, user_id: acct.id, legacy_date: programDay(n) });
        if (r.error) throw new Error(`review ${programDay(n)}: ${r.error.message}`);
      }
    };
    const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

    // Batch S4 (H4's): started 10 days ago (d10..d0 = today, program day 11, no rest days).
    //   N : Tasmi'a 1..7 (quarters 8, 9, 10 missed: 3 days), every review but d2 (1 day).
    //   N2: every quarter, reviews missing d5 d4 d3 (3 days) — listener for N.
    // Batch S6 (also H4's): N6 with reviews missing d3 d2 d1 (3 days).
    // Batch S5 (NOT H4's): N5 with 4 days of review debt — must never reach H4.
    const S4 = await mkBatch("S4", 10);
    const S5 = await mkBatch("S5", 10);
    const S6 = await mkBatch("S6", 10);
    const N = await account("BROWSER N", "000000000020", "member", S4.id);
    const N2 = await account("BROWSER N2", "000000000021", "member", S4.id);
    const N5 = await account("BROWSER N5", "000000000022", "member", S5.id);
    const N6 = await account("BROWSER N6", "000000000023", "member", S6.id);
    const L6 = await account("BROWSER L6", "000000000024", "member", S6.id);
    const L5 = await account("BROWSER L5", "000000000025", "member", S5.id);
    for (const a of [N, N2, N5, N6, L6, L5]) await joinOn(a, 10);
    await recite(S4, N2, N, range(1, 10));
    await recite(S4, N, N2, range(1, 7));
    await reviewOn(S4, N, range(0, 10).filter((n) => n !== 2 && n !== 0));
    await reviewOn(S4, N2, range(0, 10).filter((n) => ![5, 4, 3, 0].includes(n)));
    await recite(S6, N6, L6, range(1, 10));
    await reviewOn(S6, N6, range(0, 10).filter((n) => ![3, 2, 1, 0].includes(n)));
    await recite(S5, N5, L5, range(1, 10));
    await reviewOn(S5, N5, range(0, 10).filter((n) => ![4, 3, 2, 1, 0].includes(n)));
    const H4 = await account("BROWSER H4", "000000000026", "admin");
    await service.from("profiles").update({ is_master_admin: false }).eq("id", H4.id);
    await service.rpc("set_admin_batches", { p_user_id: H4.id, p_batch_ids: [S4.id, S6.id], p_actor: null });

    // ---- Member N: urgent Tasmi'a (red, 3 days), light review (1 day), tomorrow's rest day ----
    await service.from("group_rest_days").insert({ cycle_id: S4.cycle, rest_date: programDay(-1), reason: "SMOKE راحة الغد" });
    const badgeText = async (p) => ((await p.locator("#notifications-badge").count()) ? plain(await p.locator("#notifications-badge").textContent()) : "0");
    // Badge anchored to the bell icon: its centre is right of and above the bell's centre, near its top-right corner.
    const badgeGeometry = (p) =>
      p.evaluate(() => {
        const b = document.querySelector("#notifications-badge").getBoundingClientRect();
        const s = document.querySelector("#notifications-bell svg").getBoundingClientRect();
        const label = [...document.querySelectorAll("#notifications-button > span")].pop().getBoundingClientRect();
        const cx = b.left + b.width / 2;
        const cy = b.top + b.height / 2;
        return { rightOfBell: cx > s.left + s.width / 2, aboveBell: cy < s.top + s.height / 2, nearTopRight: Math.hypot(cx - s.right, cy - s.top) < 14, notOnLabel: cx > label.right };
      });
    const isRed = (p) => p.locator("#notifications-button").evaluate((el) => el.dataset.urgent === "true" && el.className.includes("bg-rose-600") && !!el.querySelector("#notifications-urgent-icon"));
    const archivedTexts = async (p) => {
      await p.locator("#notifications-view-all").click();
      await p.locator("#notifications-history").waitFor({ timeout: 10000 });
      await p.locator("#notifications-tab-archived").click();
      const items = await p.locator("#notifications-archive .archived-notification").evaluateAll((els) => els.map((e) => e.textContent.replace(/\s+/g, " ")));
      await p.keyboard.press("Escape");
      await p.locator('#notifications-history button[title="إغلاق"]').click();
      return items;
    };

    const n = await openAs(N);
    await n.p.getByText("SMOKE BROWSER N").first().waitFor({ timeout: 30000 });
    await n.p.locator("#notifications-badge").waitFor({ timeout: 20000 });
    record("member: 3 unread (urgent Tasmi'a, review, tomorrow's rest day) and the whole control is red with «!»", (await badgeText(n.p)) === "3" && (await isRed(n.p)), await badgeText(n.p));
    const geo = await badgeGeometry(n.p);
    record("badge sits at the visual top-right of the bell icon (not on the «التنبيهات» label), in RTL", geo.rightOfBell && geo.aboveBell && geo.nearTopRight && geo.notOnLabel, JSON.stringify(geo));
    await shot("member-bell-urgent");
    await openBell(n.p);
    const tas = n.p.locator("#notification-tasmia-overdue");
    const rev = n.p.locator("#notification-revision-overdue");
    const restT = n.p.locator("#notification-rest-tomorrow");
    record("3 missed Tasmi'a days: serious red warning (elimination risk, urgent)", (await tas.getAttribute("data-tone")) === "serious" && (await tas.getAttribute("data-urgent")) === "true" && /تنبيه شديد: لديك 3 أيام متأخرة في التسميع/.test(await tas.textContent()) && /الاستبعاد/.test(await tas.textContent()), plain(await tas.textContent()));
    record("1 missed review day: light yellow warning (non-urgent)", (await rev.getAttribute("data-tone")) === "light" && (await rev.getAttribute("data-urgent")) === "false" && /لديك يوم مراجعة متأخر/.test(await rev.textContent()), plain(await rev.textContent()));
    record("tomorrow's rest day: non-urgent informational notice", (await restT.getAttribute("data-tone")) === "info" && /غدًا يوم راحة من التقدم المعتاد للبرنامج/.test(await restT.textContent()) && /SMOKE راحة الغد/.test(await restT.textContent()), plain(await restT.textContent()));
    const tasBg = await tas.evaluate((el) => getComputedStyle(el).backgroundColor);
    const revBg = await rev.evaluate((el) => getComputedStyle(el).backgroundColor);
    record("Tasmi'a and review are separate notifications (red vs yellow), never one merged number", tasBg !== revBg && (await tas.count()) === 1 && (await rev.count()) === 1, `${tasBg} | ${revBg}`);
    await n.p.waitForTimeout(1500);
    record("opening the panel: non-urgent become seen, the urgent one still counts → badge 1, still red", (await badgeText(n.p)) === "1" && (await isRed(n.p)) && (await tas.getAttribute("data-unread")) === "true" && (await restT.getAttribute("data-unread")) === "false", await badgeText(n.p));
    record("opening the panel archives nothing (all 3 still in the active list)", (await n.p.locator('#notifications-panel [id^="notification-"]').count()) === 3);
    await shot("member-notifications-panel");
    // Phone width: the panel stays inside the screen, no horizontal page scroll.
    await n.p.setViewportSize({ width: 390, height: 844 });
    await n.p.waitForTimeout(300);
    const panelBox = await n.p.locator("#notifications-panel").boundingBox();
    const noHScroll = await n.p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    record("notification panel fits a phone screen (390 px)", !!panelBox && panelBox.x >= 0 && panelBox.x + panelBox.width <= 390 && noHScroll, JSON.stringify(panelBox));
    await shot("member-notifications-mobile");
    await n.p.setViewportSize({ width: 1280, height: 720 });
    // Reload: the seen state persisted (badge 1, not 3).
    await n.p.reload();
    await n.p.locator("#notifications-badge").waitFor({ timeout: 30000 });
    await n.p.waitForTimeout(1500);
    record("seen state persists across a reload (badge stays 1)", (await badgeText(n.p)) === "1");
    // Review notification → archived + the overdue review card of that exact day.
    await openBell(n.p);
    await n.p.locator("#notification-revision-overdue").click();
    await n.p.waitForTimeout(1000);
    const revTitle = plain(await n.p.locator("#revision-card h3").first().textContent());
    record("review notification opens the overdue review card of the missed day", (await inView(n.p, "#revision-card")) && revTitle.includes("مراجعة متأخرة") && revTitle.includes(String(Number(programDay(2).slice(8)))), revTitle);
    // Tasmi'a (urgent, 3 days) → deep link; a member's 3+ warning STAYS in the active panel.
    await openBell(n.p);
    record("clicked (non-urgent) notification left the active list", (await n.p.locator("#notification-revision-overdue").count()) === 0);
    await n.p.locator("#notification-tasmia-overdue").click();
    await n.p.waitForTimeout(1000);
    record("Tasmi'a notification opens the Tasmi'a card on the first missed quarter", (await inView(n.p, "#tasmia-card")) && /الربع رقم 8/.test(await n.p.locator("#tasmia-card").textContent()));
    await openBell(n.p);
    record("member 3+ warning stays in the active panel after a click (read, badge 0) and the control stays red", (await n.p.locator("#notification-tasmia-overdue").count()) === 1 && (await n.p.locator("#notification-tasmia-overdue").getAttribute("data-unread")) === "false" && (await badgeText(n.p)) === "0" && (await isRed(n.p)));
    await shot("member-red-persistent");
    await n.p.reload();
    await n.p.getByText("SMOKE BROWSER N").first().waitFor({ timeout: 30000 });
    await n.p.waitForTimeout(2000);
    await openBell(n.p);
    record("after a reload the 3+ warning is still active and the control still red", (await n.p.locator("#notification-tasmia-overdue").count()) === 1 && (await isRed(n.p)));
    // Rest-tomorrow click → archived; «عرض كل التنبيهات» lists the archived (non-urgent) items.
    await n.p.locator("#notification-rest-tomorrow").click();
    await n.p.waitForTimeout(800);
    await openBell(n.p);
    let archived = await archivedTexts(n.p);
    record("«عرض كل التنبيهات» shows the clicked non-urgent notifications as archived (date and category); the 3+ warning is not archived", archived.length === 2 && archived.some((t) => /مراجعة متأخرة/.test(t)) && archived.some((t) => /يوم راحة غدًا/.test(t)) && !archived.some((t) => /تسميع متأخر/.test(t)) && archived.every((t) => /فُتح في/.test(t)), JSON.stringify(archived));
    await shot("member-history");
    // Persistence across logout/login (new browser session).
    await n.c.close();
    const n2 = await openAs(N);
    await n2.p.getByText("SMOKE BROWSER N").first().waitFor({ timeout: 30000 });
    await n2.p.waitForTimeout(2500);
    await openBell(n2.p);
    const n2Active = await n2.p.locator('#notifications-panel [id^="notification-"]').evaluateAll((els) => els.map((e) => e.id));
    archived = await archivedTexts(n2.p);
    record("after logout/login: archive state kept, only the 3+ warning is active, read, still red", archived.length === 2 && JSON.stringify(n2Active) === JSON.stringify(["notification-tasmia-overdue"]) && (await badgeText(n2.p)) === "0" && (await isRed(n2.p)), JSON.stringify({ n2Active, archived: archived.length }));
    const nRows = (await service.from("notification_states").select("notification_key, seen_at, archived_at").eq("user_id", N.id)).data || [];
    record("one stored row per notification key (3): the 3+ warning seen but not archived, the others archived", nRows.length === 3 && nRows.filter((r) => r.archived_at).length === 2 && nRows.every((r) => r.seen_at) && nRows.some((r) => /tasmia:serious/.test(r.notification_key) && !r.archived_at), JSON.stringify(nRows.map((r) => r.notification_key)));
    // Catching up: 3 → 2 → the red state disappears; the new (orange) warning is a new notification.
    await recite(S4, N, N2, [8]);
    await n2.p.reload();
    await n2.p.locator("#notifications-badge").waitFor({ timeout: 30000 });
    await openBell(n2.p);
    record("debt 3 → 2: red state gone, a new orange warning appears", !(await isRed(n2.p)) && (await n2.p.locator("#notification-tasmia-overdue").getAttribute("data-tone")) === "strong" && /لديك يومان متأخران في التسميع/.test(await n2.p.locator("#notification-tasmia-overdue").textContent()));
    await recite(S4, N, N2, [9]);
    await n2.p.reload();
    await n2.p.getByText("SMOKE BROWSER N").first().waitFor({ timeout: 30000 });
    await openBell(n2.p);
    await n2.p.locator("#notification-tasmia-overdue").waitFor({ timeout: 20000 });
    record("then 1 day → light yellow warning", (await n2.p.locator("#notification-tasmia-overdue").getAttribute("data-tone")) === "light");
    await recite(S4, N, N2, [10]);
    await reviewOn(S4, N, [2]);
    await n2.p.reload();
    await n2.p.getByText("SMOKE BROWSER N").first().waitFor({ timeout: 30000 });
    await n2.p.waitForTimeout(1500);
    await openBell(n2.p);
    record("all debt completed: the overdue notifications disappear (no badge, not red)", (await n2.p.locator("#notification-tasmia-overdue").count()) === 0 && (await n2.p.locator("#notification-revision-overdue").count()) === 0 && (await n2.p.locator("#notifications-empty").count()) === 1 && (await n2.p.locator("#notifications-badge").count()) === 0 && !(await isRed(n2.p)));
    await n2.c.close();

    // ---- Batch admin H4: automatic scope (his two batches), urgent alerts, opens «إدارة الأعضاء» ----
    const N3 = await account("BROWSER N3", "000000000027", "member", S4.id);
    await joinOn(N3, 10);
    await recite(S4, N3, N2, range(1, 7));
    await reviewOn(S4, N3, range(1, 10));
    const N1 = await account("BROWSER N1", "000000000028", "member", S4.id);
    await joinOn(N1, 10);
    await recite(S4, N1, N2, range(1, 8)); // 2 missed Tasmi'a days → no admin alert
    await reviewOn(S4, N1, range(1, 10).filter((x) => x !== 4)); // 1 missed review day → no admin alert
    const h4 = await openAs(H4);
    await h4.p.getByText("لوحة تحكم المشرف").first().waitFor({ timeout: 30000 });
    await h4.p.locator("#notifications-badge").waitFor({ timeout: 30000 });
    await h4.p.waitForFunction(() => document.querySelector("#notifications-badge")?.textContent.trim() === "4", null, { timeout: 30000 }).catch(() => {});
    const h4BadgeBefore = await badgeText(h4.p);
    await openBell(h4.p);
    await h4.p.locator(`#admin-alert-${N6.id}`).waitFor({ timeout: 30000 });
    await h4.p.waitForTimeout(1500);
    const alertIds = await h4.p.locator('#notifications-panel [id^="admin-alert-"]').evaluateAll((els) => els.map((e) => e.id));
    record("batch admin sees the bell, red, with no optional batch-follow settings", (await h4.p.locator("#notifications-button").count()) === 1 && (await isRed(h4.p)) && (await h4.p.locator("#notification-settings-btn").count()) === 0);
    record("batch admin: badge counts members, not categories (4 members, 5 serious categories), unchanged by opening the panel", h4BadgeBefore === "4" && (await badgeText(h4.p)) === "4", `${h4BadgeBefore} → ${await badgeText(h4.p)}`);
    // L6 (S6) never recited or reviewed: genuinely 10 days behind in both, in H4's own batch.
    const expectedAlerts = [N3.id, N2.id, N6.id, L6.id].map((x) => "admin-alert-" + x).sort();
    record("batch admin: one card per member, exactly those of his two batches; none for 1–2 days or an unassigned batch", JSON.stringify([...alertIds].sort()) === JSON.stringify(expectedAlerts) && !alertIds.some((x) => x.includes(N1.id) || x.includes(N5.id) || x.includes(L5.id)), JSON.stringify(alertIds));
    const l6Card = h4.p.locator(`#admin-alert-${L6.id}`);
    const l6Lines = await l6Card.locator(".alert-issue").evaluateAll((els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
    record("a member late in both: ONE card with two bullet lines, one «إدارة العضو», one X", JSON.stringify(l6Lines) === JSON.stringify(["10 أيام متأخرة في التسميع", "10 أيام متأخرة في المراجعة الذاتية"]) && (await l6Card.getByRole("button", { name: "إدارة العضو" }).count()) === 1 && (await l6Card.locator(`#dismiss-alert-${L6.id}`).count()) === 1 && (await l6Card.getByRole("button", { name: "إقصاء مبدئي" }).count()) === 1, JSON.stringify(l6Lines));
    const a3 = plain(await h4.p.locator(`#admin-alert-${N3.id}`).textContent());
    record("alert shows member name, phone, batch, category and count (red), one line when one category", a3.includes("SMOKE BROWSER N3") && a3.includes(N3.phone) && a3.includes(S4.name) && a3.includes("3 أيام متأخرة في التسميع") && (await h4.p.locator(`#admin-alert-${N3.id} .alert-issue`).count()) === 1 && (await h4.p.locator(`#admin-alert-${N3.id}`).getAttribute("data-tone")) === "serious", a3);
    await shot("admin-alerts-panel");
    await h4.p.locator(`#admin-alert-${N3.id}`).getByRole("button", { name: "إدارة العضو" }).click();
    await h4.p.locator(`#member-row-${N3.id}`).waitFor({ timeout: 20000 });
    await h4.p.waitForTimeout(1200);
    record("alert opens «إدارة الأعضاء» focused on that member", (await inView(h4.p, `#member-row-${N3.id}`)) && /notification-focus-row/.test(await h4.p.locator(`#member-row-${N3.id}`).getAttribute("class")), await h4.p.locator(`#member-row-${N3.id}`).getAttribute("class"));
    record("clicking the alert archives it (badge 4 → 3)", (await badgeText(h4.p)) === "3");
    await shot("admin-member-focus");
    await openBell(h4.p);
    await h4.p.locator(`#admin-alert-${N6.id}`).getByRole("button", { name: "إدارة العضو" }).click();
    await h4.p.locator(`#member-row-${N6.id}`).waitFor({ timeout: 30000 });
    await h4.p.waitForTimeout(1200);
    record("alert of his other batch switches batch and focuses the member", (await h4.p.locator("#batch-selector").inputValue()) === S6.id && (await inView(h4.p, `#member-row-${N6.id}`)));
    // X: H4 dismisses N2's whole card (for himself only).
    const n2ReviewsBefore = ((await service.from("review_confirmations").select("id").eq("user_id", N2.id)).data || []).length;
    await openBell(h4.p);
    await h4.p.locator(`#dismiss-alert-${N2.id}`).click();
    await h4.p.waitForTimeout(1500);
    record("X hides the whole member card for this admin (badge 2 → 1)", (await h4.p.locator(`#admin-alert-${N2.id}`).count()) === 0 && (await badgeText(h4.p)) === "1");
    const h4Dismissals = (await service.from("admin_alert_dismissals").select("member_user_id, batch_id").eq("admin_user_id", H4.id)).data || [];
    record("dismissal stored server-side for this admin only", h4Dismissals.length === 1 && h4Dismissals[0].member_user_id === N2.id && h4Dismissals[0].batch_id === S4.id, JSON.stringify(h4Dismissals));
    record("dismissing changes nothing in the member's debt", ((await service.from("review_confirmations").select("id").eq("user_id", N2.id)).data || []).length === n2ReviewsBefore);
    await h4.p.reload();
    await h4.p.getByText("لوحة تحكم المشرف").first().waitFor({ timeout: 30000 });
    await openBell(h4.p);
    await h4.p.locator(`#admin-alert-${L6.id}`).waitFor({ timeout: 30000 });
    record("dismissal persists after a refresh", (await h4.p.locator(`#admin-alert-${N2.id}`).count()) === 0);
    await recite(S4, N3, N2, [8]);
    await h4.p.reload();
    await h4.p.getByText("لوحة تحكم المشرف").first().waitFor({ timeout: 30000 });
    await openBell(h4.p);
    await h4.p.locator(`#admin-alert-${L6.id}`).waitFor({ timeout: 30000 });
    record("member back below 3 days: the admin's serious alert is gone (not in the active list)", (await h4.p.locator(`#admin-alert-${N3.id}`).count()) === 0);
    await h4.c.close();
    const h4b = await openAs(H4);
    await h4b.p.getByText("لوحة تحكم المشرف").first().waitFor({ timeout: 30000 });
    await h4b.p.waitForTimeout(2500);
    await openBell(h4b.p);
    await h4b.p.locator(`#admin-alert-${L6.id}`).waitFor({ timeout: 30000 });
    const stillDismissed = (await h4b.p.locator(`#admin-alert-${N2.id}`).count()) === 0;
    await h4b.p.locator("#notifications-view-all").click();
    await h4b.p.locator("#notifications-tab-dismissed").click();
    await h4b.p.locator(`#dismissed-alert-${N2.id}`).waitFor({ timeout: 15000 });
    const dText = plain(await h4b.p.locator(`#dismissed-alert-${N2.id}`).textContent());
    record("after logout/login the dismissal persists and «المستبعدة» lists it with a restore action", stillDismissed && /SMOKE BROWSER N2/.test(dText) && /التأخر الشديد ما زال قائمًا/.test(dText) && (await h4b.p.locator(`#restore-alert-${N2.id}`).count()) === 1, dText);
    await shot("admin-dismissed-tab");
    await h4b.c.close();

    // ---- Master admin X: bell + «إعدادات التنبيهات»; follows chosen batches only; persisted ----
    const xm = await openAs(X);
    await xm.p.getByText("لوحة تحكم المشرف").first().waitFor({ timeout: 30000 });
    await xm.p.waitForTimeout(2000);
    await openBell(xm.p);
    record("master admin now has the notification button and the settings control", (await xm.p.locator("#notifications-button").count()) === 1 && (await xm.p.locator("#notification-settings-btn").count()) === 1);
    record("master admin follows nothing by default (empty, not red)", (await xm.p.locator("#notifications-empty").count()) === 1 && !(await isRed(xm.p)));
    await xm.p.locator("#notification-settings-btn").click();
    await xm.p.locator("#notification-follow-settings").waitFor({ timeout: 10000 });
    await xm.p.locator(`#follow-batch-${S4.id}`).click();
    await xm.p.waitForFunction((id) => document.querySelector(`#follow-batch-${id}`)?.getAttribute("aria-checked") === "true", S4.id, { timeout: 15000 });
    await shot("master-follow-settings");
    const xFollow = (await service.from("admin_notification_batch_subscriptions").select("batch_id, enabled").eq("admin_user_id", X.id)).data || [];
    record("master admin's choice is stored server-side (S4 on)", xFollow.length === 1 && xFollow[0].batch_id === S4.id && xFollow[0].enabled === true, JSON.stringify(xFollow));
    await xm.p.keyboard.press("Escape");
    await xm.p.locator(`#notifications-badge`).waitFor({ timeout: 30000 });
    await openBell(xm.p);
    await xm.p.locator(`#admin-alert-${N2.id}`).waitFor({ timeout: 30000 });
    let xIds = await xm.p.locator('#notifications-panel [id^="admin-alert-"]').evaluateAll((els) => els.map((e) => e.id));
    record("master admin receives the 3+ alerts of the followed batch only (S4), none from S5/S6", JSON.stringify(xIds) === JSON.stringify([`admin-alert-${N2.id}`]) && (await isRed(xm.p)), JSON.stringify(xIds));
    record("dismissal is per admin: H4 dismissed N2, the master admin still sees N2", (await xm.p.locator(`#admin-alert-${N2.id}`).count()) === 1);
    const xa = plain(await xm.p.locator(`#admin-alert-${N2.id}`).textContent());
    record("master admin alert shows name, phone, batch name, category and count", xa.includes("SMOKE BROWSER N2") && xa.includes(N2.phone) && xa.includes(S4.name) && xa.includes("3 أيام متأخرة في المراجعة"), xa);
    await shot("master-alerts");
    // Change the selection: S4 OFF, S5 ON — persisted across a reload.
    await xm.p.locator("#notification-settings-btn").click();
    await xm.p.locator(`#follow-batch-${S4.id}`).click();
    await xm.p.waitForFunction((id) => document.querySelector(`#follow-batch-${id}`)?.getAttribute("aria-checked") === "false", S4.id, { timeout: 15000 });
    await xm.p.locator(`#follow-batch-${S5.id}`).click();
    await xm.p.waitForFunction((id) => document.querySelector(`#follow-batch-${id}`)?.getAttribute("aria-checked") === "true", S5.id, { timeout: 15000 });
    await xm.p.reload();
    await xm.p.getByText("لوحة تحكم المشرف").first().waitFor({ timeout: 30000 });
    await xm.p.locator(`#notifications-badge`).waitFor({ timeout: 30000 });
    await openBell(xm.p);
    await xm.p.locator(`#admin-alert-${N5.id}`).waitFor({ timeout: 30000 });
    xIds = (await xm.p.locator('#notifications-panel [id^="admin-alert-"]').evaluateAll((els) => els.map((e) => e.id))).sort();
    const expectedX = [N5.id, L5.id].map((x) => "admin-alert-" + x).sort();
    record("new selection persists after reload: alerts now from S5 only (S4 off)", JSON.stringify(xIds) === JSON.stringify(expectedX), JSON.stringify(xIds));
    await xm.p.locator(`#admin-alert-${N5.id}`).getByRole("button", { name: "إدارة العضو" }).click();
    await xm.p.locator(`#member-row-${N5.id}`).waitFor({ timeout: 30000 });
    await xm.p.waitForTimeout(1200);
    record("master admin alert opens «إدارة الأعضاء» of that batch focused on the member", (await xm.p.locator("#batch-selector").inputValue()) === S5.id && (await inView(xm.p, `#member-row-${N5.id}`)));
    await xm.c.close();

    // ---- Batch admin H4 restores N2's alert (still 3+ days → active again) ----
    const h4c = await openAs(H4);
    await h4c.p.getByText("لوحة تحكم المشرف").first().waitFor({ timeout: 30000 });
    await h4c.p.waitForTimeout(2500);
    await openBell(h4c.p);
    await h4c.p.locator("#notifications-view-all").click();
    await h4c.p.locator("#notifications-tab-dismissed").click();
    await h4c.p.locator(`#restore-alert-${N2.id}`).click();
    await h4c.p.waitForFunction((id) => !document.querySelector(`#dismissed-alert-${id}`), N2.id, { timeout: 15000 });
    await h4c.p.locator('#notifications-history button[title="إغلاق"]').click();
    await openBell(h4c.p);
    await h4c.p.locator(`#admin-alert-${N2.id}`).waitFor({ timeout: 15000 });
    const restoredRows = (await service.from("admin_alert_dismissals").select("member_user_id").eq("admin_user_id", H4.id)).data || [];
    record("restore: the member's alert is active again (condition still 3+) and the dismissal row is gone", (await h4c.p.locator(`#admin-alert-${N2.id}`).count()) === 1 && restoredRows.length === 0);
    await h4c.c.close();

    // ---- Member N2: the 3+ REVIEW warning also stays active until the review debt falls below 3 ----
    const m2 = await openAs(N2);
    await m2.p.getByText("SMOKE BROWSER N2").first().waitFor({ timeout: 30000 });
    await m2.p.locator("#notifications-badge").waitFor({ timeout: 30000 });
    await openBell(m2.p);
    const m2Rev = m2.p.locator("#notification-revision-overdue");
    record("member N2: serious review warning (3 days), red control", (await m2Rev.getAttribute("data-tone")) === "serious" && (await isRed(m2.p)));
    await m2Rev.click();
    await m2.p.waitForTimeout(1000);
    record("review warning opens the overdue review card", await inView(m2.p, "#revision-card"));
    await openBell(m2.p);
    record("the 3+ review warning stays active after the click; still red", (await m2.p.locator("#notification-revision-overdue").count()) === 1 && (await isRed(m2.p)));
    await reviewOn(S4, N2, [4]); // 3 → 2 review days
    await m2.p.reload();
    await m2.p.getByText("SMOKE BROWSER N2").first().waitFor({ timeout: 30000 });
    await m2.p.locator("#notifications-badge").waitFor({ timeout: 30000 });
    await openBell(m2.p);
    record("review debt 3 → 2: the serious warning and the red state are gone; the 2-day warning appears", !(await isRed(m2.p)) && (await m2.p.locator("#notification-revision-overdue").getAttribute("data-tone")) === "strong");
    await m2.c.close();

    // ---- «المراجعة البعيدة» during a global pause (S9) and on a rest day (S10) ----
    // S9 started on d6 and is paused since d2 (open pause): program day stays 4. A distant review is
    // scheduled for today: it is required all the same.
    const S9 = await mkBatch("S9", 6);
    const P = await account("BROWSER P", "000000000033", "member", S9.id);
    await joinOn(P, 6);
    { const r = await service.from("program_pauses").insert({ cycle_id: S9.cycle, paused_on: programDay(2) }); if (r.error) throw r.error; }
    const pA = await service.from("distant_review_assignments").insert({ cycle_id: S9.cycle, batch_id: S9.id, review_date: programDay(0), start_quarter: 3, end_quarter: 7, note: "SMOKE رغم الإيقاف" }).select("id").single();
    if (pA.error) throw pA.error;
    const pp = await openAs(P);
    await pp.p.getByText("SMOKE BROWSER P").first().waitFor({ timeout: 30000 });
    await pp.p.locator("#distant-review-card").waitFor({ timeout: 30000 });
    const pDay = plain(await pp.p.getByText(/^اليوم رقم \d+$/).first().textContent());
    record("global pause: today's distant review is still shown and required (normal progression frozen at day 4)", plain(await pp.p.locator("#distant-review-title").textContent()) === "المراجعة البعيدة" && pDay === "اليوم رقم 4" && (await pp.p.locator("#complete-distant-review-btn").count()) === 1, pDay);
    record("global pause: no new normal daily review or Tasmi'a quarter today", (await pp.p.getByRole("button", { name: /تأكيد إتمام المراجعة اليومية/ }).count()) === 0 && /الربع رقم 1\b/.test(await pp.p.locator("#tasmia-card").textContent()));
    await openBell(pp.p);
    const pNote = plain(await pp.p.locator("#notification-distant-day").textContent());
    record("global pause: the distant-review notification appears with its range", /من بداية الربع 3 حتى بداية الربع 7/.test(pNote) && /SMOKE رغم الإيقاف/.test(pNote), pNote);
    await pp.p.keyboard.press("Escape");
    await shot("member-distant-during-pause");
    // Completion asks for confirmation first.
    const pDone = async () => (await service.from("distant_review_completions").select("id").eq("user_id", P.id)).data || [];
    await pp.p.locator("#complete-distant-review-btn").click();
    await pp.p.locator("#distant-confirm-dialog").waitFor({ timeout: 10000 });
    const dialogText = plain(await pp.p.locator("#distant-confirm-dialog").textContent());
    record("completion button opens a confirmation dialog (question, date, range, yes/cancel)", /هل أنت متأكد من إتمام المراجعة البعيدة المطلوبة؟/.test(dialogText) && /من بداية الربع 3 حتى بداية الربع 7/.test(dialogText) && /نعم، تأكيد الإتمام/.test(dialogText) && /إلغاء/.test(dialogText), dialogText);
    await shot("member-distant-confirm-dialog");
    await pp.p.locator("#distant-confirm-cancel").click();
    await pp.p.waitForTimeout(2000);
    record("cancel: nothing submitted, card unchanged", (await pDone()).length === 0 && (await pp.p.locator("#distant-confirm-dialog").count()) === 0 && (await pp.p.locator("#complete-distant-review-btn").count()) === 1);
    await pp.p.locator("#complete-distant-review-btn").click();
    await pp.p.locator("#distant-confirm-yes").dblclick();
    await pp.p.locator("#distant-review-completed-status").waitFor({ timeout: 30000 });
    await pp.p.waitForTimeout(1500);
    record("confirm (double-clicked): exactly one completion, during the pause", (await pDone()).length === 1);
    await pp.c.close();

    // S10 started on d6; today is BOTH a rest day and a distant-review day (now allowed).
    const S10 = await mkBatch("S10", 6);
    const P2 = await account("BROWSER P2", "000000000034", "member", S10.id);
    await joinOn(P2, 6);
    { const r = await service.from("group_rest_days").insert({ cycle_id: S10.cycle, rest_date: programDay(0), reason: "SMOKE راحة" }); if (r.error) throw r.error; }
    const p2A = await service.from("distant_review_assignments").insert({ cycle_id: S10.cycle, batch_id: S10.id, review_date: programDay(0), start_quarter: 2, end_quarter: 6 }).select("id").single();
    record("a rest day and a distant review can share a date (database)", !p2A.error, p2A.error?.message);
    const q2 = await openAs(P2);
    await q2.p.getByText("SMOKE BROWSER P2").first().waitFor({ timeout: 30000 });
    await q2.p.locator("#distant-review-card").waitFor({ timeout: 30000 });
    const q2Day = plain(await q2.p.getByText(/^اليوم رقم \d+$/).first().textContent());
    record("rest day: the distant review is still required; normal progression paused (day 6, counted once)", (await q2.p.locator("#rest-day-banner").count()) === 1 && (await q2.p.locator("#complete-distant-review-btn").count()) === 1 && q2Day === "اليوم رقم 6" && (await q2.p.getByRole("button", { name: /تأكيد إتمام المراجعة اليومية/ }).count()) === 0, q2Day);
    await openBell(q2.p);
    const q2Kinds = await q2.p.locator('#notifications-panel [id^="notification-"]').evaluateAll((els) => els.map((e) => e.id));
    record("rest day + distant review: the distant-review notification takes priority (no separate rest-day notice)", q2Kinds.includes("notification-distant-day") && !q2Kinds.includes("notification-rest-day"), JSON.stringify(q2Kinds));
    await shot("member-distant-on-rest-day");
    await q2.c.close();


    // ---- 05:00 Africa/Cairo: an app left open crosses the boundary (device clock in Los Angeles) ----
    // Fake browser clock at 04:59 Cairo of today, then fast-forwarded past 05:00:00; the app's boundary
    // timer reloads the data by itself (no reload, no new login).
    const boundary = programDayStart(programDay(0)); // today's 05:00 Cairo (already past in real time)
    const clocked = async (acct) =>
      openAs(acct, { timezoneId: "America/Los_Angeles" }, async (p) => {
        await p.clock.install({ time: new Date(boundary.getTime() - 60000) });
      });
    const dayAndDate = async (p) => ({
      day: plain(await p.getByText(/^اليوم رقم \d+$/).first().textContent()),
      date: plain(await p.getByText(/الموافق \d{4}-\d{2}-\d{2}م/).first().textContent()),
    });
    const panelKinds = (p) => p.locator('#notifications-panel [id^="notification-"]').evaluateAll((els) => els.map((e) => `${e.id.replace("notification-", "")}:${e.dataset.tone}`));

    // S7 started on d2. T recited quarter 1 and reviewed d2 only. Before 05:00 today the program date
    // is d1 (day 2): quarter 2 and d1's review are TODAY's, not overdue. At 05:00 the program date is d0
    // (day 3): they become overdue — Tasmi'a and review, each its own light warning.
    const S7 = await mkBatch("S7", 2);
    const T = await account("BROWSER T", "000000000029", "member", S7.id);
    const T2 = await account("BROWSER T2", "000000000030", "member", S7.id);
    for (const a of [T, T2]) await joinOn(a, 2);
    await recite(S7, T, T2, [1]);
    await reviewOn(S7, T, [2]);
    const t = await clocked(T);
    await t.p.getByText("SMOKE BROWSER T").first().waitFor({ timeout: 30000 });
    const tBefore = await dayAndDate(t.p);
    await openBell(t.p);
    const tBeforeKinds = await panelKinds(t.p);
    record("04:59 Cairo: previous program day still active (day 2, its date), its obligations not overdue", tBefore.day === "اليوم رقم 2" && tBefore.date.includes(`الموافق ${programDay(1)}م`) && tBeforeKinds.length === 0 && (await t.p.locator("#notifications-empty").count()) === 1, JSON.stringify({ tBefore, tBeforeKinds }));
    await t.p.keyboard.press("Escape");
    await t.p.clock.fastForward(90000); // crosses 05:00:00 Cairo
    await t.p.getByText("اليوم رقم 3").first().waitFor({ timeout: 30000 });
    const tAfter = await dayAndDate(t.p);
    await openBell(t.p);
    await t.p.locator("#notification-tasmia-overdue").waitFor({ timeout: 20000 });
    const tAfterKinds = await panelKinds(t.p);
    record("05:00 Cairo: the new program day appears by itself (day 3, its date)", tAfter.day === "اليوم رقم 3" && tAfter.date.includes(`الموافق ${programDay(0)}م`), JSON.stringify(tAfter));
    const laDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(boundary.getTime() + 30000));
    record("the device's own time zone is ignored (Los Angeles is still on the previous date at 05:00 Cairo)", laDate !== programDay(0) && tAfter.date.includes(`الموافق ${programDay(0)}م`), laDate);
    record("05:00 Cairo: the previous day's Tasmi'a and review become overdue only now (separate light warnings)", JSON.stringify(tAfterKinds.sort()) === JSON.stringify(["revision-overdue:light", "tasmia-overdue:light"]), JSON.stringify(tAfterKinds));
    await t.c.close();

    // S8 started on d2 with a rest day on d0 (today). T8 is fully up to date. At 04:59 there is no rest
    // day yet; at 05:00 the rest day becomes today, with its informational notification.
    const S8 = await mkBatch("S8", 2);
    const T8 = await account("BROWSER T8", "000000000031", "member", S8.id);
    const T9 = await account("BROWSER T9", "000000000032", "member", S8.id);
    for (const a of [T8, T9]) await joinOn(a, 2);
    await service.from("group_rest_days").insert({ cycle_id: S8.cycle, rest_date: programDay(0), reason: "SMOKE راحة" });
    await recite(S8, T8, T9, [1, 2]);
    await reviewOn(S8, T8, [2, 1]);
    const r8 = await clocked(T8);
    await r8.p.getByText("SMOKE BROWSER T8").first().waitFor({ timeout: 30000 });
    await r8.p.getByText(/^اليوم رقم \d+$/).first().waitFor({ timeout: 30000 }); // the batch data has loaded
    await openBell(r8.p);
    await r8.p.locator("#notification-rest-tomorrow").waitFor({ timeout: 15000 }).catch(() => {});
    const r8Before = { rest: await r8.p.locator("#rest-day-banner").count(), kinds: await panelKinds(r8.p), ...(await dayAndDate(r8.p)) };
    record("04:59 Cairo: the rest day is not active yet — it is still tomorrow's notice", r8Before.rest === 0 && JSON.stringify(r8Before.kinds) === JSON.stringify(["rest-tomorrow:info"]) && r8Before.date.includes(`الموافق ${programDay(1)}م`), JSON.stringify(r8Before));
    await r8.p.keyboard.press("Escape");
    await r8.p.clock.fastForward(90000);
    await r8.p.locator("#rest-day-banner").waitFor({ timeout: 30000 });
    await openBell(r8.p);
    await r8.p.locator("#notification-rest-day").waitFor({ timeout: 20000 });
    const r8After = await panelKinds(r8.p);
    const restText = plain(await r8.p.locator("#notification-rest-day").textContent());
    record("05:00 Cairo: the rest day becomes today, with an informational (non-warning) notification", JSON.stringify(r8After) === JSON.stringify(["rest-day:info"]) && (await r8.p.getByText(`الموافق ${programDay(0)}م`).count()) > 0, JSON.stringify(r8After));
    record("rest-day notification: no new Tasmi'a or review today, old debts remain, admin note shown", /اليوم يوم استدراك وراحة/.test(restText) && /لا ربع تسميع جديد ولا مراجعة يومية جديدة/.test(restText) && /يبقى مطلوبًا/.test(restText) && /SMOKE راحة/.test(restText), restText);
    await shot("member-rest-day-notification");
    await r8.p.locator("#notification-rest-day").click();
    await r8.p.waitForTimeout(800);
    record("rest-day notification opens the rest-day banner", await inView(r8.p, "#rest-day-banner"));
    await r8.c.close();

    record("all requests go to the app, Men Supabase or fonts only", [...hosts].every((h) => [new URL(URL_APP).host, "uaublandjewfzmhnbflc.supabase.co", "fonts.googleapis.com", "fonts.gstatic.com"].includes(h)), [...hosts].join(", "));
    record("no failed requests", failed.length === 0, failed.join(", "));
    record("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
  } catch (e) {
    // E2E_SCREENSHOT: optional file path for a screenshot of the page at the failure.
    if (page && process.env.E2E_SCREENSHOT) await page.screenshot({ path: process.env.E2E_SCREENSHOT, fullPage: true }).catch(() => {});
    record("browser flow", false, e.message.split("\n")[0]);
  } finally {
    await browser.close();
    for (const c of created) {
      if (c.role === "admin") await service.rpc("men_set_account_role", { p_user_id: c.id, p_role: "member", p_batch_id: batchId, p_actor: null });
      await service.rpc("men_delete_member_completely", { p_user_id: c.id });
      await service.auth.admin.deleteUser(c.id);
    }
    for (const b of [smokeBatchId, ...extraBatchIds].filter(Boolean)) {
      await service.from("daily_thoughts").delete().eq("batch_id", b);
      await service.from("cycles").delete().eq("batch_id", b);
      const { error } = await service.from("batches").delete().eq("id", b);
      if (error) console.error("cleanup batch", error.message);
    }
    const after = await counts();
    const authAfter = (await service.auth.admin.listUsers({ perPage: 1000 })).data.users.length;
    record("cleanup restored every count", JSON.stringify(after) === JSON.stringify(before) && authAfter === authBefore, JSON.stringify({ before, after, authBefore, authAfter }));
    for (const r of results) console.log((r.ok ? "PASS " : "FAIL ") + r.check + (r.ok ? "" : "  — " + (r.detail || "")));
    console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
  }
})();
