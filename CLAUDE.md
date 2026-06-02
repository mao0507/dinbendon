# CLAUDE.md

## git commit 
-  git commit 訊息 請使用正體中文
-  必須要有 type (Prefix) , 請參照類別規範
-  必須要有 subject 
   -  不超過 50 個字元
   -  結尾不加句號
   -  盡量讓 Commit 單一化，一次只更動一個主題

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

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install          # install dependencies
pnpm dev              # run with ts-node (dev)
pnpm build            # compile to dist/
pnpm start            # run compiled dist/index.js
```

No test suite exists in this project.

## Environment

Credentials live in `.env.local` (not `.env`). Required vars:

```
TELEGRAM_BOT_TOKEN=
DINBENDON_USERNAME=
DINBENDON_PASSWORD=
```

`src/index.ts` loads `.env.local` via `dotenv.config({ path: '.env.local' })` at startup.

## Architecture

Single-process bot — no database, no queue. All state is in-memory.

```
src/
├── index.ts       — Bot entry: registers all Telegram handlers, owns singletons
├── dinbendon.ts   — HTTP scraper client for dinbendon.net (Apache Wicket site)
├── session.ts     — Per-user state machine (Map<chatId, UserSession>)
└── messages.ts    — MarkdownV2 formatting + inline keyboard builders
```

### Data flow

1. `index.ts` owns one `DinBenDonClient` (shared across all users) and one `SessionManager`.
2. All Telegram messages/callbacks route through `index.ts` handlers.
3. `SessionManager.get(chatId)` returns or creates a `UserSession` with a `BotStep` state machine.
4. `DinBenDonClient` holds a single cookie jar — login is global, not per-user.

### DinBenDon scraper (`dinbendon.ts`)

- Target: `https://dinbendon.net/do` — Apache Wicket app (session-based, hidden form fields, math captcha on login)
- Login: one GET to fetch page → resolve form action with `new URL(action, sessionUrl)` → POST credentials + hidden fields
- All subsequent requests use the same `axios` instance with `tough-cookie` jar
- `submitOrder` re-fetches the order page for fresh Wicket hidden fields before POSTing

### Session state machine (`BotStep`)

States: `idle → selecting_order → viewing_menu → selecting_item → entering_quantity → entering_note → confirming`

`update(chatId, partial)` mutates session in place — note this is an intentional exception to immutability rules because session is explicitly mutable state.

### Message formatting (`messages.ts`)

All text sent to Telegram uses `parse_mode: 'MarkdownV2'`. Every user-facing string must pass through `escapeMarkdown()` before interpolation. Keyboard builders return `{ text, callback_data }[][]` (rows of buttons).

### Callback data format

| Prefix | Meaning |
|--------|---------|
| `order:N` | select order at index N |
| `item:ID` | select menu item by id |
| `qty:N` | select quantity N |
| `menu_page:N` | paginate menu to page N |
| `cart:*` | cart actions (view/confirm/clear/back) |
| `confirm:yes/no` | final order confirm |
| `note:skip` | skip note entry |
| `cancel` | cancel current flow |
