import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

export interface UserRecord {
  userId: number;
  username: string | null;
  firstName: string | null;
  authorized: boolean;
  createdAt: string;
}

export interface SubmissionRecord {
  id: number;
  userId: number;
  username: string | null;
  firstName: string | null;
  orderHashId: string;
  orderItemId: number;
  organizer: string | null;
  productName: string | null;
  buyerName: string | null;
  submittedAt: string;
  cancelledAt: string | null;
}

export class BotDatabase {
  private db: Database.Database;
  private readonly defaultWhitelistEnabled: boolean;
  private readonly dbPath: string;

  constructor(dbPath = path.join(process.cwd(), 'data', 'bot.db'), defaultWhitelistEnabled = true) {
    this.dbPath = dbPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.defaultWhitelistEnabled = defaultWhitelistEnabled;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        user_id    INTEGER PRIMARY KEY,
        username   TEXT,
        first_name TEXT,
        authorized INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE IF NOT EXISTS submissions (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id       INTEGER NOT NULL,
        order_hash_id TEXT NOT NULL,
        order_item_id INTEGER NOT NULL UNIQUE,
        product_name  TEXT,
        buyer_name    TEXT,
        submitted_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE INDEX IF NOT EXISTS idx_sub_user_order
        ON submissions(user_id, order_hash_id);

      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // Migrate: add columns if upgrading from older schema
    try { this.db.exec(`ALTER TABLE submissions ADD COLUMN product_name TEXT`); } catch {}
    try { this.db.exec(`ALTER TABLE submissions ADD COLUMN buyer_name TEXT`); } catch {}
    try { this.db.exec(`ALTER TABLE submissions ADD COLUMN cancelled_at TEXT`); } catch {}
    try { this.db.exec(`ALTER TABLE submissions ADD COLUMN organizer TEXT`); } catch {}
  }

  // ─── Users ──────────────────────────────────────────────────────────────────

  upsertUser(userId: number, username?: string | null, firstName?: string | null): void {
    this.db.prepare(`
      INSERT INTO users(user_id, username, first_name)
      VALUES(?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        username   = excluded.username,
        first_name = excluded.first_name
    `).run(userId, username ?? null, firstName ?? null);
  }

  isAuthorized(userId: number): boolean {
    const row = this.db.prepare(
      'SELECT authorized FROM users WHERE user_id = ?'
    ).get(userId) as { authorized: number } | undefined;
    return row?.authorized === 1;
  }

  authorizeUser(userId: number): void {
    this.db.prepare(`
      INSERT INTO users(user_id, authorized) VALUES(?, 1)
      ON CONFLICT(user_id) DO UPDATE SET authorized = 1
    `).run(userId);
  }

  revokeUser(userId: number): boolean {
    const info = this.db.prepare(
      'UPDATE users SET authorized = 0 WHERE user_id = ?'
    ).run(userId);
    return info.changes > 0;
  }

  listUsers(): UserRecord[] {
    return (this.db.prepare(
      'SELECT * FROM users ORDER BY created_at DESC'
    ).all() as Array<{
      user_id: number;
      username: string | null;
      first_name: string | null;
      authorized: number;
      created_at: string;
    }>).map(r => ({
      userId: r.user_id,
      username: r.username,
      firstName: r.first_name,
      authorized: r.authorized === 1,
      createdAt: r.created_at,
    }));
  }

  // ─── Submissions ─────────────────────────────────────────────────────────────

  recordSubmission(
    userId: number,
    orderHashId: string,
    orderItemIds: number[],
    productName?: string,
    buyerName?: string,
    organizer?: string,
  ): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO submissions(user_id, order_hash_id, order_item_id, product_name, buyer_name, organizer, submitted_at)
      VALUES(?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
    `);
    const tx = this.db.transaction((ids: number[]) => {
      for (const id of ids) stmt.run(userId, orderHashId, id, productName ?? null, buyerName ?? null, organizer ?? null);
    });
    tx(orderItemIds);
  }

  getMyItemIds(userId: number, orderHashId: string): Set<number> {
    const rows = this.db.prepare(
      'SELECT order_item_id FROM submissions WHERE user_id = ? AND order_hash_id = ?'
    ).all(userId, orderHashId) as Array<{ order_item_id: number }>;
    return new Set(rows.map(r => r.order_item_id));
  }

  recordCancellation(orderItemIds: number[]): void {
    const stmt = this.db.prepare(`
      UPDATE submissions SET cancelled_at = datetime('now', 'localtime')
      WHERE order_item_id = ? AND cancelled_at IS NULL
    `);
    const tx = this.db.transaction((ids: number[]) => {
      for (const id of ids) stmt.run(id);
    });
    tx(orderItemIds);
  }

  listSubmissions(limit = 200): SubmissionRecord[] {
    return (this.db.prepare(`
      SELECT s.id, s.user_id, u.username, u.first_name,
             s.order_hash_id, s.order_item_id, s.organizer, s.product_name, s.buyer_name,
             s.submitted_at, s.cancelled_at
      FROM submissions s
      LEFT JOIN users u ON s.user_id = u.user_id
      ORDER BY s.submitted_at DESC
      LIMIT ?
    `).all(limit) as Array<{
      id: number;
      user_id: number;
      username: string | null;
      first_name: string | null;
      order_hash_id: string;
      order_item_id: number;
      organizer: string | null;
      product_name: string | null;
      buyer_name: string | null;
      submitted_at: string;
      cancelled_at: string | null;
    }>).map(r => ({
      id: r.id,
      userId: r.user_id,
      username: r.username,
      firstName: r.first_name,
      orderHashId: r.order_hash_id,
      orderItemId: r.order_item_id,
      organizer: r.organizer,
      productName: r.product_name,
      buyerName: r.buyer_name,
      submittedAt: r.submitted_at,
      cancelledAt: r.cancelled_at,
    }));
  }

  // ─── Settings ────────────────────────────────────────────────────────────────

  isWhitelistEnabled(): boolean {
    const row = this.db.prepare(
      "SELECT value FROM settings WHERE key = 'whitelist_enabled'"
    ).get() as { value: string } | undefined;
    if (!row) return this.defaultWhitelistEnabled;
    return row.value === '1';
  }

  setWhitelistEnabled(enabled: boolean): void {
    this.db.prepare(`
      INSERT INTO settings(key, value) VALUES('whitelist_enabled', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(enabled ? '1' : '0');
  }

  // ─── Status ──────────────────────────────────────────────────────────────────

  getStatusInfo(): { fileSizeBytes: number; userCount: number; submissionCount: number } {
    const userCount = (this.db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c;
    const submissionCount = (this.db.prepare('SELECT COUNT(*) as c FROM submissions').get() as { c: number }).c;
    let fileSizeBytes = 0;
    try { fileSizeBytes = fs.statSync(this.dbPath).size; } catch {}
    return { fileSizeBytes, userCount, submissionCount };
  }
}
