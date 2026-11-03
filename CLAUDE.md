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
pnpm test             # node:test via ts-node (src/**/*.test.ts)
```

測試：`src/order-flow/order-flow.test.ts`（假 `DinBenDonClient`、記錄呼叫的 `Ui`、`:memory:` SQLite 跑完整點餐流程、送出失敗重試、防重送）與 `src/submissions.test.ts`（place / mine / cancel）。

> `better-sqlite3` 的 native binding 若缺（`Could not locate the bindings file`），在該套件目錄執行 `prebuild-install` 即可。

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
ADMIN_USER_ID=        # Telegram user ID granted admin commands（必須是整數，格式錯誤時啟動即退出）
ADMIN_PORT=3000       # Express admin UI port (default 3000)
WHITELIST_ENABLED=true  # set to "false" to allow all users
```

`src/index.ts` loads `.env.local` via `dotenv.config({ path: '.env.local' })` at startup.

## Architecture

Single-process bot with SQLite persistence. No queue.

```
src/
├── index.ts       — Telegram adapter: registers handlers, auth/login, owns singletons
├── access.ts      — Access: isAdmin / isAllowed（白名單開關 + 管理員 bypass + 授權狀態）
├── submissions.ts — Submissions: place / mine / cancel 品項，維護 order_item_id 歸屬（依賴 client + db）
├── dinbendon.ts   — axios client for dinbendon.net JSON API (bearer token, auto re-login on 401)
├── order-flow/    — 點餐流程 module（唯一對外入口 index.ts）
│   ├── index.ts       — OrderFlow.handle(userId, input, ui)、送單邏輯
│   ├── session.ts     — Per-user state machine (Map<userId, UserSession>)，module 內部
│   ├── messages.ts    — MarkdownV2 formatting + inline keyboard builders，module 內部
│   └── callbacks.ts   — callback_data 編碼 (`cb`) 與解碼 (`decodeCallback`)
├── database.ts    — BotDatabase: better-sqlite3 wrapper (users, submissions, settings)
└── admin.ts       — Express admin UI server (localhost only, port 3000)
```

SQLite DB is written to `data/bot.db` (created on first run).

### Data flow

1. `index.ts` owns one `DinBenDonClient`, one `BotDatabase`, one `Submissions({ client, db })`, and one `OrderFlow({ client, submissions })`.
2. `index.ts` 透過 `Access` 判斷放行（`ensureAuth`、`requireAdmin`），並處理 `/help`, `/version`, admin commands. 點餐相關輸入一律轉成 `FlowInput`（`callback` / `text` / `command: orders|cancel|reset`）交給 `OrderFlow.handle(userId, input, ui)`。
3. `ui` 是 Telegram adapter（`makeUi`）：`ui.show(text, keyboard)` 第一次呼叫對 callback 是編輯按鈕所在訊息、對 command/text 是新送一則，之後都編輯同一則。
4. `DinBenDonClient` holds a single bearer token — login is global, not per-user.
5. 送單走 `Submissions.place`（不丟例外，失敗回 `{ ok:false, reason }`）：
   - 送出前先快照 `fetchMyItems`，快照失敗就中止；
   - 送出後 diff 新增 id，且只記 `buyerName` 等於輸入姓名的品項（姓名對不上時退回全部新增 id 並 `console.warn`）；
   - `cancel` 只取消 DB 中屬於該使用者的 id。
6. 送出期間 session step 為 `submitting`（防重送）；失敗時回 `entering_buyer_name` 並保留 `pendingItem`，可直接重打姓名。

### DinBenDon client (`dinbendon.ts`)

- Target: JSON REST API (`API_BASE` in `dinbendon.ts`), not HTML scraping. Auth = `Bearer` token from `POST /auth/login`.
- `new DinBenDonClient({ username, password })`：帳密在建構時傳入；**延遲登入**，每個 `fetch*`／`submitItem`／`cancelItem` 開頭 `await this.ready()`，並發呼叫共用同一次登入（single-flight）。`index.ts` 啟動時只做暖機 `ready().catch(...)`。
- Axios request interceptor attaches token; response interceptor adopts rotated token from `x-dbd-new-token` header.
- On 401：所有並發的 401 共用同一次重登（`reauth()`），完成後各自重試原請求一次（`_retried`）；若請求送出後 token 已被換新則直接重試不再登入。
- 登入失敗丟 `LoginError`：`message` 是給使用者看的固定文字（請稍後再試／聯絡管理員），網站原始錯誤在 `detail` 並寫 log。失敗後 30 秒（`cooldownMs`）內不再打登入端點，直接丟同一個 `LoginError`。
- Login is global (one token for the whole bot), not per Telegram user.
- 測試：`src/dinbendon.test.ts` 以 axios `adapter` 選項注入假 HTTP（`DinBenDonClientOptions.adapter`）。
- Endpoints: `/order/progress`, `/order/:id/get-add-item`, `/order/:id/add-item`, `/order/:hash/product-group-for-buyer`, `/order/:hash/cancel-item`.

### Session state machine (`BotStep`, `order-flow/session.ts`)

States: `idle → selecting_order → selecting_category → selecting_item → selecting_variation → entering_quantity → entering_note → entering_buyer_name`

`update(userId, partial)` mutates session in place — intentional exception to immutability rules because session is explicitly mutable state.

### Message formatting (`order-flow/messages.ts`)

All text sent to Telegram uses `parse_mode: 'MarkdownV2'`. Every user-facing string must pass through `escapeMarkdown()` before interpolation. Keyboard builders return `{ text, callback_data }[][]` (rows of buttons).

### Callback data format (`order-flow/callbacks.ts`)

編碼 (`cb.*`) 與解碼 (`decodeCallback`) 同檔，改格式只改這裡。

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
- REST API: `GET/POST /api/users`, `POST /api/users/:userId/authorize`, `POST /api/users/:userId/revoke`, `GET/POST /api/settings`, `GET /api/submissions`, `GET /api/status` (uptime, memory, SQLite info, `pm2 jlist` for `dinbendon-bot`)
- Static admin UI served from `public/`
- Telegram admin commands (`/add_user`, `/revoke_user`, `/users`) require `ADMIN_USER_ID` to be set
- `/version` replies with `git rev-parse --short=7 HEAD` (runs in `__dirname`, i.e. `dist/`)

### Whitelist

規則集中在 `src/access.ts` 的 `Access.isAllowed`：whitelist 關閉 → 放行；`ADMIN_USER_ID` → 放行；否則看 `users.authorized`。When `whitelist_enabled = 1` in the `settings` table (default), only users with `authorized = 1` in `users` table can use the bot. `ADMIN_USER_ID` always bypasses the whitelist.授權／撤銷／列表仍在 `BotDatabase`，Express 後台與 Telegram 管理指令直接呼叫它。
