# CONTEXT

專案領域詞彙。架構討論與程式碼命名請用這些詞。

- **Order（訂單）**：dinbendon.net 上一筆開放中的團購，有店家、截止時間、發起人。
- **Order flow（點餐流程）**：使用者從選 Order 到送出品項的一連串步驟，對應 `BotStep` 狀態機。實作在 `src/order-flow/`，interface 為 `OrderFlow.handle(userId, input, ui)`。
- **Session（工作階段）**：每位使用者在點餐流程中的暫存狀態（目前步驟、已選 Order、待送出的品項）。只存記憶體，是 Order flow 的內部細節。
- **Submission（送出紀錄）**：Bot 成功送出的一個品項（`order_item_id`），記在 SQLite，用來辨識「我的品項」與取消。由 `src/submissions.ts` 的 `Submissions` module 負責 place / mine / cancel。
- **Ui（畫面 port）**：`OrderFlow` 輸出畫面的 seam；`ui.show(text, keyboard)`。Telegram 與測試各有一個 adapter。
- **Access（存取控制）**：判斷誰能使用 bot 的規則（白名單開關、管理員 bypass、使用者授權狀態），實作在 `src/access.ts`。授權資料本身存在 `BotDatabase`。
