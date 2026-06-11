import express from 'express';
import path from 'path';
import { exec } from 'child_process';
import { BotDatabase } from './database';

function getPm2Info(appName: string): Promise<Record<string, unknown> | null> {
  return new Promise(resolve => {
    exec('pm2 jlist', (err, stdout) => {
      if (err || !stdout.trim()) { resolve(null); return; }
      try {
        const list = JSON.parse(stdout) as Array<Record<string, unknown>>;
        const proc = list.find((p: Record<string, unknown>) => p['name'] === appName) ?? null;
        if (!proc) { resolve(null); return; }
        const env = proc['pm2_env'] as Record<string, unknown>;
        const monit = proc['monit'] as Record<string, unknown>;
        resolve({
          name: proc['name'],
          pid: proc['pid'],
          status: env?.['status'],
          restartCount: env?.['restart_time'],
          unstableRestarts: env?.['unstable_restarts'],
          createdAt: env?.['created_at'],
          pmUptime: env?.['pm_uptime'],
          memory: monit?.['memory'],
          cpu: monit?.['cpu'],
          maxMemoryRestart: env?.['max_memory_restart'],
        });
      } catch {
        resolve(null);
      }
    });
  });
}

export function startAdminServer(botDb: BotDatabase, port = 3000): void {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(process.cwd(), 'public')));

  // ─── Users ────────────────────────────────────────────────────────────────
  app.get('/api/users', (_req, res) => {
    res.json(botDb.listUsers());
  });

  app.post('/api/users/:userId/authorize', (req, res) => {
    const userId = parseInt(req.params.userId);
    if (isNaN(userId)) { res.status(400).json({ error: 'invalid userId' }); return; }
    botDb.authorizeUser(userId);
    res.json({ ok: true });
  });

  app.post('/api/users/:userId/revoke', (req, res) => {
    const userId = parseInt(req.params.userId);
    if (isNaN(userId)) { res.status(400).json({ error: 'invalid userId' }); return; }
    const ok = botDb.revokeUser(userId);
    res.json({ ok });
  });

  // ─── Submissions ──────────────────────────────────────────────────────────
  app.get('/api/submissions', (_req, res) => {
    res.json(botDb.listSubmissions());
  });

  // ─── Settings ─────────────────────────────────────────────────────────────
  app.get('/api/settings', (_req, res) => {
    res.json({ whitelistEnabled: botDb.isWhitelistEnabled() });
  });

  app.post('/api/settings', (req, res) => {
    const { whitelistEnabled } = req.body as { whitelistEnabled?: unknown };
    if (typeof whitelistEnabled !== 'boolean') {
      res.status(400).json({ error: 'whitelistEnabled must be boolean' });
      return;
    }
    botDb.setWhitelistEnabled(whitelistEnabled);
    res.json({ ok: true });
  });

  // ─── Status ───────────────────────────────────────────────────────────────
  app.get('/api/status', async (_req, res) => {
    const mem = process.memoryUsage();
    const [pm2] = await Promise.all([getPm2Info('dinbendon-bot')]);
    res.json({
      uptime: process.uptime(),
      nodeVersion: process.version,
      memory: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
      },
      sqlite: botDb.getStatusInfo(),
      pm2,
    });
  });

  app.listen(port, '127.0.0.1', () => {
    console.log(`🖥️  Admin UI: http://localhost:${port}`);
  });
}
