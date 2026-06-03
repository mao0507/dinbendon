import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import TelegramBot from 'node-telegram-bot-api';
import { DinBenDonClient } from './dinbendon';
import { SessionManager } from './session';
import {
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
} from './messages';

// ─── Config ───────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const DBD_USERNAME = process.env.DINBENDON_USERNAME ?? '';
const DBD_PASSWORD = process.env.DINBENDON_PASSWORD ?? '';

if (!BOT_TOKEN) { console.error('❌ TELEGRAM_BOT_TOKEN is not set!'); process.exit(1); }
if (!DBD_USERNAME || !DBD_PASSWORD) { console.error('❌ DINBENDON_USERNAME or DINBENDON_PASSWORD is not set!'); process.exit(1); }

// ─── Singletons ───────────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const dbdClient = new DinBenDonClient();
const sessions = new SessionManager();
let clientReady = false;
let loginInProgress = false;

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function reply(
  chatId: number,
  text: string,
  keyboard?: { text: string; callback_data: string }[][]
): Promise<TelegramBot.Message> {
  const options: TelegramBot.SendMessageOptions = { parse_mode: 'MarkdownV2' };
  if (keyboard) options.reply_markup = { inline_keyboard: keyboard };
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
  if (keyboard) options.reply_markup = { inline_keyboard: keyboard };
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

async function showCategories(chatId: number, messageId: number, userId: number): Promise<void> {
  const session = sessions.get(userId);
  const detail = session.orderDetail;
  if (!detail) {
    await editMessage(chatId, messageId, '請先使用 /orders 選擇訂單\\。');
    return;
  }
  sessions.update(userId, { step: 'selecting_category', selectedCategoryIdx: undefined, pendingProduct: undefined, pendingItem: undefined });
  await editMessage(chatId, messageId, formatCategoryList(detail), buildCategoryKeyboard(detail.categories));
}

// ─── /start ───────────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id ?? chatId;
  sessions.reset(userId);
  await reply(
    chatId,
    `👋 *歡迎使用訂便當 Bot\\!*\n\n` +
      `🍱 /orders \\- 查看開放中的訂單\n` +
      `❓ /help \\- 使用說明`
  );
});

// ─── /help ────────────────────────────────────────────────────────────────────
bot.onText(/\/help/, async (msg) => {
  await reply(
    msg.chat.id,
    `📖 *使用說明*\n\n` +
      `1\\. 輸入 /orders 查看目前開放的訂單\n` +
      `2\\. 選擇訂單後，依分類瀏覽菜單\n` +
      `3\\. 選擇品項 → 選口味 → 選數量\n` +
      `4\\. 可填寫備註\n` +
      `5\\. 輸入訂購人姓名後立即送出\n` +
      `6\\. 點「查看已送出訂單」確認品項`
  );
});

// ─── /orders ──────────────────────────────────────────────────────────────────
bot.onText(/\/orders/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id ?? chatId;
  const ok = await ensureLogin(chatId);
  if (!ok) return;

  const loadingMsg = await reply(chatId, '⏳ 抓取訂單中\\.\\.\\.');
  let loadingDeleted = false;

  try {
    const orders = await dbdClient.fetchOpenOrders();
    sessions.update(userId, { step: 'selecting_order', orders });

    await bot.deleteMessage(chatId, loadingMsg.message_id);
    loadingDeleted = true;

    if (orders.length === 0) {
      await reply(chatId, '😔 目前沒有開放中的訂單\\。');
      return;
    }
    await reply(chatId, formatOrderList(orders), buildOrderKeyboard(orders));
  } catch (err) {
    const errText = `❌ 抓取訂單失敗：${escapeMarkdown(err instanceof Error ? err.message : String(err))}`;
    try {
      if (loadingDeleted) await reply(chatId, errText);
      else await editMessage(chatId, loadingMsg.message_id, errText);
    } catch {
      await reply(chatId, errText).catch(() => {});
    }
  }
});

// ─── /cancel ──────────────────────────────────────────────────────────────────
bot.onText(/\/cancel/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id ?? chatId;
  sessions.update(userId, { step: 'idle', pendingItem: undefined, pendingProduct: undefined });
  await reply(chatId, '✅ 已取消目前操作\\。');
});

// ─── Callback queries ─────────────────────────────────────────────────────────
bot.on('callback_query', async (query) => {
  const chatId = query.message?.chat.id;
  const messageId = query.message?.message_id;
  if (!chatId || !messageId) return;
  await bot.answerCallbackQuery(query.id);

  const userId = query.from.id;
  const data = query.data ?? '';
  const session = sessions.get(userId);

  // ── Order selected ──────────────────────────────────────────────────────────
  if (data.startsWith('order:')) {
    const idx = parseInt(data.split(':')[1]);
    const order = session.orders[idx];
    if (!order) return;

    sessions.update(userId, { selectedOrder: order });
    await editMessage(chatId, messageId, `⏳ 載入 *${escapeMarkdown(order.shopName)}* 菜單中\\.\\.\\.`);

    try {
      const detail = await dbdClient.fetchOrderDetail(order);
      sessions.update(userId, { orderDetail: detail, step: 'selecting_category' });
      await editMessage(chatId, messageId, formatCategoryList(detail), buildCategoryKeyboard(detail.categories));
    } catch (err) {
      await editMessage(chatId, messageId, `❌ 載入菜單失敗：${escapeMarkdown(err instanceof Error ? err.message : String(err))}`);
    }
    return;
  }

  // ── Category selected ───────────────────────────────────────────────────────
  if (data.startsWith('category:')) {
    const idx = parseInt(data.split(':')[1]);
    const detail = session.orderDetail;
    if (!detail) return;
    const category = detail.categories[idx];
    if (!category) return;

    sessions.update(userId, { step: 'selecting_item', selectedCategoryIdx: idx, pendingProduct: undefined });
    await editMessage(
      chatId, messageId,
      formatProductList(detail.order.shopName, category.name),
      buildProductKeyboard(category.products, idx)
    );
    return;
  }

  // ── Product selected ────────────────────────────────────────────────────────
  if (data.startsWith('product:')) {
    const productId = data.slice('product:'.length);
    const detail = session.orderDetail;
    if (!detail) return;

    let foundProduct: { id: string; name: string; variations: { id: string; name: string | null; price: number }[] } | undefined;
    for (const cat of detail.categories) {
      foundProduct = cat.products.find((p) => p.id === productId);
      if (foundProduct) break;
    }
    if (!foundProduct) return;

    if (foundProduct.variations.length === 1 && !foundProduct.variations[0].name) {
      const v = foundProduct.variations[0];
      sessions.update(userId, {
        step: 'entering_quantity',
        pendingProduct: undefined,
        pendingItem: { menuItemId: v.id, productId: foundProduct.id, name: foundProduct.name, price: v.price },
      });
      await editMessage(
        chatId, messageId,
        `🍱 *${escapeMarkdown(foundProduct.name)}* \\- \\$${v.price}\n\n請選擇數量：`,
        buildQuantityKeyboard()
      );
    } else {
      sessions.update(userId, {
        step: 'selecting_variation',
        pendingProduct: { productId: foundProduct.id, productName: foundProduct.name, variations: foundProduct.variations },
        pendingItem: undefined,
      });
      await editMessage(
        chatId, messageId,
        formatVariationList(foundProduct.name),
        buildVariationKeyboard(foundProduct.variations, foundProduct.name)
      );
    }
    return;
  }

  // ── Variation selected ──────────────────────────────────────────────────────
  if (data.startsWith('variation:')) {
    const variationId = data.slice('variation:'.length);
    const pending = session.pendingProduct;
    if (!pending) return;

    const variation = pending.variations.find((v) => v.id === variationId);
    if (!variation) return;

    const displayName = variation.name
      ? `${escapeMarkdown(pending.productName)} \\(${escapeMarkdown(variation.name)}\\)`
      : escapeMarkdown(pending.productName);

    sessions.update(userId, {
      step: 'entering_quantity',
      pendingItem: {
        menuItemId: variationId,
        productId: pending.productId,
        name: variation.name ? `${pending.productName} (${variation.name})` : pending.productName,
        price: variation.price,
      },
    });
    await editMessage(
      chatId, messageId,
      `🍱 *${displayName}* \\- \\$${variation.price}\n\n請選擇數量：`,
      buildQuantityKeyboard()
    );
    return;
  }

  // ── Quantity selected ───────────────────────────────────────────────────────
  if (data.startsWith('qty:')) {
    const qty = parseInt(data.split(':')[1]);
    const pending = session.pendingItem;
    if (!pending) return;

    sessions.update(userId, {
      pendingItem: { ...pending, quantity: qty },
      step: 'entering_note',
    });
    await editMessage(
      chatId, messageId,
      `✏️ *${escapeMarkdown(pending.name)}* x${qty}\n\n要加備註嗎？直接輸入備註內容，或點選「不加備註」：`,
      [[{ text: '📝 不加備註', callback_data: 'note:skip' }], [{ text: '❌ 取消', callback_data: 'cancel' }]]
    );
    return;
  }

  // ── Note: skip → ask buyer name ─────────────────────────────────────────────
  if (data === 'note:skip') {
    sessions.update(userId, { step: 'entering_buyer_name' });
    await askBuyerName(chatId, messageId, userId);
    return;
  }

  // ── View my submitted order ─────────────────────────────────────────────────
  if (data === 'my:order') {
    const detail = session.orderDetail;
    if (!detail) return;

    await editMessage(chatId, messageId, '⏳ 載入已送出品項\\.\\.\\.');
    try {
      const items = await dbdClient.fetchMyItems(detail.order.id);
      await editMessage(chatId, messageId, formatMyOrder(detail.order.shopName, items), buildMyOrderKeyboard(items));
    } catch (err) {
      await editMessage(chatId, messageId, `❌ 載入失敗：${escapeMarkdown(err instanceof Error ? err.message : String(err))}`,
        [[{ text: '🔙 回菜單', callback_data: 'back:cat' }]]);
    }
    return;
  }

  // ── Cancel submitted item ───────────────────────────────────────────────────
  if (data.startsWith('cancel:item:')) {
    const detail = session.orderDetail;
    if (!detail) return;

    const ids = data.slice('cancel:item:'.length).split(',').map(Number).filter(n => !isNaN(n));
    if (ids.length === 0) return;

    await editMessage(chatId, messageId, '⏳ 取消中\\.\\.\\.');
    try {
      await dbdClient.cancelItem(detail.order.id, ids);
      const items = await dbdClient.fetchMyItems(detail.order.id);
      await editMessage(chatId, messageId, formatMyOrder(detail.order.shopName, items), buildMyOrderKeyboard(items));
    } catch (err) {
      await editMessage(chatId, messageId, `❌ 取消失敗：${escapeMarkdown(err instanceof Error ? err.message : String(err))}`,
        [[{ text: '🔙 回菜單', callback_data: 'back:cat' }]]);
    }
    return;
  }

  // ── Back to categories ──────────────────────────────────────────────────────
  if (data === 'back:cat') {
    await showCategories(chatId, messageId, userId);
    return;
  }

  // ── Back to products ────────────────────────────────────────────────────────
  if (data === 'back:products') {
    const detail = session.orderDetail;
    const catIdx = session.selectedCategoryIdx;
    if (!detail || catIdx === undefined) {
      await showCategories(chatId, messageId, userId);
      return;
    }
    const category = detail.categories[catIdx];
    sessions.update(userId, { step: 'selecting_item', pendingProduct: undefined });
    await editMessage(
      chatId, messageId,
      formatProductList(detail.order.shopName, category.name),
      buildProductKeyboard(category.products, catIdx)
    );
    return;
  }

  // ── Cancel ───────────────────────────────────────────────────────────────────
  if (data === 'cancel') {
    const hasPending = session.pendingItem || session.pendingProduct;
    sessions.update(userId, { pendingItem: undefined, pendingProduct: undefined });
    if (hasPending && session.orderDetail) {
      // cancel mid-flow → back to category list
      await showCategories(chatId, messageId, userId);
    } else {
      // cancel at category list → exit ordering flow
      sessions.update(userId, { step: 'idle', orderDetail: undefined, selectedOrder: undefined });
      await editMessage(chatId, messageId, '✅ 已離開訂餐流程\\。\n\n輸入 /orders 重新開始\\。');
    }
    return;
  }
});

// ─── Text messages ────────────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;
  const userId = msg.from?.id ?? chatId;
  const session = sessions.get(userId);

  if (session.step === 'entering_note' && session.pendingItem) {
    const note = msg.text.trim();
    sessions.update(userId, { pendingItem: { ...session.pendingItem, note }, step: 'entering_buyer_name' });
    await reply(chatId, '✅ 備註已記錄，請輸入*訂購人姓名*：',
      [[{ text: '❌ 取消', callback_data: 'cancel' }]]);
    return;
  }

  if (session.step === 'entering_buyer_name') {
    await submitItem(chatId, userId, msg.text.trim());
  }
});

// ─── Submit helpers ───────────────────────────────────────────────────────────
async function askBuyerName(chatId: number, messageId: number, userId: number): Promise<void> {
  const session = sessions.get(userId);
  const pending = session.pendingItem;
  if (!pending) return;

  const noteText = pending.note ? `\n備註：${escapeMarkdown(pending.note)}` : '';
  await editMessage(
    chatId, messageId,
    `🍱 *${escapeMarkdown(pending.name)}* x${pending.quantity ?? 1}${noteText}\n\n請輸入*訂購人姓名*：`,
    [[{ text: '❌ 取消', callback_data: 'cancel' }]]
  );
}

async function submitItem(chatId: number, userId: number, buyerName: string): Promise<void> {
  const session = sessions.get(userId);
  const pending = session.pendingItem;
  if (!pending || !session.orderDetail || pending.quantity === undefined) return;

  const loadingMsg = await reply(chatId, `⏳ 以「${escapeMarkdown(buyerName)}」送出\\.\\.\\. `);

  try {
    const success = await dbdClient.submitItem(session.orderDetail, {
      menuItemId: pending.menuItemId,
      productId: pending.productId,
      quantity: pending.quantity,
      note: pending.note,
    }, buyerName);

    sessions.update(userId, { pendingItem: undefined, pendingProduct: undefined, step: 'selecting_category' });

    if (success) {
      await bot.editMessageText(
        `✅ *${escapeMarkdown(pending.name)}* x${pending.quantity} 已送出\\!\n訂購人：${escapeMarkdown(buyerName)}`,
        {
          chat_id: chatId,
          message_id: loadingMsg.message_id,
          parse_mode: 'MarkdownV2',
          reply_markup: { inline_keyboard: buildCategoryKeyboard(session.orderDetail!.categories) },
        }
      );
    } else {
      await bot.editMessageText('❌ 送出失敗，請至網頁確認\\。', {
        chat_id: chatId,
        message_id: loadingMsg.message_id,
        parse_mode: 'MarkdownV2',
      });
    }
  } catch (err) {
    const errMsg = escapeMarkdown(err instanceof Error ? err.message : String(err));
    await bot.editMessageText(`❌ 送出失敗：${errMsg}`, {
      chat_id: chatId,
      message_id: loadingMsg.message_id,
      parse_mode: 'MarkdownV2',
    }).catch(() => reply(chatId, `❌ 送出失敗：${errMsg}`));
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────
console.log('🤖 DinBenDon Telegram Bot starting...');
console.log(`📡 Connected to: ${BOT_TOKEN.slice(0, 10)}...`);

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

process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Unhandled rejection:', reason);
});
