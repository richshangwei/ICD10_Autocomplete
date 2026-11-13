# ICD-10-CM 診斷碼搜尋與自動完成

純前端、不需後端伺服器的 ICD-10-CM 診斷碼查詢工具。資料來自 CMS／CDC 官方公開檔案，收錄 FY2025 到 FY2027 共 5 個版本（含 4 月 1 日更新版），全部在瀏覽器本機搜尋，離線可用。

## 啟動方式

### 方法 A：直接開啟（最簡單）

1. 用檔案總管打開 `d:\WorkSpace\ICD10_Autocomplete`
2. 雙擊 `index.html`（建議用 Chrome 或 Edge；跨裝置同步只有這兩個瀏覽器支援）

### 方法 B：用本機伺服器開啟

```bash
cd d:\WorkSpace\ICD10_Autocomplete
python -m http.server 8765
```

然後在瀏覽器開啟 <http://127.0.0.1:8765/>。按 `Ctrl+C` 停止。

> 注意：我的最愛存在瀏覽器裡，而且「網址來源」不同就是不同的儲存空間。用方法 A 存的最愛，用方法 B 開啟時看不到（反之亦然）。請固定用同一種方式開啟，或用同步檔／匯出匯入搬移。

### 更新代碼資料

```bash
python scripts/build_data.py              # 重建全部版本
python scripts/build_data.py --only 2027  # 只重建一個版本
```

每年 10 月 1 日（或 4 月 1 日）有新版時，在 `scripts/build_data.py` 的 `VERSIONS` 加一筆（版本代號、生效日、CDC FTP 上的壓縮檔網址），再執行上面的指令。腳本只用 Python 標準函式庫，下載的原始檔放在 `data/raw/`，會重複使用。

### 執行測試

```bash
node --test tests/core.test.cjs tests/merge.test.cjs tests/abbreviations.test.cjs
```

## 功能

| 功能 | 說明 |
| --- | --- |
| 搜尋框 | 關鍵字、單一代碼（`E11.9`、`E119`、`E11` 前綴）、代碼範圍（`E08-E13`、`A00-B99`） |
| 關鍵字比對 | 同時比對代碼說明、官方 Alphabetic Index 與 External Cause Index、藥物表、腫瘤表。例如 `sugar` → E11.9、`high blood pressure` → I10；會跟著索引的「see」參見找代碼（`heart attack` → I21.9） |
| 拼字建議 | 拼錯時提示正確拼法（`diabetis` → diabetes） |
| 縮寫 | 自建約 170 個常見臨床縮寫（HCM、COPD、HTN、MRSA、OSA…，見 `js/abbreviations.js`），一個縮寫可對應多個意思；縮寫本身也會以完整單字比對（官方說明裡的 STEMI、NSTEMI 等）。測試會檢查每個展開詞都找得到官方代碼 |
| 自動完成 | 邊打邊出現代碼＋說明，經由索引找到的會附上索引路徑；`↑` `↓` 選取、`Enter` 開啟、`Esc` 關閉、`/` 聚焦搜尋框 |
| 排序 | 依字詞符合程度、官方索引的主要詞條、代碼層級；你常查看的代碼和最愛會排得比較前面 |
| 結果頁 | 分成「代碼」「官方索引」「藥物／腫瘤表」三個分頁；代碼可篩選可申報／不可申報、分頁 |
| 代碼詳細頁 | 代碼、說明、可申報狀態、上層與下層代碼、所屬章節、上一個／下一個代碼、第 7 位字元、官方註記（含上層繼承）、指向此代碼的索引詞條、版本異動標記 |
| 章節瀏覽 | 22 章 → 分節 → 類目 → 代碼 |
| 多版本 | 右上角切換版本，或在「版本異動」頁依日期（例如就診日）選版本；可查看相鄰版本之間新增、刪除、修訂、申報狀態變更的代碼 |
| 我的最愛＋筆記 | 存在瀏覽器；可篩選、編輯、匯出／匯入 JSON；首頁顯示最近查看 |
| 跨裝置同步 | 在「我的最愛」頁選一個放在 OneDrive／Google 雲端硬碟／Dropbox 資料夾的檔案，本頁自動讀寫並合併；另一台電腦選「連結既有同步檔」即可。刪除會留下刪除時間，舊副本不會把它加回來 |
| 介面 | 繁體中文／英文切換、手機與電腦皆可用、深色模式跟隨系統 |

## 資料來源與做法選擇

全部來自 CDC／NCHS 的 ICD-10-CM 官方發布檔（FY2027 的代碼檔來自 CMS），網址列在 `scripts/build_data.py`。

選擇下載官方資料集在本機搜尋，而不是即時呼叫 NLM API，原因是實測 NLM API 只收錄可申報代碼、沒有可申報旗標／章節／註記／索引、不支援代碼範圍，而且依賴外部網路。詳見 `docs/research-notes.md`。

## 專案結構

```
index.html              頁面骨架
css/styles.css          樣式（含手機版、深色模式）
js/core.js              資料模型與搜尋引擎（純邏輯，可在 Node 測試）
js/app.js               介面：版本、路由、自動完成、各頁面
js/i18n.js              中英文介面字串
js/merge.js             最愛的合併規則（純邏輯，可在 Node 測試）
js/store.js             我的最愛、筆記、使用紀錄（localStorage）
js/sync.js              同步檔讀寫（File System Access API）
data/versions.js        版本清單
data/changes.js         相鄰版本之間的代碼異動
data/icd10cm-<版本>.js  各版本資料（約 13.7 MB／版本，選用時才載入）
scripts/build_data.py   下載官方檔案並產生上述資料
tests/                  搜尋、階層、版本、合併規則的測試
docs/research-notes.md  用 REA 觀察 Codify 與 NLM API 的紀錄
```

## 已知限制

- 排序沒有使用「全國臨床使用頻率」資料，靠的是官方索引的主要詞條與你自己的使用紀錄。
- 跨裝置同步需要 Chrome 或 Edge 電腦版；Firefox、Safari 與手機瀏覽器只能用匯出／匯入。實際的雲端同步速度取決於你的雲端硬碟程式。
- 兩台電腦在雲端硬碟還沒同步完成前同時修改，雲端硬碟可能產生衝突副本（例如「icd10cm-favorites (1).json」），需要手動用「匯入 JSON」合併。
- 只收錄 FY2025 之後的版本；更早的版本可以照「更新代碼資料」的方式加入。
- 不含 CPT、HCPCS、ICD-10-PCS、代碼對照表（crosswalk）、帳號與付費功能。
- 本工具僅供查詢參考，不構成編碼或醫療建議。
