# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## git commit
- git commit 訊息 請使用正體中文
- 必須要有 type (Prefix)，請參照類別規範
- 必須要有 subject
  - 不超過 50 個字元
  - 結尾不加句號
  - 盡量讓 Commit 單一化，一次只更動一個主題

### <type> 類別規範
* feat：新增或修改功能（feature）
* fix：修補 bug（bug fix）
* docs：文件（documentation）
* style：格式
* refactor：重構
* perf：改善效能（improves performance）
* test：增加測試（when adding missing tests）
* chore：maintain，不影響程式碼運行，建構程序或輔助工具的變動
* revert：撤銷回覆先前的 commit

## Commands

```bash
pnpm install          # install dependencies
pnpm dev              # run with ts-node (dev)
pnpm build            # compile to dist/
pnpm start            # run compiled dist/index.js
```

No test suite exists in this project.

## PM2

設定檔：`ecosystem.config.js`，app 名稱：`dinbendon-bot`。

### 日常操作

```bash
pnpm build && pm2 restart dinbendon-bot   # 更新程式碼後重啟
pm2 status                                # 查看所有 app 狀態
pm2 logs dinbendon-bot                    # 即時 tail log
pm2 logs dinbendon-bot --lines 50         # 看最後 50 行
pm2 stop dinbendon-bot                    # 暫停（不刪設定）
pm2 start dinbendon-bot                   # 恢復
pm2 restart dinbendon-bot                 # 重啟
pm2 reload dinbendon-bot                  # zero-downtime 重啟（cluster 模式）
pm2 delete dinbendon-bot                  # 完全移除（需重新 start）
```

### 第一次啟動

```bash
pnpm build
pm2 start ecosystem.config.js
```

### 開機自動啟動（做一次）

```bash
pm2 startup        # 照輸出的指令執行（通常需要 sudo）
pm2 save           # 儲存目前 process 清單
```

### Log 位置

```
logs/out.log       # stdout
logs/error.log     # stderr
```

## Environment

Credentials live in `.env.local` (not `.env`). Required vars:

```
TELEGRAM_BOT_TOKEN=
DINBENDON_USERNAME=
DINBENDON_PASSWORD=
```

Optional vars:

```
ADMIN_USER_ID=        # Telegram user ID granted admin commands
ADMIN_PORT=3000       # Express admin UI port (default 3000)
WHITELIST_ENABLED=true  # set to "false" to allow all users
```

`src/index.ts` loads `.env.local` via `dotenv.config({ path: '.env.local' })` at startup.

## Architecture

Single-process bot with SQLite persistence. No queue.

```
src/
├── index.ts       — Bot entry: registers all Telegram handlers, owns singletons
├── dinbendon.ts   — HTTP scraper client for dinbendon.net (Apache Wicket site)
├── session.ts     — Per-user state machine (Map<chatId, UserSession>)
├── messages.ts    — MarkdownV2 formatting + inline keyboard builders
├── database.ts    — BotDatabase: better-sqlite3 wrapper (users, submissions, settings)
└── admin.ts       — Express admin UI server (localhost only, port 3000)
```

SQLite DB is written to `data/bot.db` (created on first run).

### Data flow

1. `index.ts` owns one `DinBenDonClient`, one `SessionManager`, and one `BotDatabase`.
2. All Telegram messages/callbacks route through `index.ts` handlers.
3. `SessionManager.get(userId)` returns or creates a `UserSession` with a `BotStep` state machine.
4. `DinBenDonClient` holds a single cookie jar — login is global, not per-user.
5. On successful `submitItem`, `index.ts` diffs `fetchMyItems` before/after to record new `order_item_id`s in `BotDatabase`.

### DinBenDon scraper (`dinbendon.ts`)

- Target: `https://dinbendon.net/do` — Apache Wicket app (session-based, hidden form fields, math captcha on login)
- Login: one GET to fetch page → resolve form action with `new URL(action, sessionUrl)` → POST credentials + hidden fields
- All subsequent requests use the same `axios` instance with `tough-cookie` jar
- `submitItem` re-fetches the order page for fresh Wicket hidden fields before POSTing

### Session state machine (`BotStep`)

States: `idle → selecting_order → selecting_category → selecting_item → selecting_variation → entering_quantity → entering_note → entering_buyer_name`

`update(userId, partial)` mutates session in place — intentional exception to immutability rules because session is explicitly mutable state.

### Message formatting (`messages.ts`)

All text sent to Telegram uses `parse_mode: 'MarkdownV2'`. Every user-facing string must pass through `escapeMarkdown()` before interpolation. Keyboard builders return `{ text, callback_data }[][]` (rows of buttons).

### Callback data format

| Prefix | Meaning |
|--------|---------|
| `order:N` | select order at index N |
| `category:N` | select category at index N |
| `product:ID` | select product by id |
| `variation:ID` | select variation by id |
| `qty:N` | select quantity N |
| `my:order` | view submitted items for current order |
| `cancel:item:ID,ID,...` | cancel submitted order items by orderItemId |
| `back:cat` | navigate back to category list |
| `back:products` | navigate back to product list |
| `confirm:yes/no` | final order confirm |
| `note:skip` | skip note entry |
| `cancel` | cancel current flow |

### Admin

- Express server binds to `127.0.0.1` only (never exposed externally)
- REST API: `GET/POST /api/users`, `POST /api/users/:userId/authorize`, `POST /api/users/:userId/revoke`, `GET/POST /api/settings`, `GET /api/submissions`
- Static admin UI served from `public/`
- Telegram admin commands (`/add_user`, `/revoke_user`, `/users`) require `ADMIN_USER_ID` to be set

### Whitelist

When `whitelist_enabled = 1` in the `settings` table (default), only users with `authorized = 1` in `users` table can use the bot. `ADMIN_USER_ID` always bypasses the whitelist.
