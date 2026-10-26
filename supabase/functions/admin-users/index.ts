import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

import {
  corsHeaders,
  json,
  HttpError,
  isUuid,
  createAdminClient,
  getAdminCaller,
  canManageBatch,
  canChangeAccountPassword,
  requireMaster,
  requireManagedBatch,
  getMemberBatchId,
  errorResponse,
  type AdminCaller,
} from '../_shared/auth.ts';
import { normalizePhone, phoneToAuthEmail } from '../_shared/men/authIdentity.ts';
import { mapUser, PROFILE_COLUMNS, type ProfileRow } from '../_shared/men/menRows.ts';

/*
 * ACCOUNT MANAGEMENT (admins). Same actions and rules as Mutqin for Sisters' admin-users
 * (master admins and batch admins, batch assignments, moving a member to another batch);
 * Men differences:
 *   - an account may be switched between member and admin (Men feature);
 *   - "delete completely" also removes the member's test attempts (as examiner too), audience
 *     selections and personal tests, in one database transaction.
 */

/* A list of batch IDs sent by a master admin: UUIDs of existing, non-archived batches. */
async function validateBatchIds(admin: SupabaseClient, value: unknown): Promise<string[]> {
  if (!Array.isArray(value)) throw new HttpError('قائمة الدفعات غير صالحة', 400);
  const ids = Array.from(new Set(value));
  if (ids.length === 0) throw new HttpError('يرجى اختيار دفعة واحدة على الأقل', 400);
  if (!ids.every(isUuid)) throw new HttpError('معرف دفعة غير صالح', 400);
  const { data, error } = await admin.from('batches').select('id').in('id', ids).is('archived_at', null);
  if (error) throw new HttpError(error.message, 500);
  if ((data || []).length !== ids.length) throw new HttpError('إحدى الدفعات المختارة غير موجودة', 400);
  return ids as string[];
}

async function loadProfile(admin: SupabaseClient, userId: string): Promise<ProfileRow> {
  const { data, error } = await admin.from('profiles').select(PROFILE_COLUMNS).eq('id', userId).maybeSingle();
  if (error) throw new HttpError(error.message, 500);
  if (!data) throw new HttpError('العضو غير موجود', 404);
  return data as ProfileRow;
}

/*
 * Who may manage an existing account (Sisters rule):
 * - members: master admins, or admins of the member's batch
 * - admins: master admins only (an admin may also edit his own basic data)
 */
async function requireCanManageAccount(admin: SupabaseClient, caller: AdminCaller, target: ProfileRow) {
  if (target.role === 'admin') {
    if (!caller.isMaster && target.id !== caller.id) throw new HttpError('ليس لديك صلاحية لتعديل هذا الحساب', 403);
    return;
  }
  if (caller.isMaster) return;
  const batchId = await getMemberBatchId(admin, target.id);
  if (!batchId || !canManageBatch(caller, batchId)) throw new HttpError('لا تملك صلاحية إدارة هذا العضو', 403);
}

function authErrorMessage(error: { message: string; code?: string }): { message: string; status: number } {
  const lowered = error.message.toLowerCase();
  if (error.code === 'email_exists' || lowered.includes('already')) return { message: 'رقم الهاتف هذا مسجل بالفعل لعضو آخر', status: 409 };
  if (error.code === 'weak_password' || lowered.includes('password')) {
    return { message: 'كلمة المرور غير مقبولة، اختر كلمة مرور أقوى (6 أحرف على الأقل)', status: 400 };
  }
  return { message: 'تعذر تحديث بيانات الدخول. حاول مرة أخرى.', status: 500 };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    const admin = createAdminClient();
    // Verify the caller's session and that they are an ACTIVE ADMIN.
    const caller = await getAdminCaller(req, admin);
    const body = await req.json();
    const action = body?.action;

    // ================= CREATE MEMBER / ADMIN =================
    if (action === 'create') {
      const name = String(body.name || '').trim();
      const phone = normalizePhone(body.phone || '');
      const password = String(body.password || '').trim();
      const role = body.role === 'admin' ? 'admin' : 'member';

      if (!name || !phone || !password) return json({ error: 'الاسم ورقم الهاتف وكلمة المرور مطلوبة' }, 400);
      if (password.length < 6) return json({ error: 'يجب ألا تقل كلمة المرور عن 6 خانات' }, 400);

      // Resolve and authorize the batch assignment BEFORE creating anything.
      let memberBatchId: string | null = null;
      let isMasterAdmin = false;
      let adminBatchIds: string[] = [];
      if (role === 'member') {
        memberBatchId = (await requireManagedBatch(admin, caller, body.batch_id)).id;
      } else {
        // Only a master admin may create admin accounts of any type.
        requireMaster(caller);
        isMasterAdmin = body.is_master_admin === true;
        if (!isMasterAdmin) adminBatchIds = await validateBatchIds(admin, body.batch_ids);
      }

      const { data: createdAuth, error: createAuthError } = await admin.auth.admin.createUser({
        email: phoneToAuthEmail(phone),
        password,
        email_confirm: true,
        user_metadata: { full_name: name },
      });
      if (createAuthError || !createdAuth.user) {
        const { message, status } = authErrorMessage(createAuthError || { message: 'تعذر إنشاء الحساب' });
        return json({ error: message }, status === 500 ? 400 : status);
      }
      const newUserId = createdAuth.user.id;

      // Profile + batch membership(s) in ONE database transaction (Sisters function).
      const { error: profileError } = await admin.rpc('create_profile_with_membership', {
        p_id: newUserId,
        p_full_name: name,
        p_phone: phone,
        p_role: role,
        p_is_master_admin: isMasterAdmin,
        p_member_batch_id: memberBatchId,
        p_admin_batch_ids: adminBatchIds,
        p_actor: caller.id,
      });
      if (profileError) {
        // Roll back the Auth user so no orphan login is left behind.
        const { error: rollbackError } = await admin.auth.admin.deleteUser(newUserId);
        if (rollbackError) console.error('admin-users rollback failed:', newUserId, rollbackError);
        return json(
          { error: profileError.code === '23505' ? 'رقم الهاتف هذا مسجل بالفعل لعضو آخر' : 'تعذر إنشاء ملف العضو' },
          400
        );
      }
      return json(
        {
          user: mapUser(await loadProfile(admin, newUserId)),
          message: role === 'admin' ? 'تمت إضافة المشرف بنجاح' : 'تمت إضافة العضو بنجاح',
        },
        201
      );
    }

    // ================= UPDATE MEMBER / ADMIN =================
    if (action === 'update') {
      const userId = String(body.user_id || '');
      if (!isUuid(userId)) return json({ error: 'معرف العضو مطلوب' }, 400);
      const existing = await loadProfile(admin, userId);
      await requireCanManageAccount(admin, caller, existing);

      const profileUpdate: Record<string, unknown> = {};
      const authUpdate: Record<string, unknown> = {};

      if (body.name !== undefined && String(body.name).trim()) {
        profileUpdate.full_name = String(body.name).trim();
        authUpdate.user_metadata = { full_name: profileUpdate.full_name };
      }
      if (body.phone !== undefined && normalizePhone(body.phone)) {
        const phone = normalizePhone(body.phone);
        if (phoneToAuthEmail(phone) !== phoneToAuthEmail(existing.phone)) {
          const { data: owner, error } = await admin.from('profiles').select('id').eq('phone', phone).neq('id', userId).maybeSingle();
          if (error) throw new HttpError(error.message, 500);
          if (owner) return json({ error: 'رقم الهاتف مستخدم لعضو آخر' }, 409);
          profileUpdate.phone = phone;
          authUpdate.email = phoneToAuthEmail(phone);
          authUpdate.email_confirm = true;
        }
      }
      if (body.password !== undefined && String(body.password).trim() !== '') {
        if (!canChangeAccountPassword(caller, existing)) return json({ error: 'لا يمكنك تغيير كلمة مرور هذا الحساب من هنا' }, 403);
        const password = String(body.password).trim();
        if (password.length < 6) return json({ error: 'يجب ألا تقل كلمة المرور عن 6 خانات' }, 400);
        authUpdate.password = password;
      }
      // Exclusion / reactivation only flips the account flag; the batch membership is kept, so a
      // reactivated member returns to the SAME batch with all history intact.
      if (typeof body.is_active === 'boolean') {
        if (userId === caller.id && body.is_active === false) return json({ error: 'لا يمكنك إيقاف حسابك الحالي' }, 400);
        profileUpdate.active = body.is_active;
      }

      // Men: member <-> admin switch (master admins only; memberships are re-assigned in SQL).
      const roleChange = (body.role === 'member' || body.role === 'admin') && body.role !== existing.role ? body.role : null;
      if (roleChange) {
        requireMaster(caller);
        if (userId === caller.id) return json({ error: 'لا يمكنك تغيير نوع حسابك الحالي' }, 400);
      }

      /*
       * Admin permissions (Sisters): master flag and batch assignments. Only a master admin may
       * change these, so a batch admin can never promote anyone (or himself) to master admin.
       */
      const wantsMasterChange =
        !roleChange && body.is_master_admin !== undefined && Boolean(body.is_master_admin) !== existing.is_master_admin;
      const wantsBatchChange = !roleChange && body.batch_ids !== undefined;
      let nextIsMaster = existing.is_master_admin;
      let adminBatchIds: string[] | null = null;
      if (wantsMasterChange || wantsBatchChange) {
        requireMaster(caller);
        if (existing.role !== 'admin') return json({ error: 'صلاحيات المشرفين متاحة لحسابات المشرفين فقط' }, 400);
      }
      if (wantsMasterChange) {
        nextIsMaster = Boolean(body.is_master_admin);
        if (!nextIsMaster) {
          if (userId === caller.id) return json({ error: 'لا يمكنك إزالة صلاحية المشرف العام من حسابك الحالي' }, 400);
          const { count: otherMasters, error } = await admin
            .from('profiles')
            .select('id', { count: 'exact', head: true })
            .eq('role', 'admin')
            .eq('is_master_admin', true)
            .eq('active', true)
            .neq('id', userId);
          if (error) throw new HttpError(error.message, 500);
          if (!otherMasters) return json({ error: 'يجب أن يبقى مشرف عام نشط واحد على الأقل' }, 400);
          // A batch admin must manage at least one batch.
          if (!wantsBatchChange) return json({ error: 'يرجى اختيار الدفعات التي سيديرها المشرف' }, 400);
        }
        // Promotion to master removes the now-redundant batch assignments (database trigger).
        profileUpdate.is_master_admin = nextIsMaster;
      }
      if (wantsBatchChange) {
        if (nextIsMaster) return json({ error: 'المشرف العام يدير جميع الدفعات ولا يحتاج إلى تعيين دفعات' }, 400);
        adminBatchIds = await validateBatchIds(admin, body.batch_ids);
      }

      if (Object.keys(authUpdate).length) {
        const { error } = await admin.auth.admin.updateUserById(userId, authUpdate);
        if (error) {
          console.error('admin-users update auth failed', { userId, status: error.status, message: error.message });
          const { message, status } = authErrorMessage(error);
          return json({ error: message }, status);
        }
      }
      if (Object.keys(profileUpdate).length) {
        const { error } = await admin.from('profiles').update(profileUpdate).eq('id', userId);
        if (error) {
          console.error('admin-users update profile failed', { userId, code: error.code, message: error.message });
          // Keep the login consistent with the profile: point the Auth email back at the old phone.
          if (authUpdate.email) {
            await admin.auth.admin.updateUserById(userId, { email: phoneToAuthEmail(existing.phone), email_confirm: true });
          }
          return json(
            { error: error.code === '23505' ? 'رقم الهاتف مستخدم لعضو آخر' : 'تعذر تحديث بيانات الحساب. حاول مرة أخرى.' },
            error.code === '23505' ? 409 : 500
          );
        }
      }
      if (adminBatchIds) {
        const { error } = await admin.rpc('set_admin_batches', { p_user_id: userId, p_batch_ids: adminBatchIds, p_actor: caller.id });
        if (error) {
          // Undo a demotion so the account is never left as a batch admin with no batches.
          if (wantsMasterChange && !nextIsMaster) await admin.from('profiles').update({ is_master_admin: true }).eq('id', userId);
          return json({ error: error.message }, 400);
        }
      }
      if (roleChange) {
        const batchId = (await getMemberBatchId(admin, userId)) || body.batch_id;
        if (roleChange === 'member' && !isUuid(batchId)) return json({ error: 'يرجى اختيار دفعة العضو' }, 400);
        if (roleChange === 'member') await requireManagedBatch(admin, caller, batchId);
        const { error } = await admin.rpc('men_set_account_role', {
          p_user_id: userId,
          p_role: roleChange,
          p_batch_id: isUuid(batchId) ? batchId : null,
          p_actor: caller.id,
        });
        if (error) return json({ error: error.message }, 400);
      }
      return json({ user: mapUser(await loadProfile(admin, userId)), message: 'تم تحديث الحساب بنجاح' });
    }

    // ================= DELETE MEMBER / BATCH ADMIN COMPLETELY =================
    if (action === 'delete') {
      const userId = String(body.user_id || '');
      if (!isUuid(userId)) return json({ error: 'معرف العضو مطلوب' }, 400);
      if (userId === caller.id) return json({ error: 'لا يمكنك حذف حسابك الحالي' }, 400);
      const target = await loadProfile(admin, userId);
      await requireCanManageAccount(admin, caller, target);
      // Master admin accounts are never deleted from here (Sisters rule).
      if (target.role === 'admin' && target.is_master_admin) return json({ error: 'لا يمكن حذف حساب مشرف عام' }, 403);

      // 1. All of the account's records in ONE database transaction (also clears rows that block deletion).
      const { data: counts, error: deleteError } = await admin.rpc('men_delete_member_completely', { p_user_id: userId });
      if (deleteError) {
        console.error('admin-users delete failed', { userId, code: deleteError.code, message: deleteError.message });
        return json({ error: 'فشل حذف الحساب وسجلاته. لم يتم حذف الحساب، يرجى المحاولة مرة أخرى.' }, 500);
      }
      // 2. The login itself (the profile no longer references it).
      const { error: authError } = await admin.auth.admin.deleteUser(userId);
      if (authError) console.error('admin-users: records deleted but the Auth user remains', { userId, message: authError.message });

      const c = counts as { recitations: number; revisions: number };
      return json({
        success: true,
        message:
          target.role === 'admin'
            ? `تم حذف حساب المشرف "${target.full_name.trim()}" نهائيًا`
            : `تم حذف العضو "${target.full_name.trim()}" نهائيًا ومسح كافة سجلات التسميع (${c.recitations}) وسجلات المراجعة (${c.revisions}) الخاصة به.`,
      });
    }

    // ================= MOVE MEMBER TO ANOTHER BATCH =================
    // Same Auth user / profile / UUID. Only the CURRENT membership moves; old recitations and
    // revisions stay on the old batch's cycles.
    if (action === 'move-member-batch') {
      const userId = String(body.user_id || '');
      if (!isUuid(userId)) return json({ error: 'معرف العضو مطلوب' }, 400);
      const target = await loadProfile(admin, userId);
      if (target.role !== 'member') return json({ error: 'يمكن نقل حسابات الأعضاء فقط' }, 400);

      // The source batch always comes from the database, never from the client.
      const sourceBatchId = await getMemberBatchId(admin, userId);
      if (!sourceBatchId) {
        console.error('admin-users move: member has no batch membership', { userId });
        return json({ error: 'العضو غير مرتبط بأي دفعة. يرجى التواصل مع الدعم الفني.' }, 409);
      }
      if (!canManageBatch(caller, sourceBatchId)) return json({ error: 'لا تملك صلاحية إدارة دفعة هذا العضو' }, 403);

      const destination = await requireManagedBatch(admin, caller, body.destination_batch_id);
      if (destination.id === sourceBatchId) return json({ error: 'العضو موجود بالفعل في هذه الدفعة' }, 400);

      const { error: moveError } = await admin.rpc('move_member_batch', {
        p_user_id: userId,
        p_destination_batch_id: destination.id,
        p_expected_source_batch_id: sourceBatchId,
        p_actor: caller.id,
      });
      if (moveError) {
        console.error('admin-users move failed', { userId, code: moveError.code, message: moveError.message });
        // Messages raised by move_member_batch are Arabic and safe to show.
        const ours = moveError.code === 'P0002' || moveError.code === '23514';
        return json({ error: ours ? moveError.message : 'تعذر نقل العضو. حاول مرة أخرى.' }, ours ? 400 : 500);
      }
      return json({ success: true, message: `تم نقل العضو «${target.full_name.trim()}» إلى «${destination.name}» بنجاح` });
    }

    // ================= SET BATCH ADMIN ASSIGNMENTS (master admin only) =================
    if (action === 'set-admin-batches') {
      requireMaster(caller);
      const userId = String(body.user_id || '');
      if (!isUuid(userId)) return json({ error: 'معرف المشرف مطلوب' }, 400);
      const target = await loadProfile(admin, userId);
      if (target.role !== 'admin' || target.is_master_admin) return json({ error: 'يمكن تعيين الدفعات لمشرفي الدفعات فقط' }, 400);
      const batchIds = await validateBatchIds(admin, body.batch_ids);
      const { error } = await admin.rpc('set_admin_batches', { p_user_id: userId, p_batch_ids: batchIds, p_actor: caller.id });
      if (error) return json({ error: error.message }, 400);
      return json({ success: true, message: 'تم تحديث دفعات المشرف بنجاح' });
    }

    return json({ error: 'إجراء غير معروف' }, 400);
  } catch (error) {
    return errorResponse(error, 'admin-users');
  }
});
