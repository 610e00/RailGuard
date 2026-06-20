# RailGuard AI — 啟動說明

## Demo 前必做（兩個終端）

### 終端 1：啟動 TDX Proxy
```bash
cd RailGuard-AI-v4
node server.js
```
看到以下訊息代表成功：
```
🚂 RailGuard AI Proxy 已啟動
   http://localhost:3000
```

### 終端 2：啟動前端
用 VS Code → 右鍵 index.html → Open with Live Server

---

## 完整 Demo 流程

1. 登入系統
2. 點「新增行程」
3. 選擇出發地 / 目的地 / 今天日期 / 時間
4. 按「建立監控行程」
5. 畫面顯示：
   - 「連線至交通部 TDX」→ Loading 動畫
   - 「查詢台鐵即時班表」
   - 「分析高鐵替代方案」
6. 顯示查詢結果（真實 TDX 資料）
7. 若有延誤 → 自動出現 AI 建議
8. 回首頁 → 「需要立即注意」自動出現該行程

---

## 風險判斷規則

| 延誤時間 | 風險等級 | 首頁顯示 |
|---------|---------|---------|
| 0 分鐘  | 🟢 正常 | 不顯示 |
| 1–15 分鐘 | 🟡 Warning | ✅ 出現在需要立即注意 |
| 16 分鐘以上 | 🔴 High | ✅ 出現在需要立即注意 |

---

## 資料來源
- 台鐵班表：交通部 TDX `/Rail/TRA/DailyTimetable`
- 台鐵即時延誤：交通部 TDX `/Rail/TRA/LiveBoard`
- 高鐵替代班次：交通部 TDX `/Rail/THSR/DailyTimetable`
