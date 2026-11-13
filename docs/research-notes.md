# 研究紀錄（2026-11-12，使用 REA 6.5.0）

工具：`rea capture-browser-scenario`（REA 內建 Playwright，驅動本機 Chrome 157 無頭模式），每次擷取畫面截圖、無障礙樹、網路請求。只觀察未登入狀態下看得到的公開頁面，沒有複製 AAPC 的內容或程式碼。

## Codify 代碼搜尋（https://www.aapc.com/codes/code-search/）

| 觀察項目 | 結果 |
| --- | --- |
| 頁面狀態 | 正常載入完成（不是載入中），搜尋框提示文字為 "Keyword(s), code(s), or code range with - between codes" |
| 自動完成 | **有**。每按一個鍵就送出一次 `GET /codes/spellingsuggestion/suggest/?chars=<輸入>`，沒有觀察到防抖 |
| 建議內容 | **詞彙補全，不是代碼**。輸入 `diabet` 得到 10 個字（diabete、diabetes、diabetic…），回應格式為 `[{id, data, thumbnail, description}]` |
| 鍵盤 | `↓` 會高亮第一個建議，`Enter` 送出搜尋 |
| 關鍵字結果 | 先依索引分組（CPT Index、ICD-10-CM Diseases and Injuries、HCPCS Index…），再列出 "Results from Codify"；左側有依索引、代碼類型、表格篩選的勾選框，另有排序下拉選單 |
| 單一代碼 | 輸入 `E11.9` 按 Enter 直接跳到代碼頁 `/codes/icd-10-codes/E11.9` |
| 代碼範圍 | 輸入 `E08-E13` 顯示可展開的類目樹，類目旁有「4th」圖示表示還需要第 4 碼 |
| 代碼頁 | 麵包屑、上一個／下一個代碼、Official Long Descriptor、Includes／Excludes1 |
| 範圍頁（/codes/icd-10-codes-range/） | 列出 22 章的代碼範圍連結 |

### 需要付費或登入的部分（未登入時看到的限制）

- 關鍵字結果中，"Results from Codify" 的代碼**沒有顯示說明**（只有「0403T -」）。
- 代碼頁出現 "Get the full picture on this code. Start a FREE 2-WEEK TRIAL" 廣告區塊。
- 代碼頁的 Crosswalks、Category Notes 顯示 "Unlock premium features"，按鈕為停用狀態。
- 個人筆記功能需要登入，未登入看不到，所以**無法觀察它的操作方式**。如需比照，請提供試用帳號的操作截圖。

## NLM Clinical Tables API（https://clinicaltables.nlm.nih.gov/api/icd10cm/v3/search）

| 查詢 | 結果 |
| --- | --- |
| `terms=diab`（未指定 sf） | 0 筆，預設只搜尋代碼欄位 |
| `sf=code,name&terms=E11.9` | 1 筆 |
| `sf=code,name&terms=E11` | 87 筆，全是可申報的末端代碼，沒有 E11 本身 |
| `sf=code,name&terms=diabetes kidney` | 10 筆，多字 AND 比對 |
| `sf=code,name&terms=E08-E13` | 0 筆，不支援範圍 |
| 回應標頭 | 有 `access-control-allow-origin`，瀏覽器可直接呼叫 |

結論：適合做單純的自動完成，但無法支援可申報標示、上下層代碼、章節瀏覽與範圍搜尋，因此改用官方資料集在本機搜尋。

## 本工具和 Codify 刻意不同的地方

- 自動完成直接建議**代碼＋說明**，而不是詞彙補全，選一個就能直接進代碼頁。
- 輸入停頓 60 ms 才搜尋，而且完全在本機執行，不會每個鍵都發網路請求。
- 官方 Tabular 註記（Includes、Excludes、第 7 位字元等）全部公開顯示，因為那是公有領域資料。
