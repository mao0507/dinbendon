import express from 'express';
import path from 'path';
import { BotDatabase } from './database';

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

  app.listen(port, '127.0.0.1', () => {
    console.log(`🖥️  Admin UI: http://localhost:${port}`);
  });
}
