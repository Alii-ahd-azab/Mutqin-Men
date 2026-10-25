import 'dotenv/config';
import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { createApp } from './src/server/app';
import { createPgDatabase } from './src/server/store';
import { createSupabaseAuthService } from './src/server/auth';
import { loadServerConfig } from './src/server/config';

const PORT = 3000;

async function startServer() {
  const config = loadServerConfig();
  const db = createPgDatabase(config.databaseUrl, {
    ssl: config.databaseCa ? { ca: config.databaseCa, rejectUnauthorized: true } : { rejectUnauthorized: true },
  });
  const auth = createSupabaseAuthService({
    url: config.supabaseUrl,
    secretKey: config.secretKey,
    publishableKey: config.publishableKey,
  });

  try {
    await db.query('select 1');
    console.log(`[Supabase] Connected to Mutqin for Men project ${config.projectRef}`);
  } catch (err: unknown) {
    console.warn('[Supabase Status Warning]', err instanceof Error ? err.message : String(err));
  }

  const app = createApp({
    db,
    auth,
    publicConfig: { supabaseUrl: config.supabaseUrl, supabasePublishableKey: config.publishableKey },
  });

  // ==================== VITE / STATIC SERVING ====================
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Motqin server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start Motqin server:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
