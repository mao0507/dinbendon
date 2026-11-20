# PM2 在 Windows 上的使用方式

## 安裝

```powershell
# 全域安裝 PM2
npm install -g pm2

# 安裝 Windows 開機自動啟動工具
npm install -g pm2-windows-startup
```

---

## 第一次啟動專案

```powershell
# 編譯後用 ecosystem.config.js 啟動
pnpm build
pm2 start ecosystem.config.js

# 儲存目前 process 清單（開機自動恢復用）
pm2 save
```

---

## 開機自動啟動設定（只需做一次）

`pm2 startup` 在 Windows 不支援，改用 `pm2-windows-startup`：

```powershell
node "C:\Program Files\nodejs\node_modules\pm2-windows-startup\index.js" install
pm2 save
```

> 設定完成後，Windows 登入時會自動執行 `pm2 resurrect` 恢復上次儲存的 process。

---

## 日常操作

```powershell
pm2 status                        # 查看所有 app 狀態
pm2 logs dinbendon-bot            # 即時 tail log
pm2 logs dinbendon-bot --lines 50 # 看最後 50 行
pm2 restart dinbendon-bot         # 重啟
pm2 stop dinbendon-bot            # 暫停（保留設定）
pm2 start dinbendon-bot           # 恢復
pm2 delete dinbendon-bot          # 完全移除（需重新 start）
```

### 更新程式碼後重啟

```powershell
pnpm build && pm2 restart dinbendon-bot
```

---

## Log 位置

| 檔案              | 內容      |
|------------------|-----------|
| `logs/out.log`   | stdout    |
| `logs/error.log` | stderr    |

```powershell
# 即時監看 log
pm2 logs dinbendon-bot

# 清除 log
pm2 flush dinbendon-bot
```

---

## 常見問題

### `pm2 startup` 報錯 `Init system not found`

Windows 不支援此指令，請改用上方「開機自動啟動設定」的方式。

### 重開機後 process 沒有自動恢復

確認兩件事：
1. 已執行過開機自動啟動設定
2. 啟動後有執行 `pm2 save`

### 查看 PM2 daemon 狀態

```powershell
pm2 ping        # 確認 daemon 是否在線
pm2 info dinbendon-bot  # 查看詳細資訊
```

### 手動恢復上次儲存的 process

```powershell
pm2 resurrect
```

---

## ecosystem.config.js 範例

```js
module.exports = {
  apps: [
    {
      name: 'dinbendon-bot',
      script: './dist/index.js',
      watch: false,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
}
```
