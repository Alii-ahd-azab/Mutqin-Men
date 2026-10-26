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

async function counts() {
  const c = async (t) => (await service.from(t).select("*", { count: "exact", head: true })).count;
  return {
    profiles: await c("profiles"), tasmia: await c("tasmia_submissions"), reviews: await c("review_confirmations"), attempts: await c("peer_test_attempts"),
    batches: await c("batches"), cycles: await c("cycles"), rest_days: await c("group_rest_days"),
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
    const riyadhDay = (offset) => new Date(Date.now() + 3 * 3600000 - offset * 86400000).toISOString().slice(0, 10);
    const s2 = await service.rpc("create_batch_with_cycle", { p_name: `SMOKE S2 ${randomBytes(3).toString("hex")}`, p_start_date: riyadhDay(9), p_actor: null });
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
    // Controlled UI write: a personal self-test (generation via Edge Function, save via owner RPC)
    await page.locator('button[title="اختبر نفسك (اختبار فردي)"]').click();
    await page.getByRole("button", { name: "ابدأ الاختبار" }).click();
    await page.getByRole("button", { name: "إنهاء الاختبار وحساب الدرجة" }).click({ timeout: 30000 });
    await page.getByRole("button", { name: "نعم، احفظ" }).click();
    await page.waitForTimeout(4000);
    const pts = (await service.from("personal_tests").select("id, grade").eq("member_id", M.id)).data || [];
    record("personal test taken in the UI is stored in Men Supabase", pts.length === 1 && Number(pts[0].grade) === 100, JSON.stringify(pts));
    await page.keyboard.press("Escape");
    await page.goto(URL_APP);
    await page.getByText("SMOKE BROWSER M").first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(3000);
    failed.length = 0; // requests cut off by the test's own reload are expected

    // Edge Function call from the browser origin (CORS + bearer token from the browser session)
    const edge = await page.evaluate(async (base) => {
      const key = Object.keys(localStorage).find((k) => k.startsWith("sb-") && k.endsWith("-auth-token"));
      const token = key ? JSON.parse(localStorage.getItem(key)).access_token : null;
      const r = await fetch(`${base}/functions/v1/peer-tests`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ action: "personal-meta" }) });
      const j = await r.json();
      return { status: r.status, surahs: j.surahs?.length, hasToken: !!token };
    }, url);
    record("Edge Function works from the browser (CORS + session token)", edge.status === 200 && edge.surahs === 114, JSON.stringify(edge));

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
    const riyadh = (offset) => new Date(Date.now() + 3 * 3600000 - offset * 86400000).toISOString().slice(0, 10);
    const sb = await service.rpc("create_batch_with_cycle", { p_name: `SMOKE E2E ${randomBytes(3).toString("hex")}`, p_start_date: riyadh(6), p_actor: null });
    if (sb.error) throw sb.error;
    smokeBatchId = sb.data.id;
    const sCycle = (await service.from("cycles").select("id").eq("batch_id", smokeBatchId).single()).data.id;
    const R = await account("BROWSER R", "000000000013", "member", smokeBatchId);
    await service.from("batch_memberships").update({ joined_at: riyadh(6) + "T00:00:00+03:00" }).eq("user_id", R.id);
    for (const n of [6, 4, 3, 0]) {
      const r = await service.from("review_confirmations").insert({ cycle_id: sCycle, user_id: R.id, legacy_date: riyadh(n) });
      if (r.error) throw r.error;
    }
    for (const n of [3, 0]) await service.from("group_rest_days").insert({ cycle_id: sCycle, rest_date: riyadh(n), reason: "SMOKE" });
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
    await service.from("batch_memberships").update({ joined_at: riyadhDay(9) + "T00:00:00+03:00" }).eq("user_id", R2.id);
    for (const n of [9, 8, 7, 6, 5]) await service.from("review_confirmations").insert({ cycle_id: s2Cycle, user_id: R2.id, legacy_date: riyadhDay(n) });
    await service.from("cycles").update({ legacy_paused_days: 2 }).eq("id", s2Cycle);
    await service.from("review_confirmations").insert({ cycle_id: s2Cycle, user_id: R2.id, legacy_date: riyadhDay(2) });
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
