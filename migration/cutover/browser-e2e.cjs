// Browser end-to-end test of the built Men SPA (served by `vite preview --port 4173`) against Men Supabase.
// Temporary smoke accounts only; everything they create is deleted at the end.
//   npm run build && npx vite preview --port 4173 --strictPort   (separate terminal)
//   BCRYPTJS_PATH=<bcryptjs dir> PLAYWRIGHT_PATH=<playwright dir> node --env-file=.env.local migration/cutover/browser-e2e.cjs
const path = require("path");
const { randomBytes } = require("crypto");
const MEN = process.cwd();
const req = require("module").createRequire(path.join(MEN, "package.json"));
const { createClient } = req("@supabase/supabase-js");
const bcrypt = require(process.env.BCRYPTJS_PATH || "bcryptjs");
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");

const URL_APP = "http://localhost:4173/";
const url = process.env.SUPABASE_URL;
if (!url.includes("uaublandjewfzmhnbflc")) throw new Error("not the Men project");
const service = createClient(url, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const results = [];
const record = (check, ok, detail) => results.push({ check, ok: !!ok, detail });
const email = (p) => `${p}@members.mutqin.local`;

async function counts() {
  const c = async (t) => (await service.from(t).select("*", { count: "exact", head: true })).count;
  return { profiles: await c("profiles"), tasmia: await c("tasmia_submissions"), reviews: await c("review_confirmations"), attempts: await c("peer_test_attempts") };
}

(async () => {
  const before = await counts();
  const authBefore = (await service.auth.admin.listUsers({ perPage: 1000 })).data.users.length;
  const batchId = (await service.from("batches").select("id").is("archived_at", null).limit(1).single()).data.id;
  const created = [];
  async function account(key, phone, role) {
    const pw = randomBytes(12).toString("base64url");
    const { data, error } = await service.auth.admin.createUser({ email: email(phone), email_confirm: true, password_hash: bcrypt.hashSync(pw, 10) });
    if (error) throw error;
    created.push({ id: data.user.id, role });
    const r = await service.rpc("create_profile_with_membership", { p_id: data.user.id, p_full_name: `SMOKE ${key}`, p_phone: phone, p_role: role, p_is_master_admin: role === "admin", p_member_batch_id: role === "member" ? batchId : null, p_admin_batch_ids: [], p_actor: null });
    if (r.error) throw r.error;
    return { id: data.user.id, phone, pw };
  }
  const browser = await chromium.launch();
  try {
    const M = await account("BROWSER M", "000000000011", "member");
    const X = await account("BROWSER X", "000000000012", "admin");

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
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

    await page.reload();
    await page.getByText("SMOKE BROWSER M").first().waitFor({ timeout: 30000 });
    record("session persists across a page reload", true);

    const openBtn = page.locator("#open-revision-modal-btn");
    await openBtn.click({ timeout: 20000 });
    await page.getByRole("button", { name: /تأكيد إتمام المراجعة/ }).click();
    await page.waitForTimeout(4000);
    const revs = (await service.from("review_confirmations").select("legacy_date, start_quarter, end_quarter").eq("user_id", M.id)).data || [];
    record("review recorded through the UI is stored in Men Supabase", revs.length === 1, JSON.stringify(revs));
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

    record("all requests go to the app, Men Supabase or fonts only", [...hosts].every((h) => ["localhost:4173", "uaublandjewfzmhnbflc.supabase.co", "fonts.googleapis.com", "fonts.gstatic.com"].includes(h)), [...hosts].join(", "));
    record("no failed requests", failed.length === 0, failed.join(", "));
    record("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
  } catch (e) {
    record("browser flow", false, e.message.split("\n")[0]);
  } finally {
    await browser.close();
    for (const c of created) {
      if (c.role === "admin") await service.rpc("men_set_account_role", { p_user_id: c.id, p_role: "member", p_batch_id: batchId, p_actor: null });
      await service.rpc("men_delete_member_completely", { p_user_id: c.id });
      await service.auth.admin.deleteUser(c.id);
    }
    const after = await counts();
    const authAfter = (await service.auth.admin.listUsers({ perPage: 1000 })).data.users.length;
    record("cleanup restored every count", JSON.stringify(after) === JSON.stringify(before) && authAfter === authBefore, JSON.stringify({ before, after, authBefore, authAfter }));
    for (const r of results) console.log((r.ok ? "PASS " : "FAIL ") + r.check + (r.ok ? "" : "  — " + (r.detail || "")));
    console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
  }
})();
