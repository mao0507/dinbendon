# DinBenDon Telegram Bot 🍱

訂便當系統的 Telegram Bot，讓你直接在 Telegram 完成訂餐。

## 功能

- 🔐 自動登入訂便當系統
- 📋 查看開放中的訂單列表
- 🍽️ 瀏覽菜單（支援翻頁）
- 🛒 加入購物車（可設定數量與備註）
- ✅ 一鍵送出訂單
- 🗑️ 清空購物車重新點餐

## 安裝

```bash
pnpm install
```

## 設定

1. 複製環境變數範本：
```bash
cp .env.example .env
```

2. 編輯 `.env`，填入 Telegram Bot Token：
```env
TELEGRAM_BOT_TOKEN=你的_bot_token
DINBENDON_USERNAME=dinbendon_username
DINBENDON_PASSWORD=dinbendon_password
```

3. 取得 Telegram Bot Token：
   - 在 Telegram 找 [@BotFather](https://t.me/BotFather)
   - 輸入 `/newbot` 建立新 bot
   - 複製取得的 token

## 啟動

**開發模式：**
```bash
pnpm run dev
```

**正式模式：**
```bash
pnpm run build
pnpm start
```

## 使用指令

| 指令 | 說明 |
|------|------|
| `/start` | 開始使用 |
| `/orders` | 查看開放中的訂單 |
| `/cart` | 查看目前購物車 |
| `/cancel` | 取消目前操作 |
| `/help` | 查看使用說明 |

## 點餐流程

```
/orders
  → 選擇訂單
    → 瀏覽菜單
      → 選擇品項
        → 選擇數量
          → 輸入備註（可略過）
            → 查看購物車
              → 確認送出
```

## 技術架構

- **Runtime**: Node.js + TypeScript
- **Bot Framework**: node-telegram-bot-api
- **HTTP Client**: axios + axios-cookiejar-support（處理 session cookie）
- **HTML Parser**: cheerio
- **目標網站**: DinBenDon (Apache Wicket 框架，session-based auth)

## 注意事項

- 網站使用 Apache Wicket 框架，表單含有動態 hidden fields
- 登入時需解數學驗證碼（bot 自動處理）
- Session 為全域共用（適合固定帳號使用情境）
- 如訂單送出失敗，請至網頁確認

## 專案結構

```
src/
├── index.ts        # Bot 主程式，所有 handler
├── dinbendon.ts    # 訂便當爬蟲 client
├── session.ts      # 使用者 session 管理
└── messages.ts     # 訊息格式化 & keyboard 產生
```
