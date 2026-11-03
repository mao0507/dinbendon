import { DinBenDonClient, OrderDetail } from '../dinbendon'
import { BotDatabase } from '../database'
import { SessionManager } from './session'
import { cb, decodeCallback } from './callbacks'
import {
  Keyboard,
  formatOrderList,
  formatCategoryList,
  formatProductList,
  formatVariationList,
  formatMyOrder,
  buildOrderKeyboard,
  buildCategoryKeyboard,
  buildProductKeyboard,
  buildVariationKeyboard,
  buildQuantityKeyboard,
  buildMyOrderKeyboard,
  escapeMarkdown,
} from './messages'

export { escapeMarkdown, Keyboard }

/**
 * 畫面輸出 port。`text` 一律是 MarkdownV2。
 * 第一次 show 要「新送」或「編輯原訊息」由 adapter 依輸入來源決定，
 * 之後的 show 都編輯同一則訊息。
 */
export interface Ui {
  show(text: string, keyboard?: Keyboard): Promise<void>
}

export type FlowInput =
  | { kind: 'callback'; data: string }
  | { kind: 'text'; text: string }
  | { kind: 'command'; name: 'orders' | 'cancel' | 'reset' }

export interface OrderFlowDeps {
  client: DinBenDonClient
  db: BotDatabase
}

const errText = (err: unknown): string =>
  escapeMarkdown(err instanceof Error ? err.message : String(err))

/** 點餐流程：session 狀態、步驟轉換、callback 編解碼、送單，全在這個 module 內。 */
export class OrderFlow {
  private sessions = new SessionManager()

  constructor(private deps: OrderFlowDeps) {}

  async handle(userId: number, input: FlowInput, ui: Ui): Promise<void> {
    switch (input.kind) {
      case 'command':
        return this.onCommand(userId, input.name, ui)
      case 'callback':
        return this.onCallback(userId, input.data, ui)
      case 'text':
        return this.onText(userId, input.text, ui)
    }
  }

  // ─── Commands ───────────────────────────────────────────────────────────────

  private async onCommand(
    userId: number,
    name: 'orders' | 'cancel' | 'reset',
    ui: Ui,
  ): Promise<void> {
    if (name === 'reset') {
      this.sessions.reset(userId)
      return
    }

    if (name === 'cancel') {
      this.sessions.update(userId, {
        step: 'idle',
        pendingItem: undefined,
        pendingProduct: undefined,
      })
      await ui.show('✅ 已取消目前操作。')
      return
    }

    await ui.show('⏳ 抓取訂單中\\.\\.\\.')
    try {
      const orders = await this.deps.client.fetchOpenOrders()
      console.log(`[orders] fetched ${orders.length} orders for user ${userId}`)
      this.sessions.update(userId, { step: 'selecting_order', orders })
      if (orders.length === 0) {
        await ui.show('😔 目前沒有開放中的訂單。')
        return
      }
      await ui.show(formatOrderList(orders), buildOrderKeyboard(orders))
    } catch (err) {
      console.error('[orders] error:', err)
      await ui.show(`❌ 抓取訂單失敗：${errText(err)}`)
    }
  }

  // ─── Callbacks ──────────────────────────────────────────────────────────────

  private async onCallback(userId: number, data: string, ui: Ui): Promise<void> {
    const c = decodeCallback(data)
    if (!c) return
    const session = this.sessions.get(userId)

    switch (c.type) {
      case 'order': {
        const order = session.orders[c.idx]
        if (!order) return
        this.sessions.update(userId, { selectedOrder: order })
        await ui.show(
          `⏳ 載入 *${escapeMarkdown(order.shopName)}* 菜單中\\.\\.\\.`,
        )
        try {
          const detail = await this.deps.client.fetchOrderDetail(order)
          this.sessions.update(userId, {
            orderDetail: detail,
            step: 'selecting_category',
          })
          await ui.show(
            formatCategoryList(detail),
            buildCategoryKeyboard(detail.categories),
          )
        } catch (err) {
          await ui.show(`❌ 載入菜單失敗：${errText(err)}`)
        }
        return
      }

      case 'category': {
        const detail = session.orderDetail
        const category = detail?.categories[c.idx]
        if (!detail || !category) return
        this.sessions.update(userId, {
          step: 'selecting_item',
          selectedCategoryIdx: c.idx,
          pendingProduct: undefined,
        })
        await ui.show(
          formatProductList(detail.order.shopName, category.name),
          buildProductKeyboard(category.products, c.idx),
        )
        return
      }

      case 'product': {
        const detail = session.orderDetail
        if (!detail) return
        const product = detail.categories
          .flatMap((cat) => cat.products)
          .find((p) => p.id === c.id)
        if (!product) return

        if (product.variations.length === 1 && !product.variations[0].name) {
          const v = product.variations[0]
          this.sessions.update(userId, {
            step: 'entering_quantity',
            pendingProduct: undefined,
            pendingItem: {
              menuItemId: v.id,
              productId: product.id,
              name: product.name,
              price: v.price,
            },
          })
          await ui.show(
            `🍱 *${escapeMarkdown(product.name)}* \\- $${v.price}\n\n請選擇數量：`,
            buildQuantityKeyboard(),
          )
        } else {
          this.sessions.update(userId, {
            step: 'selecting_variation',
            pendingProduct: {
              productId: product.id,
              productName: product.name,
              variations: product.variations,
            },
            pendingItem: undefined,
          })
          await ui.show(
            formatVariationList(product.name),
            buildVariationKeyboard(product.variations, product.name),
          )
        }
        return
      }

      case 'variation': {
        const pending = session.pendingProduct
        const variation = pending?.variations.find((v) => v.id === c.id)
        if (!pending || !variation) return

        const displayName = variation.name
          ? `${escapeMarkdown(pending.productName)} \\(${escapeMarkdown(variation.name)}\\)`
          : escapeMarkdown(pending.productName)
        this.sessions.update(userId, {
          step: 'entering_quantity',
          pendingItem: {
            menuItemId: c.id,
            productId: pending.productId,
            name: variation.name
              ? `${pending.productName} (${variation.name})`
              : pending.productName,
            price: variation.price,
          },
        })
        await ui.show(
          `🍱 *${displayName}* \\- $${variation.price}\n\n請選擇數量：`,
          buildQuantityKeyboard(),
        )
        return
      }

      case 'qty': {
        const pending = session.pendingItem
        if (!pending) return
        this.sessions.update(userId, {
          pendingItem: { ...pending, quantity: c.n },
          step: 'entering_note',
        })
        await ui.show(
          `✏️ *${escapeMarkdown(pending.name)}* x${c.n}\n\n要加備註嗎？直接輸入備註內容，或點選「不加備註」：`,
          [
            [{ text: '📝 不加備註', callback_data: cb.noteSkip }],
            [{ text: '❌ 取消', callback_data: cb.cancel }],
          ],
        )
        return
      }

      case 'noteSkip': {
        this.sessions.update(userId, { step: 'entering_buyer_name' })
        const pending = session.pendingItem
        if (!pending) return
        const noteText = pending.note
          ? `\n備註：${escapeMarkdown(pending.note)}`
          : ''
        await ui.show(
          `🍱 *${escapeMarkdown(pending.name)}* x${pending.quantity ?? 1}${noteText}\n\n請輸入*訂購人姓名*：`,
          [[{ text: '❌ 取消', callback_data: cb.cancel }]],
        )
        return
      }

      case 'myOrder': {
        const detail = session.orderDetail
        if (!detail) return
        await ui.show('⏳ 載入已送出品項\\.\\.\\.')
        try {
          await this.showMyOrder(userId, detail, ui)
        } catch (err) {
          await ui.show(`❌ 載入失敗：${errText(err)}`, [
            [{ text: '🔙 回菜單', callback_data: cb.backCat }],
          ])
        }
        return
      }

      case 'cancelItems': {
        const detail = session.orderDetail
        if (!detail || c.ids.length === 0) return
        await ui.show('⏳ 取消中\\.\\.\\.')
        try {
          await this.deps.client.cancelItem(detail.order.id, c.ids)
          this.deps.db.recordCancellation(c.ids)
          await this.showMyOrder(userId, detail, ui)
        } catch (err) {
          await ui.show(`❌ 取消失敗：${errText(err)}`, [
            [{ text: '🔙 回菜單', callback_data: cb.backCat }],
          ])
        }
        return
      }

      case 'backCat':
        await this.showCategories(userId, ui)
        return

      case 'backProducts': {
        const detail = session.orderDetail
        const catIdx = session.selectedCategoryIdx
        const category = catIdx === undefined ? undefined : detail?.categories[catIdx]
        if (!detail || catIdx === undefined || !category) {
          await this.showCategories(userId, ui)
          return
        }
        this.sessions.update(userId, {
          step: 'selecting_item',
          pendingProduct: undefined,
        })
        await ui.show(
          formatProductList(detail.order.shopName, category.name),
          buildProductKeyboard(category.products, catIdx),
        )
        return
      }

      case 'cancel': {
        const hasPending = session.pendingItem || session.pendingProduct
        this.sessions.update(userId, {
          pendingItem: undefined,
          pendingProduct: undefined,
        })
        if (hasPending && session.orderDetail) {
          await this.showCategories(userId, ui)
        } else {
          this.sessions.update(userId, {
            step: 'idle',
            orderDetail: undefined,
            selectedOrder: undefined,
          })
          await ui.show('✅ 已離開訂餐流程。\n\n輸入 /orders 重新開始。')
        }
        return
      }
    }
  }

  // ─── Text ───────────────────────────────────────────────────────────────────

  private async onText(userId: number, text: string, ui: Ui): Promise<void> {
    const session = this.sessions.get(userId)

    if (session.step === 'entering_note' && session.pendingItem) {
      this.sessions.update(userId, {
        pendingItem: { ...session.pendingItem, note: text.trim() },
        step: 'entering_buyer_name',
      })
      await ui.show('✅ 備註已記錄，請輸入*訂購人姓名*：', [
        [{ text: '❌ 取消', callback_data: cb.cancel }],
      ])
      return
    }

    if (session.step === 'entering_buyer_name') {
      await this.submit(userId, text.trim(), ui)
    }
  }

  // ─── Shared steps ───────────────────────────────────────────────────────────

  private async showCategories(userId: number, ui: Ui): Promise<void> {
    const detail = this.sessions.get(userId).orderDetail
    if (!detail) {
      await ui.show('請先使用 /orders 選擇訂單。')
      return
    }
    this.sessions.update(userId, {
      step: 'selecting_category',
      selectedCategoryIdx: undefined,
      pendingProduct: undefined,
      pendingItem: undefined,
    })
    await ui.show(formatCategoryList(detail), buildCategoryKeyboard(detail.categories))
  }

  private async showMyOrder(
    userId: number,
    detail: OrderDetail,
    ui: Ui,
  ): Promise<void> {
    const allItems = await this.deps.client.fetchMyItems(detail.order.id)
    const myIds = this.deps.db.getMyItemIds(userId, detail.order.id)
    const myItems = allItems.filter((item) =>
      item.orderItemIds.some((id) => myIds.has(id)),
    )
    await ui.show(
      formatMyOrder(detail.order.shopName, allItems),
      buildMyOrderKeyboard(myItems),
    )
  }

  // 送單邏輯原樣搬入，之後由「Submissions」module 取代。
  private async submit(userId: number, buyerName: string, ui: Ui): Promise<void> {
    const { client, db } = this.deps
    const session = this.sessions.get(userId)
    const pending = session.pendingItem
    const detail = session.orderDetail
    if (!pending || !detail || pending.quantity === undefined) return

    const orderHashId = detail.order.id
    await ui.show(`⏳ 以「${escapeMarkdown(buyerName)}」送出\\.\\.\\. `)

    // 送出前先快照，才能找出這次新建的 orderItemIds
    const beforeItems = await client.fetchMyItems(orderHashId).catch(() => [])
    const beforeIds = new Set(beforeItems.flatMap((i) => i.orderItemIds))

    try {
      const success = await client.submitItem(
        detail,
        {
          menuItemId: pending.menuItemId,
          productId: pending.productId,
          quantity: pending.quantity,
          note: pending.note,
        },
        buyerName,
      )

      this.sessions.update(userId, {
        pendingItem: undefined,
        pendingProduct: undefined,
        step: 'selecting_category',
      })

      if (!success) {
        await ui.show('❌ 送出失敗，請至網頁確認。')
        return
      }

      const afterItems = await client.fetchMyItems(orderHashId).catch(() => [])
      const newIds = afterItems
        .flatMap((i) => i.orderItemIds)
        .filter((id) => !beforeIds.has(id))
      if (newIds.length > 0) {
        db.recordSubmission(
          userId,
          orderHashId,
          newIds,
          pending.name,
          buyerName,
          detail.order.organizer,
        )
      }

      await ui.show(
        `✅ *${escapeMarkdown(pending.name)}* x${pending.quantity} 已送出\\!\n訂購人：${escapeMarkdown(buyerName)}`,
        buildCategoryKeyboard(detail.categories),
      )
    } catch (err) {
      await ui.show(`❌ 送出失敗：${errText(err)}`)
    }
  }
}
