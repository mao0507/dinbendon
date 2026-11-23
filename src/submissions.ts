import { DinBenDonClient, MyOrderItem, OrderDetail } from './dinbendon'
import { BotDatabase } from './database'

export interface PlaceItem {
  menuItemId: string
  productId: string
  /** 顯示名稱，記入 DB */
  name: string
  quantity: number
  note?: string
}

export type PlaceResult =
  | { ok: true; recorded: number[] }
  | { ok: false; reason: string }

export interface MyItems {
  all: MyOrderItem[]
  mine: MyOrderItem[]
}

export type CancelResult = ({ ok: true } & MyItems) | { ok: false; reason: string }

const errMsg = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

/** 送出、查詢、取消品項，並維護「哪些 orderItemId 是誰的」。 */
export class Submissions {
  constructor(private deps: { client: DinBenDonClient; db: BotDatabase }) {}

  /** 不丟例外：所有失敗都轉成 `{ ok: false, reason }`。 */
  async place(
    userId: number,
    detail: OrderDetail,
    item: PlaceItem,
    buyerName: string,
  ): Promise<PlaceResult> {
    const { client, db } = this.deps
    const orderId = detail.order.id

    // 送出前先快照；拿不到就不送，避免之後把別人的品項記到這位使用者名下
    let before: MyOrderItem[]
    try {
      before = await client.fetchMyItems(orderId)
    } catch {
      return { ok: false, reason: '無法確認目前訂單，請稍後再試' }
    }
    const beforeIds = new Set(before.flatMap((i) => i.orderItemIds))

    try {
      const accepted = await client.submitItem(
        detail,
        {
          menuItemId: item.menuItemId,
          productId: item.productId,
          quantity: item.quantity,
          note: item.note,
        },
        buyerName,
        userId,
      )
      if (!accepted) return { ok: false, reason: '網站拒絕送出，請至網頁確認' }
    } catch (err) {
      return { ok: false, reason: errMsg(err) }
    }

    // 已送出；之後任何失敗都不能回報為送出失敗
    let after: MyOrderItem[]
    try {
      after = await client.fetchMyItems(orderId)
    } catch {
      return { ok: true, recorded: [] }
    }
    const added = after.filter((i) =>
      i.orderItemIds.some((id) => !beforeIds.has(id)),
    )
    // 只認姓名相符的新增品項，避免同時有人送單時算到別人
    // ponytail: 假設網站回傳的 buyerName 等於送出的 playedName；若不符則退回全部新增 id，並留下警告
    let mineAdded = added.filter((i) => i.buyerName === buyerName)
    if (mineAdded.length === 0 && added.length > 0) {
      console.warn('[Submissions] buyerName mismatch, recording all new items')
      mineAdded = added
    }
    const recorded = mineAdded
      .flatMap((i) => i.orderItemIds)
      .filter((id) => !beforeIds.has(id))
    if (recorded.length > 0) {
      db.recordSubmission(
        userId,
        orderId,
        recorded,
        item.name,
        buyerName,
        detail.order.organizer,
      )
    }
    return { ok: true, recorded }
  }

  /** 網路錯誤直接丟出。 */
  async mine(userId: number, orderId: string): Promise<MyItems> {
    const all = await this.deps.client.fetchMyItems(orderId)
    const myIds = this.deps.db.getMyItemIds(userId, orderId)
    return {
      all,
      mine: all.filter((i) => i.orderItemIds.some((id) => myIds.has(id))),
    }
  }

  /** 只取消屬於自己的 id；沒有可取消的就不呼叫網站。 */
  async cancel(
    userId: number,
    orderId: string,
    ids: number[],
  ): Promise<CancelResult> {
    const { client, db } = this.deps
    const myIds = db.getMyItemIds(userId, orderId)
    const own = ids.filter((id) => myIds.has(id))
    if (own.length === 0) return { ok: false, reason: '找不到可取消的品項' }
    await client.cancelItem(orderId, own, userId)
    db.recordCancellation(own)
    return { ok: true, ...(await this.mine(userId, orderId)) }
  }
}
