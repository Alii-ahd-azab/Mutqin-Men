import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

const MEN_PROJECT_REF = 'uaublandjewfzmhnbflc';
const SISTERS_PROJECT_REF = 'cuexuketulmyskmdvosp';

export default defineConfig(({mode}) => {
  // Only the project URL and the publishable key reach the browser (from .env.local or VITE_* names).
  // Nothing else is exposed: the secret key is never read here.
  const env = loadEnv(mode, process.cwd(), '');
  const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL || '';
  const publishableKey = env.VITE_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_PUBLISHABLE_KEY || '';
  if (supabaseUrl.includes(SISTERS_PROJECT_REF)) {
    throw new Error('Mutqin for Men must never use the Mutqin for Sisters Supabase project.');
  }
  if (supabaseUrl && new URL(supabaseUrl).hostname !== `${MEN_PROJECT_REF}.supabase.co`) {
    throw new Error('SUPABASE_URL must point at the Mutqin for Men project.');
  }
  if (publishableKey.startsWith('sb_secret_')) {
    throw new Error('SUPABASE_PUBLISHABLE_KEY must be the publishable key (it is sent to browsers).');
  }

  return {
    plugins: [react(), tailwindcss()],
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(supabaseUrl),
      'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify(publishableKey),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify — file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
