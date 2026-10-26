import React, { useState } from 'react';
import { Batch } from '../types';
import { Layers, Plus, ChevronDown, Pencil, X } from 'lucide-react';
import { CreateBatchModal } from './CreateBatchModal';

interface BatchSelectorProps {
  batches: Batch[];
  selectedBatchId: string | null;
  onSelect: (batchId: string) => void;
  canCreate: boolean;
  onBatchCreated: (batch: Batch) => Promise<void> | void;
  // Rename the selected batch (admins see only batches they manage; the server re-checks).
  onRename?: (batchId: string, name: string) => Promise<void>;
}

export const BatchSelector: React.FC<BatchSelectorProps> = ({
  batches,
  selectedBatchId,
  onSelect,
  canCreate,
  onBatchCreated,
  onRename,
}) => {
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [renameValue, setRenameValue] = useState<string | null>(null);
  const [renameError, setRenameError] = useState('');
  const [renaming, setRenaming] = useState(false);
  const selected = batches.find((b) => b.id === selectedBatchId) || null;

  const submitRename = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected || !onRename || renameValue === null || renaming) return;
    const clean = renameValue.replace(/\s+/g, ' ').trim();
    if (!clean) {
      setRenameError('اسم الدفعة مطلوب');
      return;
    }
    if (clean.length > 60) {
      setRenameError('اسم الدفعة طويل جدًا (60 حرفًا كحد أقصى)');
      return;
    }
    if (clean === selected.name) {
      setRenameValue(null);
      return;
    }
    setRenaming(true);
    setRenameError('');
    try {
      await onRename(selected.id, clean);
      setRenameValue(null);
    } catch (err: any) {
      setRenameError(err?.message || 'تعذر تعديل اسم الدفعة');
    } finally {
      setRenaming(false);
    }
  };

  return (
    <div className="mb-5 bg-white rounded-2xl border border-emerald-100 shadow-2xs p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 flex-1 min-w-0">
        <label
          htmlFor="batch-selector"
          className="text-xs font-bold text-emerald-900 flex items-center gap-1.5 shrink-0"
        >
          <Layers className="w-4 h-4 text-emerald-600" />
          الدفعة الحالية
        </label>

        {batches.length > 0 ? (
          <div className="relative w-full sm:w-72">
            <select
              id="batch-selector"
              value={selectedBatchId || ''}
              onChange={(e) => onSelect(e.target.value)}
              className="w-full appearance-none pl-8 pr-3.5 py-2.5 rounded-xl border border-emerald-200 bg-emerald-50/40 hover:bg-emerald-50 focus:bg-white focus:border-emerald-600 transition outline-hidden text-xs font-bold text-stone-900 cursor-pointer"
            >
              {batches.map((batch) => (
                <option key={batch.id} value={batch.id}>
                  {batch.name}
                </option>
              ))}
            </select>
            <ChevronDown className="w-4 h-4 text-emerald-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          </div>
        ) : (
          <span className="text-xs text-stone-500">لا توجد دفعات بعد</span>
        )}

        {selected && onRename && (
          <button
            id="open-rename-batch-btn"
            type="button"
            onClick={() => {
              setRenameValue(selected.name);
              setRenameError('');
            }}
            className="px-3 py-2 rounded-xl border border-emerald-200 bg-white hover:bg-emerald-50 text-emerald-800 font-bold text-xs flex items-center justify-center gap-1.5 shrink-0 cursor-pointer"
          >
            <Pencil className="w-3.5 h-3.5" />
            <span>تعديل اسم الدفعة</span>
          </button>
        )}
      </div>

      {canCreate && (
        <button
          id="open-create-batch-btn"
          onClick={() => setIsCreateOpen(true)}
          className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-700 hover:to-emerald-600 text-white font-bold text-xs shadow-xs transition flex items-center justify-center gap-1.5 shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>إنشاء دفعة جديدة</span>
        </button>
      )}

      {renameValue !== null && selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-stone-900/60 backdrop-blur-xs">
          <form onSubmit={submitRename} className="bg-white rounded-2xl max-w-sm w-full shadow-2xl border border-stone-200 p-5 space-y-3 text-stone-900">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-sm flex items-center gap-1.5">
                <Pencil className="w-4 h-4 text-emerald-700" />
                تعديل اسم الدفعة
              </h3>
              <button type="button" onClick={() => setRenameValue(null)} className="p-1 text-stone-400 hover:text-stone-700 rounded-lg">
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-[11px] text-stone-500">الاسم الحالي: «{selected.name}». يتغير الاسم فقط؛ تبقى الأعضاء والدورة والسجلات كما هي.</p>
            {renameError && <div className="p-2.5 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700">{renameError}</div>}
            <input
              id="rename-batch-input"
              type="text"
              value={renameValue}
              maxLength={60}
              onChange={(e) => setRenameValue(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl border border-stone-200 bg-stone-50 focus:bg-white focus:border-emerald-600 transition outline-hidden text-xs"
              autoFocus
              required
            />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setRenameValue(null)} className="px-4 py-2 text-xs font-semibold text-stone-600 hover:bg-stone-100 rounded-xl">
                إلغاء
              </button>
              <button
                id="confirm-rename-batch-btn"
                type="submit"
                disabled={renaming}
                className="px-5 py-2 text-xs font-bold rounded-xl text-white bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 cursor-pointer"
              >
                {renaming ? 'جاري الحفظ...' : 'حفظ الاسم'}
              </button>
            </div>
          </form>
        </div>
      )}

      <CreateBatchModal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        onCreated={onBatchCreated}
      />
    </div>
  );
};
