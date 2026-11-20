import { BotDatabase } from './database'

/** 誰能使用 bot：白名單開關、管理員 bypass、使用者授權狀態。 */
export class Access {
  constructor(
    private deps: { db: BotDatabase; adminUserId: number | null },
  ) {}

  isAdmin(userId: number): boolean {
    return this.deps.adminUserId !== null && userId === this.deps.adminUserId
  }

  isAllowed(userId: number): boolean {
    const { db } = this.deps
    return !db.isWhitelistEnabled() || this.isAdmin(userId) || db.isAuthorized(userId)
  }
}
