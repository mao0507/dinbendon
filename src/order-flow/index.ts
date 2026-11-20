import { DinBenDonClient, OrderDetail } from '../dinbendon'
import { Submissions } from '../submissions'
import { SessionManager, UserSession } from './session'
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
  buildNoteKeyboard,
  buildBuyerNameKeyboard,
  buildOrdersButton,
  escapeMarkdown,
} from './messages'

export { escapeMarkdown, Keyboard }

/**
 * 畫面輸出 port。`text` 一律是 MarkdownV2。
 * 第一次 show 要「新送」或「編輯原訊息」由 adapter 依輸入來源決定，
 * 之後的 show 都編輯同一則訊息。回傳顯示所在的 message id。
 */
export interface Ui {
  show(text: string, keyboard?: Keyboard): Promise<number>
}

export type FlowInput =
  /** messageId：按鈕所在訊息；有給才做過期檢查 */
  | { kind: 'callback'; data: string; messageId?: number }
  | { kind: 'text'; text: string }
  | { kind: 'command'; name: 'orders' | 'cancel' | 'reset' }

export interface OrderFlowDeps {
  client: DinBenDonClient
  submissions: Submissions
}

const errText = (err: unknown): string =>
  escapeMarkdown(err instanceof Error ? err.message : String(err))

/** 點餐流程：session 狀態、步驟轉換、callback 編解碼、送單，全在這個 module 內。 */
export class OrderFlow {
  private sessions = new SessionManager()
  // ponytail: 只存在記憶體，重啟後要重打一次姓名
  private lastBuyerName = new Map<number, string>()

  constructor(private deps: OrderFlowDeps) {}

  async handle(userId: number, input: FlowInput, rawUi: Ui): Promise<void> {
    // 記下最後一次顯示的訊息，作為「目前有效選單」
    const ui: Ui = {
      show: async (text, keyboard) => {
        const id = await rawUi.show(text, keyboard)
        this.sessions.update(userId, { activeMessageId: id })
        return id
      },
    }
    switch (input.kind) {
      case 'command':
        return this.onCommand(userId, input.name, ui)
      case 'callback': {
        const s = this.sessions.get(userId)
        const stale =
          input.messageId !== undefined &&
          input.messageId !== s.activeMessageId &&
          input.data !== cb.orders
        if (stale) {
          // 不經過追蹤：過期訊息不能變成有效選單
          await rawUi.show('⌛ 此選單已過期，請重新開啟訂單。', buildOrdersButton())
          return
        }
        return this.onCallback(userId, input.data, ui)
      }
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
      await ui.show('✅ 已取消目前操作。', buildOrdersButton())
      return
    }

    await this.showOrders(userId, ui)
  }

  // ─── Callbacks ──────────────────────────────────────────────────────────────

  private async onCallback(userId: number, data: string, ui: Ui): Promise<void> {
    const c = decodeCallback(data)
    if (!c) return
    const session = this.sessions.get(userId)

    switch (c.type) {
      case 'orders':
        await this.showOrders(userId, ui)
        return

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
          await ui.show(`❌ 載入菜單失敗：${errText(err)}`, [
            [{ text: '🔄 重試', callback_data: cb.order(c.idx) }],
            [{ text: '🔙 回訂單列表', callback_data: cb.orders }],
          ])
        }
        return
      }

      case 'category': {
        const detail = session.orderDetail
        if (!detail?.categories[c.idx]) return
        this.sessions.update(userId, { selectedCategoryIdx: c.idx })
        await this.showProducts(userId, ui)
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
            pendingProduct: undefined,
            pendingItem: {
              menuItemId: v.id,
              productId: product.id,
              name: product.name,
              price: v.price,
            },
          })
          await this.showQuantity(userId, ui)
        } else {
          this.sessions.update(userId, {
            pendingProduct: {
              productId: product.id,
              productName: product.name,
              variations: product.variations,
            },
            pendingItem: undefined,
          })
          await this.showVariations(userId, ui)
        }
        return
      }

      case 'variation': {
        const pending = session.pendingProduct
        const variation = pending?.variations.find((v) => v.id === c.id)
        if (!pending || !variation) return
        this.sessions.update(userId, {
          pendingItem: {
            menuItemId: c.id,
            productId: pending.productId,
            name: variation.name
              ? `${pending.productName} (${variation.name})`
              : pending.productName,
            price: variation.price,
          },
        })
        await this.showQuantity(userId, ui)
        return
      }

      case 'qty': {
        const pending = session.pendingItem
        if (!pending) return
        this.sessions.update(userId, {
          pendingItem: { ...pending, quantity: c.n, note: undefined },
        })
        await this.showNote(userId, ui)
        return
      }

      case 'noteSkip': {
        if (!session.pendingItem) return
        this.sessions.update(userId, {
          pendingItem: { ...session.pendingItem, note: undefined },
        })
        await this.showBuyerName(userId, ui)
        return
      }

      case 'lastName': {
        const name = this.lastBuyerName.get(userId)
        if (session.step !== 'entering_buyer_name' || !name) return
        await this.submit(userId, name, ui)
        return
      }

      case 'back':
        await this.goBack(userId, ui)
        return

      case 'myOrder': {
        const detail = session.orderDetail
        if (!detail) return
        await ui.show('⏳ 載入已送出品項\\.\\.\\.')
        try {
          await this.showMyOrder(userId, detail, ui)
        } catch (err) {
          await ui.show(`❌ 載入失敗：${errText(err)}`, [
            [{ text: '🔄 重試', callback_data: cb.myOrder }],
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
          const result = await this.deps.submissions.cancel(
            userId,
            detail.order.id,
            c.ids,
          )
          if (!result.ok) {
            await ui.show(`❌ 取消失敗：${escapeMarkdown(result.reason)}`, [
              [{ text: '🔙 回菜單', callback_data: cb.backCat }],
            ])
            return
          }
          await ui.show(
            formatMyOrder(detail.order.shopName, result.all),
            buildMyOrderKeyboard(result.mine),
          )
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

      case 'backProducts':
        await this.showProducts(userId, ui)
        return

      case 'cancel': {
        // 點餐中取消：回到原本的餐點列表；在分類畫面取消：離開流程
        const hasPending = session.pendingItem || session.pendingProduct
        if (hasPending && session.orderDetail) {
          await this.showProducts(userId, ui)
          return
        }
        this.sessions.update(userId, {
          step: 'idle',
          pendingItem: undefined,
          pendingProduct: undefined,
          orderDetail: undefined,
          selectedOrder: undefined,
        })
        await ui.show('✅ 已離開訂餐流程。', buildOrdersButton())
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
      })
      await this.showBuyerName(userId, ui, '✅ 備註已記錄。\n\n')
      return
    }

    if (session.step === 'entering_buyer_name') {
      await this.submit(userId, text.trim(), ui)
    }
  }

  // ─── Screens ────────────────────────────────────────────────────────────────

  private async showOrders(userId: number, ui: Ui): Promise<void> {
    await ui.show('⏳ 抓取訂單中\\.\\.\\.')
    try {
      const orders = await this.deps.client.fetchOpenOrders()
      console.log(`[orders] fetched ${orders.length} orders for user ${userId}`)
      this.sessions.update(userId, {
        step: 'selecting_order',
        orders,
        orderDetail: undefined,
        selectedOrder: undefined,
        pendingItem: undefined,
        pendingProduct: undefined,
      })
      if (orders.length === 0) {
        await ui.show('😔 目前沒有開放中的訂單。', buildOrdersButton('🔄 重新整理'))
        return
      }
      await ui.show(formatOrderList(orders), buildOrderKeyboard(orders))
    } catch (err) {
      console.error('[orders] error:', err)
      await ui.show(`❌ 抓取訂單失敗：${errText(err)}`, buildOrdersButton('🔄 重試'))
    }
  }

  private async showCategories(userId: number, ui: Ui): Promise<void> {
    const detail = this.sessions.get(userId).orderDetail
    if (!detail) {
      await ui.show('請先選擇訂單。', buildOrdersButton())
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

  private async showProducts(userId: number, ui: Ui): Promise<void> {
    const s = this.sessions.get(userId)
    const idx = s.selectedCategoryIdx
    const category = idx === undefined ? undefined : s.orderDetail?.categories[idx]
    if (!s.orderDetail || idx === undefined || !category) {
      await this.showCategories(userId, ui)
      return
    }
    this.sessions.update(userId, {
      step: 'selecting_item',
      pendingProduct: undefined,
      pendingItem: undefined,
    })
    await ui.show(
      formatProductList(s.orderDetail.order.shopName, category.name),
      buildProductKeyboard(category.products, idx),
    )
  }

  private async showVariations(userId: number, ui: Ui): Promise<void> {
    const p = this.sessions.get(userId).pendingProduct
    if (!p) return this.showProducts(userId, ui)
    this.sessions.update(userId, { step: 'selecting_variation', pendingItem: undefined })
    await ui.show(formatVariationList(p.productName), buildVariationKeyboard(p.variations, p.productName))
  }

  private async showQuantity(userId: number, ui: Ui): Promise<void> {
    const item = this.sessions.get(userId).pendingItem
    if (!item) return this.showProducts(userId, ui)
    this.sessions.update(userId, { step: 'entering_quantity' })
    await ui.show(
      `🍱 *${escapeMarkdown(item.name)}* \\- $${item.price}\n\n請選擇數量：`,
      buildQuantityKeyboard(),
    )
  }

  private async showNote(userId: number, ui: Ui): Promise<void> {
    const item = this.sessions.get(userId).pendingItem
    if (!item) return this.showProducts(userId, ui)
    this.sessions.update(userId, { step: 'entering_note' })
    await ui.show(
      `✏️ *${escapeMarkdown(item.name)}* x${item.quantity}\n\n要加備註嗎？直接輸入備註內容，或點選「不加備註」：`,
      buildNoteKeyboard(),
    )
  }

  private async showBuyerName(userId: number, ui: Ui, prefix = ''): Promise<void> {
    const item = this.sessions.get(userId).pendingItem
    if (!item) return this.showProducts(userId, ui)
    this.sessions.update(userId, { step: 'entering_buyer_name' })
    const note = item.note ? `\n備註：${escapeMarkdown(item.note)}` : ''
    await ui.show(
      `${prefix}🍱 *${escapeMarkdown(item.name)}* x${item.quantity ?? 1}${note}\n\n請輸入*訂購人姓名*：`,
      buildBuyerNameKeyboard(this.lastBuyerName.get(userId)),
    )
  }

  /** 「上一步」依目前步驟決定回到哪個畫面 */
  private async goBack(userId: number, ui: Ui): Promise<void> {
    const s = this.sessions.get(userId)
    switch (s.step) {
      case 'entering_quantity':
        return s.pendingProduct ? this.showVariations(userId, ui) : this.showProducts(userId, ui)
      case 'entering_note':
        return this.showQuantity(userId, ui)
      case 'entering_buyer_name':
        return this.showNote(userId, ui)
      default:
        return this.showProducts(userId, ui)
    }
  }

  private async showMyOrder(
    userId: number,
    detail: OrderDetail,
    ui: Ui,
  ): Promise<void> {
    const { all, mine } = await this.deps.submissions.mine(
      userId,
      detail.order.id,
    )
    await ui.show(
      formatMyOrder(detail.order.shopName, all),
      buildMyOrderKeyboard(mine),
    )
  }

  private async submit(userId: number, buyerName: string, ui: Ui): Promise<void> {
    const session: UserSession = this.sessions.get(userId)
    const pending = session.pendingItem
    const detail = session.orderDetail
    if (!pending || !detail || pending.quantity === undefined || !buyerName) return

    // 先切到 submitting：期間再傳的文字不會符合任何分支，避免重送
    this.sessions.update(userId, { step: 'submitting' })
    await ui.show(`⏳ 以「${escapeMarkdown(buyerName)}」送出\\.\\.\\. `)

    // place 約定不丟例外；DB 寫入等意外仍要能解除 submitting，不能卡死使用者
    const result = await this.deps.submissions
      .place(
        userId,
        detail,
        {
          menuItemId: pending.menuItemId,
          productId: pending.productId,
          name: pending.name,
          quantity: pending.quantity,
          note: pending.note,
        },
        buyerName,
      )
      .catch((err: unknown) => ({
        ok: false as const,
        reason: err instanceof Error ? err.message : String(err),
      }))

    this.lastBuyerName.set(userId, buyerName)
    if (!result.ok) {
      // 保留待送品項，使用者可重打姓名重試
      this.sessions.update(userId, { step: 'entering_buyer_name' })
      await ui.show(
        `❌ 送出失敗：${escapeMarkdown(result.reason)}\n\n可重新輸入*訂購人姓名*再試一次：`,
        buildBuyerNameKeyboard(buyerName),
      )
      return
    }

    this.sessions.update(userId, {
      pendingItem: undefined,
      pendingProduct: undefined,
      step: 'selecting_category',
    })
    const unrecorded =
      result.recorded.length === 0 ? '\n⚠️ 無法記錄此品項，請至網頁確認' : ''
    await ui.show(
      `✅ *${escapeMarkdown(pending.name)}* x${pending.quantity} 已送出\\!\n訂購人：${escapeMarkdown(buyerName)}${unrecorded}`,
      buildCategoryKeyboard(detail.categories),
    )
  }
}
