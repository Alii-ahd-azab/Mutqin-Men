import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { BookOpen, Lock, Phone, ArrowLeft } from 'lucide-react';

export const LoginView: React.FC = () => {
  const { login } = useAuth();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phone.trim() || !password.trim()) {
      setErrorMsg('يرجى إدخال رقم الهاتف وكلمة المرور');
      return;
    }
    setErrorMsg('');
    setLoading(true);
    try {
      await login(phone.trim(), password.trim());
    } catch (err: any) {
      setErrorMsg(err?.message || 'فشل تسجيل الدخول. تحقق من بياناتك.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-stone-100 flex flex-col justify-center items-center p-4 selection:bg-emerald-200">
      <div className="w-full max-w-md space-y-6">
        {/* App Logo & Quranic Verse */}
        <div className="text-center space-y-3">
          <div className="inline-flex w-16 h-16 rounded-2xl bg-emerald-800 items-center justify-center text-amber-300 shadow-md border border-emerald-700">
            <BookOpen className="w-9 h-9" />
          </div>
          <h1 className="text-3xl font-bold font-quran text-stone-900 tracking-tight">
            تطبيق مُتْقِن
          </h1>
          <p className="font-quran text-emerald-800 text-sm">
            ﴿ إِنَّ هَـٰذَا الْقُرْآنَ يَهْدِي لِلَّتِي هِيَ أَقْوَمُ ﴾
          </p>
          <p className="text-xs text-stone-500 max-w-xs mx-auto">
            منظومة الحفظ والمراجعة اليومية الجماعية عبر التسميع المتبادل
          </p>
        </div>

        {/* Login Card */}
        <div className="bg-white rounded-3xl border border-stone-200/80 shadow-md p-6 sm:p-8 space-y-5">
          <div className="border-b border-stone-100 pb-3">
            <h2 className="text-base font-bold text-stone-900">تسجيل الدخول للمقرأة</h2>
            <p className="text-xs text-stone-500">
              أدخل رقم الهاتف وكلمة المرور المسجلة من قِبل المشرف
            </p>
          </div>

          {errorMsg && (
            <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700">
              {errorMsg}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4 text-xs">
            <div>
              <label className="block font-bold text-stone-700 mb-1.5">
                رقم الهاتف (معرف الدخول)
              </label>
              <div className="relative">
                <input
                  id="login-phone-input"
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="01000000001"
                  className="w-full px-3.5 py-2.5 rounded-xl border border-stone-200 bg-stone-50 focus:bg-white focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100 transition outline-hidden pl-8"
                  required
                />
                <Phone className="w-4 h-4 text-stone-400 absolute left-2.5 top-3" />
              </div>
            </div>

            <div>
              <label className="block font-bold text-stone-700 mb-1.5">
                كلمة المرور
              </label>
              <div className="relative">
                <input
                  id="login-password-input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full px-3.5 py-2.5 rounded-xl border border-stone-200 bg-stone-50 focus:bg-white focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100 transition outline-hidden pl-8"
                  required
                />
                <Lock className="w-4 h-4 text-stone-400 absolute left-2.5 top-3" />
              </div>
            </div>

            <button
              id="login-submit-btn"
              type="submit"
              disabled={loading}
              className="w-full py-3 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-xs shadow-xs transition flex items-center justify-center gap-2 disabled:opacity-50 cursor-pointer"
            >
              <span>{loading ? 'جاري التحقق...' : 'دخول المقرأة'}</span>
              <ArrowLeft className="w-4 h-4" />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};
