import {
  Order,
  OrderDetail,
  MyOrderItem,
  MenuCategory,
  MenuProduct,
  MenuVariation,
} from './dinbendon'

// ─── Order list ───────────────────────────────────────────────────────────────

export function formatOrderList(orders: Order[]): string {
  if (orders.length === 0) return '😔 目前沒有開放中的訂單。'
  const lines = orders.map((o, i) => {
    const deadline = o.deadline
      ? `\n   ⏰ 截止：${escapeMarkdown(o.deadline)}`
      : ''
    const organizer = o.organizer
      ? `\n   👤 發起人：${escapeMarkdown(o.organizer)}`
      : ''
    return `*${i + 1}\\.* 🍱 ${escapeMarkdown(o.shopName || o.title)}${deadline}${organizer}`
  })
  return `📋 *開放中的訂單*\n\n${lines.join('\n\n')}\n\n請選擇要訂的訂單：`
}

export function buildOrderKeyboard(
  orders: Order[],
): { text: string; callback_data: string }[][] {
  return orders.map((o, i) => {
    const shop = truncate(o.shopName || o.title, 20)
    const organizer = o.organizer ? truncate(o.organizer, 10) : ''
    const label = organizer ? `${organizer} - ${shop}` : shop
    return [{ text: label, callback_data: `order:${i}` }]
  })
}

// ─── Category list ────────────────────────────────────────────────────────────

export function formatCategoryList(detail: OrderDetail): string {
  return `🍽️ *${escapeMarkdown(detail.order.shopName)}*\n\n請選擇分類：`
}

export function buildCategoryKeyboard(
  categories: MenuCategory[],
): { text: string; callback_data: string }[][] {
  const buttons = categories.map((cat, i) => [
    {
      text: `${cat.name} (${cat.products.length})`,
      callback_data: `category:${i}`,
    },
  ])
  buttons.push([{ text: '📋 查看已送出訂單', callback_data: 'my:order' }])
  buttons.push([{ text: '❌ 取消', callback_data: 'cancel' }])
  return buttons
}

// ─── Product list ─────────────────────────────────────────────────────────────

export function formatProductList(
  shopName: string,
  categoryName: string,
): string {
  return `🍽️ *${escapeMarkdown(shopName)}* › *${escapeMarkdown(categoryName)}*\n\n請選擇餐點：`
}

export function buildProductKeyboard(
  products: MenuProduct[],
  categoryIdx: number,
): { text: string; callback_data: string }[][] {
  const buttons = products.map((p) => {
    const prices = p.variations.map((v) => v.price)
    const min = Math.min(...prices)
    const max = Math.max(...prices)
    const priceStr = min === max ? `$${min}` : `$${min}~${max}`
    return [
      {
        text: `${truncate(p.name, 24)} ${priceStr}`,
        callback_data: `product:${p.id}`,
      },
    ]
  })
  buttons.push([{ text: '🔙 回分類', callback_data: 'back:cat' }])
  return buttons
}

// ─── Variation list ───────────────────────────────────────────────────────────

export function formatVariationList(productName: string): string {
  return `🍱 *${escapeMarkdown(productName)}*\n\n請選擇口味：`
}

export function buildVariationKeyboard(
  variations: MenuVariation[],
  productName: string,
): { text: string; callback_data: string }[][] {
  const buttons = variations.map((v) => {
    const label = v.name
      ? `${v.name} - $${v.price}`
      : `${productName} - $${v.price}`
    return [{ text: label, callback_data: `variation:${v.id}` }]
  })
  buttons.push([{ text: '🔙 回餐點', callback_data: 'back:products' }])
  return buttons
}

// ─── Quantity ─────────────────────────────────────────────────────────────────

export function buildQuantityKeyboard(): {
  text: string
  callback_data: string
}[][] {
  return [
    [1, 2, 3, 4, 5].map((q) => ({
      text: String(q),
      callback_data: `qty:${q}`,
    })),
    [{ text: '❌ 取消', callback_data: 'cancel' }],
  ]
}

// ─── My order ─────────────────────────────────────────────────────────────────

export function formatMyOrder(shopName: string, items: MyOrderItem[]): string {
  if (items.length === 0) {
    return `📋 *${escapeMarkdown(shopName)}*\n\n尚未有送出的品項。`
  }
  const lines = items.map((item, i) => {
    const note = item.comment
      ? `\n   _備註：${escapeMarkdown(item.comment)}_`
      : ''
    const cancelMark = item.cancelable ? '' : ' 🔒'
    const buyer = item.buyerName ? ` \\(${escapeMarkdown(item.buyerName)}\\)` : ''
    return `*${i + 1}\\.* ${escapeMarkdown(item.productName)}${buyer}${cancelMark} x${item.qty} \\= $${item.price * item.qty}${note}`
  })
  const total = items.reduce((s, item) => s + item.price * item.qty, 0)
  return `📋 *${escapeMarkdown(shopName)} 訂單總覽*\n\n${lines.join('\n\n')}\n\n💰 *合計：$${total}*`
}

export function buildMyOrderKeyboard(
  items: MyOrderItem[],
): { text: string; callback_data: string }[][] {
  const cancelButtons = items
    .filter((item) => item.cancelable && item.orderItemIds.length > 0)
    .map((item) => [
      {
        text: `🗑 取消：${truncate(item.productName, 16)} (${truncate(item.buyerName, 8)}) x${item.qty}`,
        callback_data: `cancel:item:${item.orderItemIds.join(',')}`,
      },
    ])
  return [
    ...cancelButtons,
    [{ text: '🔄 重新整理', callback_data: 'my:order' }],
    [{ text: '🔙 回菜單', callback_data: 'back:cat' }],
  ]
}

// ─── Utilities ────────────────────────────────────────────────────────────────

export function escapeMarkdown(text: unknown): string {
  const s = typeof text === 'string' ? text : String(text ?? '')
  return s.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&')
}

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen - 1) + '…' : text
}
