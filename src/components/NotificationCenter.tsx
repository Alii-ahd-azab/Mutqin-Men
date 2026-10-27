import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, AlertTriangle, Bell, BookMarked, CalendarCheck, ShieldAlert, UserCog, UserMinus, X } from 'lucide-react';
import { arabicLateDays, type BatchAdminAlert, type MemberNotification, type NotificationTone } from '../lib/notifications';

/*
 * Header bell for members and batch admins (never master admins). The notifications are derived
 * from the current program status by the caller; this component only shows them. "Read" is a
 * per-device presentation hint kept in localStorage: reading a warning never clears it — it stays
 * while its condition lasts, and comes back as unread when what it says changes.
 */

const readKey = (userId: string) => `mutqin.notifications.read.${userId}`;

function loadRead(userId: string): Record<string, string> {
  try {
    return JSON.parse(window.localStorage.getItem(readKey(userId)) || '{}') || {};
  } catch {
    return {};
  }
}

function saveRead(userId: string, read: Record<string, string>) {
  try {
    window.localStorage.setItem(readKey(userId), JSON.stringify(read));
  } catch {
    // storage unavailable: everything just shows as unread
  }
}

const TONES: Record<NotificationTone, { box: string; title: string; icon: React.ReactNode; dot: string }> = {
  light: {
    box: 'bg-amber-50 border-amber-200',
    title: 'text-amber-950',
    icon: <AlertCircle className="w-4 h-4 text-amber-600" />,
    dot: 'bg-amber-400',
  },
  strong: {
    box: 'bg-orange-50 border-orange-300',
    title: 'text-orange-950',
    icon: <AlertTriangle className="w-4 h-4 text-orange-600" />,
    dot: 'bg-orange-500',
  },
  serious: {
    box: 'bg-rose-50 border-rose-300',
    title: 'text-rose-900',
    icon: <ShieldAlert className="w-4 h-4 text-rose-600" />,
    dot: 'bg-rose-600',
  },
  info: {
    box: 'bg-teal-50 border-teal-200',
    title: 'text-teal-950',
    icon: <CalendarCheck className="w-4 h-4 text-teal-700" />,
    dot: 'bg-teal-500',
  },
  distant: {
    box: 'bg-emerald-50 border-emerald-200',
    title: 'text-emerald-950',
    icon: <BookMarked className="w-4 h-4 text-emerald-700" />,
    dot: 'bg-emerald-600',
  },
};

const CATEGORY_LABEL: Record<BatchAdminAlert['category'], string> = { tasmia: 'التسميع', revision: 'المراجعة' };

type Props = { userId: string } & (
  | { mode: 'member'; items: MemberNotification[]; onOpen: (n: MemberNotification) => void }
  | {
      mode: 'admin';
      items: BatchAdminAlert[];
      showBatchName: boolean;
      onOpen: (a: BatchAdminAlert, action: 'manage' | 'exclude') => void;
    }
);

export const NotificationCenter: React.FC<Props> = (props) => {
  const { userId, mode } = props;
  const items: { id: string; signature: string }[] = props.items;
  const [open, setOpen] = useState(false);
  const [read, setRead] = useState<Record<string, string>>(() => loadRead(userId));
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => setRead(loadRead(userId)), [userId]);

  const isUnread = useCallback((id: string, signature: string) => read[id] !== signature, [read]);
  const unreadCount = useMemo(() => items.filter((n) => isUnread(n.id, n.signature)).length, [items, isUnread]);

  const markRead = (id: string, signature: string) => {
    // Forget conditions that are gone, so a warning that returns later is new again.
    const active = new Set(items.map((n) => n.id));
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(read)) if (active.has(k)) next[k] = String(v);
    next[id] = signature;
    setRead(next);
    saveRead(userId, next);
  };

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [open, close]);

  const hasSerious = props.mode === 'admin' ? items.length > 0 : props.items.some((n) => n.tone === 'serious');

  return (
    <div className="relative" ref={wrapRef}>
      <button
        id="notifications-button"
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={items.length > 0 ? `التنبيهات (${items.length})` : 'التنبيهات'}
        title="التنبيهات"
        className={`relative flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-bold transition cursor-pointer shadow-2xs ${
          open ? 'bg-emerald-100 border-emerald-300 text-emerald-900' : 'bg-emerald-50 hover:bg-emerald-100/90 border-emerald-200 text-emerald-800'
        }`}
      >
        <Bell className="w-4 h-4 text-emerald-700" />
        <span className="hidden sm:inline">التنبيهات</span>
        {items.length > 0 && (
          <span
            id="notifications-badge"
            data-unread={unreadCount}
            className={`absolute -top-1.5 -left-1.5 min-w-5 h-5 px-1 rounded-full text-[10px] font-bold flex items-center justify-center border-2 border-white ${
              unreadCount > 0 ? (hasSerious ? 'bg-rose-600 text-white' : 'bg-amber-500 text-white') : 'bg-stone-300 text-stone-700'
            }`}
          >
            {items.length > 99 ? '99+' : items.length}
          </span>
        )}
      </button>

      {open && (
        <div
          id="notifications-panel"
          role="region"
          aria-label="التنبيهات"
          className="fixed inset-x-3 top-[4.5rem] sm:absolute sm:inset-x-auto sm:top-auto sm:left-0 sm:mt-2 sm:w-[24rem] bg-white border border-stone-200 rounded-2xl shadow-xl z-50 overflow-hidden"
        >
          <div className="px-4 py-3 border-b border-stone-100 flex items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-bold text-stone-900">التنبيهات</h2>
              <p className="text-[11px] text-stone-500">
                {mode === 'admin' ? 'الأعضاء الذين بلغ تأخرهم 3 أيام فأكثر في دفعاتك' : 'حالتك الحالية في البرنامج'}
              </p>
            </div>
            <button type="button" onClick={close} title="إغلاق" className="p-1.5 rounded-lg text-stone-400 hover:text-stone-700 hover:bg-stone-50 cursor-pointer">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="max-h-[65vh] overflow-y-auto overscroll-contain p-2 space-y-2">
            {items.length === 0 && (
              <p id="notifications-empty" className="px-3 py-6 text-xs text-stone-500 text-center leading-relaxed">
                {mode === 'admin' ? 'لا يوجد عضو بلغ تأخره 3 أيام في التسميع أو المراجعة.' : 'لا توجد تنبيهات حاليًا. بارك الله فيك.'}
              </p>
            )}

            {props.mode === 'member' &&
              props.items.map((n) => {
                const t = TONES[n.tone];
                const unread = isUnread(n.id, n.signature);
                return (
                  <button
                    key={n.id}
                    id={`notification-${n.kind}`}
                    data-tone={n.tone}
                    data-unread={unread}
                    type="button"
                    onClick={() => {
                      markRead(n.id, n.signature);
                      close();
                      props.onOpen(n);
                    }}
                    className={`w-full text-right rounded-xl border p-3 flex items-start gap-2.5 transition cursor-pointer hover:brightness-[0.98] ${t.box}`}
                  >
                    <span className="mt-0.5 shrink-0">{t.icon}</span>
                    <span className="min-w-0 flex-1 space-y-0.5">
                      <span className={`block text-xs leading-relaxed ${unread ? 'font-bold' : 'font-semibold'} ${t.title}`}>{n.title}</span>
                      <span className="block text-[11px] text-stone-700 leading-relaxed">{n.body}</span>
                      {n.note && (
                        <span className="block text-[11px] text-stone-600 leading-relaxed">
                          <strong>ملاحظة المشرف:</strong> {n.note}
                        </span>
                      )}
                    </span>
                    {unread && <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${t.dot}`} aria-label="جديد" />}
                  </button>
                );
              })}

            {props.mode === 'admin' &&
              props.items.map((a) => {
                const unread = isUnread(a.id, a.signature);
                const open = (action: 'manage' | 'exclude') => {
                  markRead(a.id, a.signature);
                  close();
                  props.onOpen(a, action);
                };
                return (
                  <div
                    key={a.id}
                    id={`admin-alert-${a.memberId}-${a.category}`}
                    data-tone="serious"
                    data-unread={unread}
                    className="rounded-xl border border-rose-300 bg-rose-50 p-3 space-y-2"
                  >
                    <button type="button" onClick={() => open('manage')} className="w-full text-right flex items-start gap-2.5 cursor-pointer">
                      <ShieldAlert className="w-4 h-4 text-rose-600 mt-0.5 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className={`block text-xs text-rose-950 ${unread ? 'font-bold' : 'font-semibold'}`}>{a.memberName}</span>
                        <span className="block text-[11px] text-stone-600 font-mono" dir="ltr" style={{ textAlign: 'right' }}>
                          {a.phone}
                        </span>
                        <span className="block text-[11px] text-rose-800 font-bold mt-0.5">
                          {arabicLateDays(a.count)} في {CATEGORY_LABEL[a.category]}
                          {props.showBatchName && <span className="font-normal text-stone-500"> • {a.batchName}</span>}
                        </span>
                      </span>
                      {unread && <span className="mt-1.5 w-2 h-2 rounded-full shrink-0 bg-rose-600" aria-label="جديد" />}
                    </button>
                    <div className="flex items-center gap-2 justify-end">
                      {a.eligibleForExclusion && (
                        <button
                          type="button"
                          onClick={() => open('exclude')}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-bold bg-white border border-rose-300 text-rose-700 hover:bg-rose-100 cursor-pointer"
                          title="يفتح نافذة تأكيد الإقصاء المعتادة"
                        >
                          <UserMinus className="w-3.5 h-3.5" />
                          إقصاء مبدئي
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => open('manage')}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-bold bg-rose-600 text-white hover:bg-rose-700 cursor-pointer"
                      >
                        <UserCog className="w-3.5 h-3.5" />
                        إدارة العضو
                      </button>
                    </div>
                  </div>
                );
              })}
          </div>
        </div>
      )}
    </div>
  );
};
