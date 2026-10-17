import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { CycleInfo, User } from '../types';
import { BookOpen, LogOut, Shield, User as UserIcon, ChevronDown, Key, GraduationCap } from 'lucide-react';
import { ChangePasswordModal } from './Modals';
import { api } from '../api/client';

interface HeaderProps {
  cycleInfo?: CycleInfo | null;
  allUsers?: User[];
  onRefresh: () => void;
  onOpenPersonalTest?: () => void;
}

export const Header: React.FC<HeaderProps> = ({ onOpenPersonalTest }) => {
  const { currentUser, logout } = useAuth();
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [isChangePasswordOpen, setIsChangePasswordOpen] = useState(false);

  if (!currentUser) return null;

  const handleChangePassword = async (payload: {
    currentPassword: string;
    newPassword: string;
    confirmPassword: string;
  }) => {
    await api.changePassword(payload);
  };

  return (
    <header className="sticky top-0 z-40 bg-white border-b border-stone-200 shadow-xs">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
        {/* Brand & App Title */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-700 flex items-center justify-center text-amber-300 shadow-sm">
            <BookOpen className="w-6 h-6" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-stone-900 tracking-tight leading-none font-quran">
                مُتْقِن
              </h1>
              <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-800 font-medium border border-emerald-200">
                مقرأة القرآن الكريم
              </span>
            </div>
            <p className="text-xs text-stone-500 hidden sm:block">
              منظومة الحفظ والمراجعة اليومية الجماعية
            </p>
          </div>
        </div>

        {/* User Info & Profile Menu */}
        <div className="flex items-center gap-2">
          {/* اختبر نفسك in Header */}
          {onOpenPersonalTest && (
            <button
              onClick={onOpenPersonalTest}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-50 hover:bg-emerald-100/90 text-emerald-800 border border-emerald-200 text-xs font-bold transition cursor-pointer shadow-2xs"
              title="اختبر نفسك (اختبار فردي)"
            >
              <GraduationCap className="w-4 h-4 text-emerald-700" />
              <span className="hidden sm:inline">اختبر نفسك</span>
            </button>
          )}

          <div className="relative">
            <button
              id="user-account-menu-button"
              onClick={() => setShowUserMenu(!showUserMenu)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-stone-50 hover:bg-stone-100 border border-stone-200 transition text-right cursor-pointer"
              title="بيانات الحساب"
            >
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold ${
                currentUser.role === 'admin' ? 'bg-amber-600' : 'bg-emerald-700'
              }`}>
                {currentUser.role === 'admin' ? <Shield className="w-4 h-4" /> : <UserIcon className="w-4 h-4" />}
              </div>
              <div className="hidden sm:block text-xs">
                <div className="font-bold text-stone-900 leading-tight flex items-center gap-1">
                  {currentUser.name}
                  <ChevronDown className="w-3 h-3 text-stone-400" />
                </div>
                <div className="text-stone-500">
                  {currentUser.role === 'admin' ? 'مشرف المقرأة' : 'عضو حافظ'}
                </div>
              </div>
            </button>

            {/* Profile Dropdown */}
            {showUserMenu && (
              <div className="absolute left-0 mt-2 w-64 bg-white rounded-xl shadow-xl border border-stone-200 py-2 z-50 animate-in fade-in slide-in-from-top-2 duration-150">
                <div className="px-3 py-2.5 border-b border-stone-100 text-xs">
                  <p className="font-bold text-stone-900">{currentUser.name}</p>
                  <p className="text-stone-500 text-[11px] mt-0.5 font-mono">{currentUser.phone}</p>
                  <div className="mt-1.5">
                    <span className={`inline-block text-[10px] px-2 py-0.5 rounded-full font-bold ${
                      currentUser.role === 'admin' ? 'bg-amber-100 text-amber-900' : 'bg-emerald-100 text-emerald-800'
                    }`}>
                      {currentUser.role === 'admin' ? 'حساب المشرف' : 'عضو بالمقرأة'}
                    </span>
                  </div>
                </div>
                <div className="pt-1 space-y-0.5">
                  {onOpenPersonalTest && (
                    <button
                      onClick={() => {
                        setShowUserMenu(false);
                        onOpenPersonalTest();
                      }}
                      className="w-full text-right px-3 py-2 text-xs text-stone-700 hover:bg-emerald-50 hover:text-emerald-800 flex items-center gap-2 font-medium cursor-pointer transition"
                    >
                      <GraduationCap className="w-3.5 h-3.5 text-emerald-700" />
                      اختبر نفسك
                    </button>
                  )}
                  <button
                    onClick={() => {
                      setShowUserMenu(false);
                      setIsChangePasswordOpen(true);
                    }}
                    className="w-full text-right px-3 py-2 text-xs text-stone-700 hover:bg-stone-50 flex items-center gap-2 font-medium cursor-pointer transition"
                  >
                    <Key className="w-3.5 h-3.5 text-stone-400" />
                    تغيير كلمة المرور
                  </button>
                  <button
                    onClick={() => {
                      logout();
                      setShowUserMenu(false);
                    }}
                    className="w-full text-right px-3 py-2 text-xs text-rose-600 hover:bg-rose-50 flex items-center gap-2 font-medium cursor-pointer transition"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    تسجيل الخروج
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Logout standalone button */}
          <button
            id="logout-header-btn"
            onClick={logout}
            className="p-2 text-stone-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition cursor-pointer"
            title="تسجيل الخروج"
          >
            <LogOut className="w-5 h-5" />
          </button>
        </div>
      </div>

      <ChangePasswordModal
        isOpen={isChangePasswordOpen}
        onClose={() => setIsChangePasswordOpen(false)}
        onSubmit={handleChangePassword}
      />
    </header>
  );
};
