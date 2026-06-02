import { Order, OrderDetail, CartItem } from './dinbendon';

export function formatOrderList(orders: Order[]): string {
  if (orders.length === 0) {
    return '😔 目前沒有開放中的訂單。';
  }
  const lines = orders.map((o, i) => {
    const deadline = o.deadline ? `\n   ⏰ 截止：${o.deadline}` : '';
    const organizer = o.organizer ? `\n   👤 發起人：${o.organizer}` : '';
    return `*${i + 1}.* 🍱 ${escapeMarkdown(o.shopName || o.title)}${deadline}${organizer}`;
  });
  return `📋 *開放中的訂單*\n\n${lines.join('\n\n')}\n\n請選擇要訂的訂單：`;
}

export function formatMenu(detail: OrderDetail): string {
  const { order, menuItems } = detail;
  if (menuItems.length === 0) {
    return `🍽️ *${escapeMarkdown(order.shopName)}*\n\n找不到菜單項目，請直接至網頁點餐。`;
  }
  const lines = menuItems.map((item, i) => {
    const desc = item.description ? `\n   _${escapeMarkdown(item.description)}_` : '';
    return `*${i + 1}.* ${escapeMarkdown(item.name)} - $${item.price}${desc}`;
  });
  return `🍽️ *${escapeMarkdown(order.shopName)}* 菜單\n\n${lines.join('\n')}\n\n請選擇要點的品項：`;
}

export function formatCart(cart: CartItem[]): string {
  if (cart.length === 0) {
    return '🛒 購物車是空的。';
  }
  const lines = cart.map((item) => {
    const note = item.note ? ` _(${escapeMarkdown(item.note)})_` : '';
    return `• ${escapeMarkdown(item.name)} x${item.quantity} = $${item.price * item.quantity}${note}`;
  });
  const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  return `🛒 *目前購物車*\n\n${lines.join('\n')}\n\n💰 *合計：$${total}*`;
}

export function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

export function buildOrderKeyboard(orders: Order[]): { text: string; callback_data: string }[][] {
  const buttons = orders.map((o, i) => [
    {
      text: `${i + 1}. ${truncate(o.shopName || o.title, 30)}`,
      callback_data: `order:${i}`,
    },
  ]);
  return buttons;
}

export function buildMenuKeyboard(
  menuItems: { id: string; name: string; price: number }[],
  page = 0,
  pageSize = 8
): { text: string; callback_data: string }[][] {
  const start = page * pageSize;
  const end = Math.min(start + pageSize, menuItems.length);
  const pageItems = menuItems.slice(start, end);

  const buttons: { text: string; callback_data: string }[][] = pageItems.map((item) => [
    {
      text: `${item.name} - $${item.price}`,
      callback_data: `item:${item.id}`,
    },
  ]);

  // Navigation buttons
  const nav: { text: string; callback_data: string }[] = [];
  if (page > 0) nav.push({ text: '◀ 上一頁', callback_data: `menu_page:${page - 1}` });
  if (end < menuItems.length) nav.push({ text: '下一頁 ▶', callback_data: `menu_page:${page + 1}` });
  if (nav.length > 0) buttons.push(nav);

  buttons.push([{ text: '🛒 查看購物車', callback_data: 'cart:view' }]);
  buttons.push([{ text: '❌ 取消', callback_data: 'cancel' }]);
  return buttons;
}

export function buildCartKeyboard(): { text: string; callback_data: string }[][] {
  return [
    [{ text: '✅ 確認送出訂單', callback_data: 'cart:confirm' }],
    [{ text: '🗑️ 清空購物車', callback_data: 'cart:clear' }],
    [{ text: '🔙 繼續點餐', callback_data: 'cart:back' }],
    [{ text: '❌ 取消', callback_data: 'cancel' }],
  ];
}

export function buildConfirmKeyboard(): { text: string; callback_data: string }[][] {
  return [
    [
      { text: '✅ 確定送出', callback_data: 'confirm:yes' },
      { text: '❌ 取消', callback_data: 'confirm:no' },
    ],
  ];
}

export function buildQuantityKeyboard(itemId: string): { text: string; callback_data: string }[][] {
  const quantities = [1, 2, 3, 4, 5];
  return [
    quantities.map((q) => ({ text: String(q), callback_data: `qty:${q}` })),
    [{ text: '❌ 取消', callback_data: 'cancel' }],
  ];
}

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen - 1) + '…' : text;
}
