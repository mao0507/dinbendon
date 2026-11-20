import * as dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

import TelegramBot from 'node-telegram-bot-api'
import { DinBenDonClient } from './dinbendon'
import { BotDatabase } from './database'
import { startAdminServer } from './admin'
import { Submissions } from './submissions'
import { Access } from './access'
import { OrderFlow, Ui, Keyboard, escapeMarkdown } from './order-flow'

// ─── Config ───────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? ''
const DBD_USERNAME = process.env.DINBENDON_USERNAME ?? ''
const DBD_PASSWORD = process.env.DINBENDON_PASSWORD ?? ''
const RAW_ADMIN_USER_ID = process.env.ADMIN_USER_ID?.trim()
const ADMIN_PORT = process.env.ADMIN_PORT
  ? parseInt(process.env.ADMIN_PORT)
  : 3000
const WHITELIST_DEFAULT = process.env.WHITELIST_ENABLED !== 'false'

if (RAW_ADMIN_USER_ID && !/^-?\d+$/.test(RAW_ADMIN_USER_ID)) {
  console.error('❌ ADMIN_USER_ID must be a number!')
  process.exit(1)
}
const ADMIN_USER_ID = RAW_ADMIN_USER_ID ? parseInt(RAW_ADMIN_USER_ID) : null

if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN is not set!')
  process.exit(1)
}
if (!DBD_USERNAME || !DBD_PASSWORD) {
  console.error('❌ DINBENDON_USERNAME or DINBENDON_PASSWORD is not set!')
  process.exit(1)
}

// ─── Singletons ───────────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true })
const dbdClient = new DinBenDonClient({
  username: DBD_USERNAME,
  password: DBD_PASSWORD,
})
const botDb = new BotDatabase(undefined, WHITELIST_DEFAULT)
const access = new Access({ db: botDb, adminUserId: ADMIN_USER_ID })
const flow = new OrderFlow({
  client: dbdClient,
  submissions: new Submissions({ client: dbdClient, db: botDb }),
})

// ─── Menu（左下角「/」選單）────────────────────────────────────────────────────
const USER_COMMANDS: TelegramBot.BotCommand[] = [
  { command: 'orders', description: '查看開放中的訂單' },
  { command: 'cancel', description: '取消目前點餐流程' },
  { command: 'help', description: '使用說明' },
  { command: 'version', description: '查看版本資訊' },
  { command: 'start', description: '重新開始' },
]
const ADMIN_COMMANDS: TelegramBot.BotCommand[] = [
  ...USER_COMMANDS,
  { command: 'users', description: '列出使用者（管理員）' },
  { command: 'add_user', description: '授權使用者 <userId>（管理員）' },
  { command: 'revoke_user', description: '撤銷授權 <userId>（管理員）' },
]
bot.setMyCommands(USER_COMMANDS).catch((err) => console.error('[menu] setMyCommands failed:', err))
if (ADMIN_USER_ID) {
  // 私聊 chat id = user id，管理員才看得到管理指令
  bot
    .setMyCommands(ADMIN_COMMANDS, { scope: { type: 'chat', chat_id: ADMIN_USER_ID } })
    .catch((err) => console.error('[menu] admin setMyCommands failed:', err))
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function reply(
  chatId: number,
  text: string,
  keyboard?: Keyboard,
): Promise<TelegramBot.Message> {
  const options: TelegramBot.SendMessageOptions = { parse_mode: 'MarkdownV2' }
  if (keyboard) options.reply_markup = { inline_keyboard: keyboard }
  return bot.sendMessage(chatId, text, options)
}

async function editMessage(
  chatId: number,
  messageId: number,
  text: string,
  keyboard?: Keyboard,
): Promise<void> {
  const options: TelegramBot.EditMessageTextOptions = {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'MarkdownV2',
  }
  if (keyboard) options.reply_markup = { inline_keyboard: keyboard }
  await bot.editMessageText(text, options)
}

async function ensureAuth(chatId: number, userId: number): Promise<boolean> {
  if (access.isAllowed(userId)) return true
  await reply(
    chatId,
    `🔒 您尚未獲得授權，請聯絡管理員。\n您的 ID：\`${userId}\``,
  )
  return false
}

async function requireAdmin(chatId: number, userId: number): Promise<boolean> {
  if (access.isAdmin(userId)) return true
  await reply(chatId, '🚫 此指令僅限管理員使用。')
  return false
}

// callback 的第一次 show 編輯按鈕所在訊息；指令與文字輸入則新送一則，之後都編輯同一則。
function makeUi(chatId: number, messageId?: number): Ui {
  let current = messageId
  return {
    async show(text, keyboard) {
      if (current === undefined) {
        current = (await reply(chatId, text, keyboard)).message_id
      } else {
        await editMessage(chatId, current, text, keyboard)
      }
    },
  }
}

async function runFlow(
  userId: number,
  input: Parameters<OrderFlow['handle']>[1],
  ui: Ui,
): Promise<void> {
  try {
    await flow.handle(userId, input, ui)
  } catch (err) {
    console.error('[flow] error:', err)
  }
}

// ─── /start ───────────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id
  const userId = msg.from?.id ?? chatId
  botDb.upsertUser(userId, msg.from?.username, msg.from?.first_name)
  await runFlow(userId, { kind: 'command', name: 'reset' }, makeUi(chatId))

  if (!access.isAllowed(userId)) {
    await reply(
      chatId,
      `👋 *歡迎使用子恩早餐店 Bot\\!*\n\n🔒 您尚未獲得授權，請聯絡管理員。\n您的 ID：\`${userId}\``,
    )
    return
  }

  await reply(
    chatId,
    `👋 *歡迎使用子恩早餐店 Bot\\!*\n\n` +
      `🍱 /orders \\- 查看開放中的訂單\n` +
      `❓ /help \\- 使用說明\n` +
      `🔖 /version \\- 查看版本資訊`,
  )
})

// ─── /help ────────────────────────────────────────────────────────────────────
bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id
  const userId = msg.from?.id ?? chatId
  if (!(await ensureAuth(chatId, userId))) return

  await reply(
    chatId,
    `📖 *使用說明*\n\n` +
      `1\\. 輸入 /orders 查看目前開放的訂單\n` +
      `2\\. 選擇訂單後，依分類瀏覽菜單\n` +
      `3\\. 選擇品項 → 選口味 → 選數量\n` +
      `4\\. 可填寫備註\n` +
      `5\\. 輸入訂購人姓名後立即送出\n` +
      `6\\. 點「查看已送出訂單」確認品項`,
  )
})

// ─── /orders ──────────────────────────────────────────────────────────────────
bot.onText(/\/orders/, async (msg) => {
  const chatId = msg.chat.id
  const userId = msg.from?.id ?? chatId
  botDb.upsertUser(userId, msg.from?.username, msg.from?.first_name)
  if (!(await ensureAuth(chatId, userId))) return

  await runFlow(userId, { kind: 'command', name: 'orders' }, makeUi(chatId))
})

// ─── /cancel ──────────────────────────────────────────────────────────────────
bot.onText(/\/cancel/, async (msg) => {
  const chatId = msg.chat.id
  const userId = msg.from?.id ?? chatId
  if (!(await ensureAuth(chatId, userId))) return
  await runFlow(userId, { kind: 'command', name: 'cancel' }, makeUi(chatId))
})

// ─── Admin: /add_user ──────────────────────────────────────────────────────────
bot.onText(/\/add_user(?:\s+(-?\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id
  const userId = msg.from?.id ?? chatId
  if (!(await requireAdmin(chatId, userId))) return
  const targetId = match?.[1] ? parseInt(match[1]) : null
  if (!targetId) {
    await reply(chatId, '用法：`/add_user <userId>`')
    return
  }
  botDb.authorizeUser(targetId)
  await reply(chatId, `✅ 已授權 \`${targetId}\`。`)
})

// ─── Admin: /revoke_user ───────────────────────────────────────────────────────
bot.onText(/\/revoke_user(?:\s+(-?\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id
  const userId = msg.from?.id ?? chatId
  if (!(await requireAdmin(chatId, userId))) return
  const targetId = match?.[1] ? parseInt(match[1]) : null
  if (!targetId) {
    await reply(chatId, '用法：`/revoke_user <userId>`')
    return
  }
  const ok = botDb.revokeUser(targetId)
  await reply(
    chatId,
    ok ? `✅ 已撤銷 \`${targetId}\` 的授權。` : `⚠️ 找不到 \`${targetId}\`。`,
  )
})

// ─── Admin: /users ────────────────────────────────────────────────────────────
bot.onText(/\/users/, async (msg) => {
  const chatId = msg.chat.id
  const userId = msg.from?.id ?? chatId
  if (!(await requireAdmin(chatId, userId))) return
  const users = botDb.listUsers()
  if (users.length === 0) {
    await reply(chatId, '目前沒有已記錄的用戶。')
    return
  }
  const lines = users.map((u) => {
    const name = u.firstName ? escapeMarkdown(u.firstName) : '\\(未知\\)'
    const tag = u.username ? ` @${escapeMarkdown(u.username)}` : ''
    const status = u.authorized ? '✅' : '🔒'
    return `${status} ${name}${tag} — \`${u.userId}\``
  })
  await reply(chatId, `👥 *用戶清單*\n\n${lines.join('\n')}`)
})

// ─── /version ─────────────────────────────────────────────────────────────────
bot.onText(/\/version/, async (msg) => {
  const chatId = msg.chat.id
  const { execSync } = require('child_process')
  try {
    const hash = execSync('git rev-parse --short=7 HEAD', { cwd: __dirname })
      .toString()
      .trim()
    await reply(chatId, `🔖 版本：\`${hash}\``)
  } catch {
    await reply(chatId, '⚠️ 無法取得版本資訊。')
  }
})

// ─── Callback queries ─────────────────────────────────────────────────────────
bot.on('callback_query', async (query) => {
  const chatId = query.message?.chat.id
  const messageId = query.message?.message_id
  if (!chatId || !messageId) return
  await bot.answerCallbackQuery(query.id)

  const userId = query.from.id
  if (!(await ensureAuth(chatId, userId))) return

  await runFlow(
    userId,
    { kind: 'callback', data: query.data ?? '' },
    makeUi(chatId, messageId),
  )
})

// ─── Text messages ────────────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return
  const chatId = msg.chat.id
  const userId = msg.from?.id ?? chatId
  if (!(await ensureAuth(chatId, userId))) return

  await runFlow(userId, { kind: 'text', text: msg.text }, makeUi(chatId))
})

// ─── Start ────────────────────────────────────────────────────────────────────
console.log('🤖 DinBenDon Telegram Bot starting...')
console.log(`📡 Connected to: ${BOT_TOKEN.slice(0, 10)}...`)
// 暖機：帳密有問題重啟當下就能在 log 看到；失敗不影響啟動，之後依需求再登入
dbdClient.ready().catch(() => {})

startAdminServer(botDb, ADMIN_PORT)
console.log('✅ Bot is running. Press Ctrl+C to stop.')

process.on('SIGINT', () => {
  console.log('\n👋 Bot shutting down...')
  bot.stopPolling()
  process.exit(0)
})

process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Unhandled rejection:', reason)
})
