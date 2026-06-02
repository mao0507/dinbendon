import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import TelegramBot from 'node-telegram-bot-api';
import { DinBenDonClient } from './dinbendon';
import { SessionManager } from './session';
import {
  formatOrderList,
  formatMenu,
  formatCart,
  buildOrderKeyboard,
  buildMenuKeyboard,
  buildCartKeyboard,
  buildConfirmKeyboard,
  buildQuantityKeyboard,
  escapeMarkdown,
} from './messages';

// ─── Config ───────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const DBD_USERNAME = process.env.DINBENDON_USERNAME ?? '';
const DBD_PASSWORD = process.env.DINBENDON_PASSWORD ?? '';

if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN is not set!');
  process.exit(1);
}
if (!DBD_USERNAME || !DBD_PASSWORD) {
  console.error('❌ DINBENDON_USERNAME or DINBENDON_PASSWORD is not set!');
  process.exit(1);
}

// ─── Singletons ───────────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const dbdClient = new DinBenDonClient();
const sessions = new SessionManager();
let clientReady = false;
let loginInProgress = false;

// ─── Helper: safe reply ───────────────────────────────────────────────────────
async function reply(
  chatId: number,
  text: string,
  keyboard?: { text: string; callback_data: string }[][]
): Promise<TelegramBot.Message> {
  const options: TelegramBot.SendMessageOptions = {
    parse_mode: 'MarkdownV2',
  };
  if (keyboard) {
    options.reply_markup = { inline_keyboard: keyboard };
  }
  return bot.sendMessage(chatId, text, options);
}

async function editMessage(
  chatId: number,
  messageId: number,
  text: string,
  keyboard?: { text: string; callback_data: string }[][]
): Promise<void> {
  const options: TelegramBot.EditMessageTextOptions = {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'MarkdownV2',
  };
  if (keyboard) {
    options.reply_markup = { inline_keyboard: keyboard };
  }
  await bot.editMessageText(text, options);
}

// ─── Ensure login ─────────────────────────────────────────────────────────────
async function ensureLogin(chatId: number): Promise<boolean> {
  if (clientReady) return true;
  if (loginInProgress) {
    await reply(chatId, '⏳ 正在登入中，請稍候\\.\\.\\.');
    return false;
  }

  loginInProgress = true;
  const loadingMsg = await reply(chatId, '🔐 正在登入訂便當系統\\.\\.\\.');

  try {
    await dbdClient.login(DBD_USERNAME, DBD_PASSWORD);
    clientReady = true;
    await bot.deleteMessage(chatId, loadingMsg.message_id);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await bot.editMessageText(`❌ 登入失敗：${msg}`, {
      chat_id: chatId,
      message_id: loadingMsg.message_id,
    });
    return false;
  } finally {
    loginInProgress = false;
  }
}

// ─── /start ───────────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  sessions.reset(chatId);
  await reply(
    chatId,
    `👋 *歡迎使用訂便當 Bot\\!*\n\n使用以下指令開始：\n\n` +
      `🍱 /orders \\- 查看開放中的訂單\n` +
      `🛒 /cart \\- 查看購物車\n` +
      `❓ /help \\- 使用說明`
  );
});

// ─── /help ────────────────────────────────────────────────────────────────────
bot.onText(/\/help/, async (msg) => {
  await reply(
    msg.chat.id,
    `📖 *使用說明*\n\n` +
      `1\\. 輸入 /orders 查看目前開放的訂單\n` +
      `2\\. 選擇訂單後，瀏覽菜單並點選品項\n` +
      `3\\. 輸入數量（1\\~5）\n` +
      `4\\. 可選擇加備註\n` +
      `5\\. 確認購物車後送出\n\n` +
      `💡 同一品項可重複點選累加數量`
  );
});

// ─── /orders ──────────────────────────────────────────────────────────────────
bot.onText(/\/orders/, async (msg) => {
  const chatId = msg.chat.id;
  const ok = await ensureLogin(chatId);
  if (!ok) return;

  const session = sessions.get(chatId);
  const loadingMsg = await reply(chatId, '⏳ 抓取訂單中\\.\\.\\.');

  try {
    const orders = await dbdClient.fetchOpenOrders();
    session.orders = orders;
    sessions.update(chatId, { step: 'selecting_order', orders });

    await bot.deleteMessage(chatId, loadingMsg.message_id);

    if (orders.length === 0) {
      await reply(chatId, '😔 目前沒有開放中的訂單\\。');
      return;
    }

    await reply(
      chatId,
      formatOrderList(orders),
      buildOrderKeyboard(orders)
    );
  } catch (err) {
    const msg2 = err instanceof Error ? err.message : String(err);
    await bot.editMessageText(`❌ 抓取訂單失敗：${msg2}`, {
      chat_id: chatId,
      message_id: loadingMsg.message_id,
    });
  }
});

// ─── /cart ────────────────────────────────────────────────────────────────────
bot.onText(/\/cart/, async (msg) => {
  const chatId = msg.chat.id;
  const session = sessions.get(chatId);
  const text = formatCart(session.cart);
  if (session.cart.length > 0) {
    await reply(chatId, text, buildCartKeyboard());
  } else {
    await reply(chatId, text);
  }
});

// ─── /cancel ──────────────────────────────────────────────────────────────────
bot.onText(/\/cancel/, async (msg) => {
  const chatId = msg.chat.id;
  sessions.update(chatId, { step: 'idle', pendingItem: undefined });
  await reply(chatId, '✅ 已取消目前操作\\。');
});

// ─── Callback queries ─────────────────────────────────────────────────────────
bot.on('callback_query', async (query) => {
  const chatId = query.message?.chat.id;
  const messageId = query.message?.message_id;
  if (!chatId || !messageId) return;

  await bot.answerCallbackQuery(query.id);

  const data = query.data ?? '';
  const session = sessions.get(chatId);

  // ── Order selected ──────────────────────────────────────────────────────────
  if (data.startsWith('order:')) {
    const idx = parseInt(data.split(':')[1]);
    const order = session.orders[idx];
    if (!order) return;

    sessions.update(chatId, { step: 'viewing_menu', selectedOrder: order });

    await editMessage(chatId, messageId, `⏳ 載入 *${escapeMarkdown(order.shopName)}* 菜單中\\.\\.\\.`);

    try {
      const detail = await dbdClient.fetchOrderDetail(order);
      sessions.update(chatId, { orderDetail: detail, step: 'selecting_item' });

      await editMessage(
        chatId,
        messageId,
        formatMenu(detail),
        buildMenuKeyboard(detail.menuItems)
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await editMessage(chatId, messageId, `❌ 載入菜單失敗：${escapeMarkdown(msg)}`);
    }
    return;
  }

  // ── Menu pagination ─────────────────────────────────────────────────────────
  if (data.startsWith('menu_page:')) {
    const page = parseInt(data.split(':')[1]);
    const detail = session.orderDetail;
    if (!detail) return;
    await editMessage(
      chatId,
      messageId,
      formatMenu(detail),
      buildMenuKeyboard(detail.menuItems, page)
    );
    return;
  }

  // ── Item selected ───────────────────────────────────────────────────────────
  if (data.startsWith('item:')) {
    const itemId = data.split(':')[1];
    const menuItem = session.orderDetail?.menuItems.find((m) => m.id === itemId);
    if (!menuItem) return;

    sessions.update(chatId, {
      step: 'entering_quantity',
      pendingItem: { menuItemId: itemId, name: menuItem.name, price: menuItem.price },
    });

    await editMessage(
      chatId,
      messageId,
      `🍱 *${escapeMarkdown(menuItem.name)}* \\- \\$${menuItem.price}\n\n請選擇數量：`,
      buildQuantityKeyboard(itemId)
    );
    return;
  }

  // ── Quantity selected ───────────────────────────────────────────────────────
  if (data.startsWith('qty:')) {
    const qty = parseInt(data.split(':')[1]);
    const pending = session.pendingItem;
    if (!pending) return;

    sessions.update(chatId, {
      pendingItem: { ...pending, quantity: qty },
      step: 'entering_note',
    });

    await editMessage(
      chatId,
      messageId,
      `✏️ *${escapeMarkdown(pending.name)}* x${qty}\n\n要加備註嗎？直接輸入備註內容，或點選「不加備註」：`,
      [[{ text: '📝 不加備註', callback_data: 'note:skip' }], [{ text: '❌ 取消', callback_data: 'cancel' }]]
    );
    return;
  }

  // ── Note: skip ──────────────────────────────────────────────────────────────
  if (data === 'note:skip') {
    await addPendingItemToCart(chatId, messageId, session, undefined);
    return;
  }

  // ── Cart: view ──────────────────────────────────────────────────────────────
  if (data === 'cart:view') {
    const cartText = formatCart(session.cart);
    const keyboard = session.cart.length > 0 ? buildCartKeyboard() : undefined;
    await editMessage(chatId, messageId, cartText, keyboard);
    return;
  }

  // ── Cart: back to menu ──────────────────────────────────────────────────────
  if (data === 'cart:back') {
    const detail = session.orderDetail;
    if (!detail) return;
    sessions.update(chatId, { step: 'selecting_item' });
    await editMessage(chatId, messageId, formatMenu(detail), buildMenuKeyboard(detail.menuItems));
    return;
  }

  // ── Cart: clear ─────────────────────────────────────────────────────────────
  if (data === 'cart:clear') {
    sessions.update(chatId, { cart: [] });
    await editMessage(chatId, messageId, '🗑️ 購物車已清空\\。');
    return;
  }

  // ── Cart: confirm (show review) ─────────────────────────────────────────────
  if (data === 'cart:confirm') {
    if (session.cart.length === 0) {
      await editMessage(chatId, messageId, '😅 購物車是空的，請先選擇品項\\。');
      return;
    }
    const cartText = formatCart(session.cart);
    sessions.update(chatId, { step: 'confirming' });
    await editMessage(
      chatId,
      messageId,
      `${cartText}\n\n確定要送出以上訂單嗎？`,
      buildConfirmKeyboard()
    );
    return;
  }

  // ── Confirm: yes ─────────────────────────────────────────────────────────────
  if (data === 'confirm:yes') {
    if (!session.orderDetail || session.cart.length === 0) return;

    await editMessage(chatId, messageId, '⏳ 送出訂單中\\.\\.\\.');

    try {
      const items = session.cart.map((c) => ({
        menuItemId: c.name, // use name as identifier for matching
        quantity: c.quantity,
        note: c.note,
      }));
      const success = await dbdClient.submitOrder(session.orderDetail, items);

      if (success) {
        sessions.update(chatId, { cart: [], step: 'idle', orderDetail: undefined, selectedOrder: undefined });
        await editMessage(
          chatId,
          messageId,
          '✅ *訂單已成功送出\\!* 🎉\n\n輸入 /orders 可繼續訂餐\\。'
        );
      } else {
        await editMessage(
          chatId,
          messageId,
          '❌ 送出失敗，請至網頁確認訂單狀態\\。',
          [[{ text: '🔄 重試', callback_data: 'cart:confirm' }]]
        );
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await editMessage(
        chatId,
        messageId,
        `❌ 送出失敗：${escapeMarkdown(errMsg)}\n\n請至網頁手動確認\\。`
      );
    }
    return;
  }

  // ── Confirm: no ──────────────────────────────────────────────────────────────
  if (data === 'confirm:no') {
    const detail = session.orderDetail;
    if (!detail) return;
    sessions.update(chatId, { step: 'selecting_item' });
    await editMessage(chatId, messageId, formatMenu(detail), buildMenuKeyboard(detail.menuItems));
    return;
  }

  // ── Cancel ───────────────────────────────────────────────────────────────────
  if (data === 'cancel') {
    const detail = session.orderDetail;
    sessions.update(chatId, { step: detail ? 'selecting_item' : 'idle', pendingItem: undefined });
    if (detail) {
      await editMessage(chatId, messageId, formatMenu(detail), buildMenuKeyboard(detail.menuItems));
    } else {
      await editMessage(chatId, messageId, '✅ 已取消\\。');
    }
    return;
  }
});

// ─── Text messages (for note input) ───────────────────────────────────────────
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;
  const session = sessions.get(chatId);

  if (session.step === 'entering_note' && session.pendingItem) {
    const note = msg.text.trim();
    await addPendingItemToCartViaText(chatId, session, note);
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function addPendingItemToCart(
  chatId: number,
  messageId: number,
  session: ReturnType<SessionManager['get']>,
  note: string | undefined
): Promise<void> {
  const pending = session.pendingItem;
  if (!pending || pending.quantity === undefined) return;

  const cart = [...session.cart];
  const existing = cart.find(
    (c) => c.menuItemId === pending.menuItemId && c.note === (note ?? '')
  );

  if (existing) {
    existing.quantity += pending.quantity;
  } else {
    cart.push({
      menuItemId: pending.menuItemId,
      name: pending.name,
      price: pending.price,
      quantity: pending.quantity,
      note,
    });
  }

  sessions.update(chatId, { cart, pendingItem: undefined, step: 'selecting_item' });

  const detail = session.orderDetail!;
  const total = cart.reduce((s, c) => s + c.price * c.quantity, 0);
  const noteText = note ? ` \\(備註：${escapeMarkdown(note)}\\)` : '';
  await editMessage(
    chatId,
    messageId,
    `✅ 已加入 *${escapeMarkdown(pending.name)}* x${pending.quantity}${noteText}\n💰 目前合計：\\$${total}\n\n繼續點餐或查看購物車：`,
    [
      ...buildMenuKeyboard(detail.menuItems),
    ]
  );
}

async function addPendingItemToCartViaText(
  chatId: number,
  session: ReturnType<SessionManager['get']>,
  note: string
): Promise<void> {
  const pending = session.pendingItem;
  if (!pending || pending.quantity === undefined) return;

  const cart = [...session.cart];
  cart.push({
    menuItemId: pending.menuItemId,
    name: pending.name,
    price: pending.price,
    quantity: pending.quantity,
    note,
  });

  sessions.update(chatId, { cart, pendingItem: undefined, step: 'selecting_item' });

  const detail = session.orderDetail!;
  const total = cart.reduce((s, c) => s + c.price * c.quantity, 0);
  await bot.sendMessage(
    chatId,
    `✅ 已加入 *${escapeMarkdown(pending.name)}* x${pending.quantity} \\(備註：${escapeMarkdown(note)}\\)\n💰 目前合計：\\$${total}`,
    {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: buildMenuKeyboard(detail.menuItems) },
    }
  );
}

// ─── Start ────────────────────────────────────────────────────────────────────
console.log('🤖 DinBenDon Telegram Bot starting...');
console.log(`📡 Connected to: ${BOT_TOKEN.slice(0, 10)}...`);

// Pre-login on startup
(async () => {
  try {
    console.log('🔐 Pre-logging in to DinBenDon...');
    await dbdClient.login(DBD_USERNAME, DBD_PASSWORD);
    clientReady = true;
    console.log('✅ Pre-login successful!');
  } catch (err) {
    console.error('⚠️ Pre-login failed, will retry on demand:', err instanceof Error ? err.message : err);
  }
})();

console.log('✅ Bot is running. Press Ctrl+C to stop.');

process.on('SIGINT', () => {
  console.log('\n👋 Bot shutting down...');
  bot.stopPolling();
  process.exit(0);
});
