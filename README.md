# DinBenDon Telegram Bot 🍱

訂便當系統的 Telegram Bot，讓你直接在 Telegram 完成訂餐。

## 功能

- 🔐 自動登入訂便當系統（JWT 認證）
- 📋 查看開放中的訂單列表
- 🍽️ 依分類瀏覽菜單（支援多層：分類 → 品項 → 口味）
- ✅ 選完品項立即送出（無需購物車）
- 📋 查看訂單總覽（所有人已送出的品項）
- 🗑 取消已送出的品項
- 👤 多人同時使用，各自獨立 session

## 安裝

```bash
pnpm install
```

## 設定

建立 `.env.local`，填入以下變數：

```env
TELEGRAM_BOT_TOKEN=你的_bot_token
DINBENDON_USERNAME=dinbendon_帳號
DINBENDON_PASSWORD=dinbendon_密碼
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

## 使用指令

| 指令 | 說明 |
|------|------|
| `/start` | 開始使用 |
| `/orders` | 查看開放中的訂單 |
| `/cancel` | 取消目前操作 |
| `/help` | 查看使用說明 |

## 點餐流程

```
/orders → 選擇訂單
  → 選擇分類（套餐/蛋餅系列/...）
    → 選擇品項
      → 選擇口味（若有多種）
        → 選擇數量（1~5）
          → 輸入備註（或略過）
            → 輸入訂購人姓名
              → 立即送出 API
```

送出後回分類頁，可繼續點其他品項。

## 訂單總覽

分類頁按「📋 查看已送出訂單」可查看所有人已送出的品項與合計，並可取消自己的品項（標示 🔒 代表不可取消）。

## 技術架構

- **Runtime**: Node.js + TypeScript
- **Bot Framework**: node-telegram-bot-api
- **HTTP Client**: axios（JWT Bearer token 認證）
- **目標 API**: `https://dinbendon.net/mvc/api`（REST JSON API）

## 專案結構

```
src/
├── index.ts        # Bot 主程式，所有 Telegram handler
├── dinbendon.ts    # DinBenDon REST API client
├── session.ts      # 使用者 session（以 userId 隔離）
└── messages.ts     # 訊息格式化 & keyboard 產生
```

## 注意事項

- Session 存於記憶體，重啟後清空
- 多人使用時各自 session 獨立（群組也適用）
- 送出失敗時請至網頁確認
