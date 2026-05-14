# Purple GO

GitHub Pages 靜態頁面，會讀取指定 Google Sheet 內所有 Twitch 頻道連結，顯示開台狀態，點選開台中的頻道後會在下方載入直播與聊天室。不需要 Twitch Client ID、OAuth token 或 GitHub secrets。

## 資料來源

- Google Sheet：<https://docs.google.com/spreadsheets/d/1q9hW9idIngzQYkSDmkBT0fTOr1vsYjg58jRLrnJUX2M/edit?usp=sharing>
- 頁面端以 Google Visualization JSONP 讀取 Sheet，避免瀏覽器 CORS 擋住 CSV。
- 開台狀態使用 Twitch preview CDN 探測：開台頻道會回傳即時預覽圖，離線頻道會回傳固定佔位圖。

## 發布到 GitHub Pages

1. 建立 GitHub repository，將這個資料夾的檔案推上去。
2. 到 `Settings` -> `Pages`，將 `Build and deployment` 設為 `GitHub Actions`。
3. 手動執行一次 `Deploy Pages` workflow，之後 workflow 會約每 5 分鐘刷新一次 `data/live-status.json` 並部署頁面。

## 本機預覽

```powershell
python -m http.server 8080
```

開啟 <http://localhost:8080>。頁面會直接讀 Sheet 並用 Twitch 預覽圖確認開台狀態。

## 檔案

- `index.html`：頁面結構。
- `styles.css`：介面樣式。
- `app.js`：讀 Sheet、合併狀態、切換直播嵌入。
- `scripts/update-status.mjs`：GitHub Actions 用的 Twitch preview 狀態更新腳本。
- `.github/workflows/pages.yml`：GitHub Pages 部署 workflow。
