# DinBenDon Telegram Bot 🍱

訂便當系統的 Telegram Bot，讓你直接在 Telegram 完成訂餐，並提供後台管理介面。

## 功能

- 🔐 自動登入訂便當系統（JWT 認證）
- 📋 查看開放中的訂單列表
- 🍽️ 依分類瀏覽菜單（分類 → 品項 → 口味）
- ✅ 選完品項立即送出
- 📋 查看訂單總覽（所有人品項）；取消按鈕僅顯示自己的品項
- 🗑 取消已送出的品項
- 👤 多人同時使用，各自獨立 session
- 🛡️ 使用者白名單管理（可透過環境變數關閉）
- 🖥️ Localhost 後台管理介面（用戶管理、訂單紀錄、白名單開關）

## 安裝

```bash
pnpm install
```

## 設定

建立 `.env.local`，填入以下變數：

```env
TELEGRAM_BOT_TOKEN=       # Telegram Bot Token（必填）
DINBENDON_USERNAME=       # dinbendon.net 帳號（必填）
DINBENDON_PASSWORD=       # dinbendon.net 密碼（必填）
ADMIN_USER_ID=            # 管理員的 Telegram user ID（可使用管理指令）
WHITELIST_ENABLED=        # true（預設）開啟白名單；false 關閉，任何人可使用
ADMIN_PORT=               # 後台 HTTP port（預設 3000）
```

取得 Telegram Bot Token：
- 在 Telegram 找 [@BotFather](https://t.me/BotFather)
- 輸入 `/newbot` 建立新 bot
- 複製取得的 token

## 啟動

**開發模式（nodemon 自動重啟）：**
```bash
pnpm dev
```

**正式模式：**
```bash
pnpm build
pnpm start
```

**PM2（正式部署，推薦）：**

第一次啟動：
```bash
pnpm build
pm2 start ecosystem.config.js
```

更新程式碼後重啟：
```bash
pnpm build && pm2 restart dinbendon-bot
```

開機自動啟動（設定一次）：
```bash
pm2 startup   # 照輸出的指令執行
pm2 save
```

常用 PM2 指令：

| 指令 | 說明 |
|------|------|
| `pm2 status` | 查看所有 app 狀態 |
| `pm2 logs dinbendon-bot` | 即時 tail log |
| `pm2 logs dinbendon-bot --lines 50` | 看最後 50 行 |
| `pm2 stop dinbendon-bot` | 暫停（保留設定） |
| `pm2 restart dinbendon-bot` | 重啟 |
| `pm2 delete dinbendon-bot` | 完全移除 |

Log 位置：`logs/out.log`（stdout）、`logs/error.log`（stderr）

## 使用指令

| 指令 | 說明 |
|------|------|
| `/start` | 開始使用，顯示授權狀態與 user ID |
| `/orders` | 查看開放中的訂單 |
| `/cancel` | 取消目前操作 |
| `/help` | 查看使用說明 |
| `/version` | 查看目前部署的 git commit hash |

**管理員指令（需設定 `ADMIN_USER_ID`）：**

| 指令 | 說明 |
|------|------|
| `/add_user <userId>` | 授權使用者 |
| `/revoke_user <userId>` | 撤銷使用者授權 |
| `/users` | 列出所有已記錄使用者 |

## 點餐流程

```
/orders → 選擇訂單
  → 選擇分類
    → 選擇品項
      → 選擇口味（若有多種）
        → 選擇數量（1~5）
          → 輸入備註（或略過）
            → 輸入訂購人姓名
              → 立即送出
```

送出後回分類頁，可繼續點其他品項。

## 訂單總覽

分類頁按「📋 查看已送出訂單」可查看所有人的品項與合計，取消按鈕只顯示自己送出的品項（🔒 代表不可取消）。

## 後台管理介面

啟動後開啟 `http://localhost:3000`（僅限 localhost）：

- **用戶管理**：查看所有使用者、授權 / 撤銷
- **訂單紀錄**：最近 200 筆送出記錄，含發起人、品項、訂購人、取消狀態
- **設定**：即時切換白名單開關

## 白名單機制

- `WHITELIST_ENABLED=true`（預設）：只有授權使用者可使用 Bot
- `WHITELIST_ENABLED=false`：任何人皆可使用（適合初始測試）
- 後台切換白名單後，設定寫入 SQLite，優先於環境變數

## 技術架構

- **Runtime**: Node.js + TypeScript
- **Bot Framework**: node-telegram-bot-api
- **HTTP Client**: axios（JWT Bearer token，auto-refresh）
- **資料庫**: better-sqlite3（WAL mode，使用者授權 + 訂單紀錄）
- **後台**: Express 5（僅 127.0.0.1）
- **目標 API**: `https://dinbendon.net/mvc/api`

## 專案結構

```
src/
├── index.ts        # Bot 主程式，所有 Telegram handler
├── dinbendon.ts    # DinBenDon REST API client
├── session.ts      # 使用者 session 狀態機（userId 隔離）
├── database.ts     # SQLite：使用者白名單 + 訂單追蹤
├── admin.ts        # Express 後台 HTTP server
└── messages.ts     # MarkdownV2 格式化 & inline keyboard

public/
└── index.html      # 後台管理 SPA

data/
└── bot.db          # SQLite 資料檔（runtime 建立，gitignored）
```

## 注意事項

- Session 存於記憶體，重啟後清空（不影響訂單記錄）
- 多人使用時各自 session 獨立
- 送出失敗時請至網頁確認
