# 財務詳細データ Gap Report / Phase 5.5 実装結果

## Phase 5.5 の到達点

Phase 5.5 では既存の `normalized_financial_facts` を置換せず、詳細科目専用の
`detailed_financial_facts` を追加した。元の concept、context、dimension、単位、
連結区分、会計基準、開示ID、訂正状態を保持し、`published_at <= as_of` で再現できる。

J-Quants `/fins/details` は標準化Primaryとしてアダプタを実装したが、検証時点の契約では
HTTP 403 で利用できなかった。このため保存済みの実データはEDINET XBRLを明示的な
フォールバックとして使用する。同一項目の複数ソース平均や値の混合は行わない。

## 現在の境界

Phase 5 の財務画面は `normalized_financial_facts` に保存済みの J-Quants `/fins/summary` 由来データだけを使用する。画面表示のために詳細科目を推測せず、欠損は `—`、金融業で定義上適用しない指標は `N/A` とする。

`cash_and_equivalents` は現在の正規化基盤へ取り込み済みだが、Phase 5 の財務Read Modelには含めていない。それ以外の下表の詳細科目は、現行の全銘柄正規化基盤には保存していない。

## Source mapping

| 項目 | 推奨取得元 | 現状 | 導入時の注意 |
|---|---|---|---|
| 現金及び現金同等物 | J-Quants財務サマリー | 保存済み | `CashEq`を計算で優先。EDINETは欠損補完・検算のみ |
| 売上債権、棚卸資産、流動資産 | J-Quants詳細財務 | EDINET fallbackを保存済み | 契約資産等を曖昧に合算せず、exact conceptを採用 |
| 有形・無形固定資産、のれん | J-Quants詳細財務 | EDINET fallbackを保存済み | 使用権資産をPPEへ暗黙合算しない |
| 流動負債、短期・長期借入、社債、リース負債、非支配持分 | J-Quants詳細財務 | EDINET fallbackを保存済み | 預金を通常企業の有利子負債として扱わない |
| 売上総利益、売上原価、販管費 | J-Quants詳細財務 | EDINET fallbackを保存済み | 企業独自タグは自動類推せず欠損を許容 |
| 減価償却費 | EDINET XBRL | 保存済み | 全社CFのD&Aを優先し、減損とセグメント値を除外 |
| 支払利息、税金費用、税引前利益 | J-Quants詳細財務 | EDINET fallbackを保存済み | 金融業の比較指標には流用しない |
| 有形・無形固定資産取得額 | EDINET XBRL | 保存済み | 売却額を相殺せず取得額を正値化して保持 |
| Capex | 自前計算 | 保存済み | 有形取得額 + 無形取得額。同一期間・scope・通貨のみ合算 |
| 有利子負債 | 自前計算 | 保存済み | 短期 + 長期 + 社債 + 個別開示リース。重複conceptは除外 |

## Metric definitions

| 指標 | 定義 | 欠損・適用外 |
|---|---|---|
| Net Debt | 有利子負債（個別開示リースを含む）− 現金同等物 | 負債fact欠損時はゼロと推測しない。金融業はN/A |
| EBITDA | LTM営業利益 + 同期間D&A | 同一期間・会計基準・連結区分・通貨が揃わなければ欠損 |
| 標準FCF | LTM営業CF − 同期間Capex | 簡易FCF（営業CF + 投資CF）とは別metric/version |
| EV | as-of時価総額 + Net Debt + 非支配持分 | 必須入力欠損時は欠損。金融業はN/A |
| EV/EBITDA | EV ÷ LTM EBITDA | EBITDAが非正の場合はN/M |
| FCF Yield | LTM標準FCF ÷ as-of時価総額 | 時価総額が非正または欠損なら欠損 |
| ROIC | NOPAT ÷ 平均投下資本。NOPATは営業利益×(1−税金費用/税引前利益)、投下資本は親会社持分+非支配持分+有利子負債−現金 | 前期末残高、正常な実効税率、全入力が揃う場合だけ計算。金融業はN/A |

全計算値は定義version、入力fact ID、source、対象期間、`as_of`を
`calculated_financial_metrics` に保持する。

## 検証取得率（6銘柄、直近2有報）

- 対象: 7203、7003、8306、4755、4502、7974
- 有報取得: 6/6、会計基準別はIFRS 3/3、J-GAAP 3/3
- 保存: 12文書、782 facts
- Cash / D&A / Capex / 非支配持分 / 税金費用 / 税引前利益: 6/6
- 有利子負債: 5/6、のれん: 4/6、個別開示リース負債: 2/6
- EBITDA / 標準FCF / FCF Yield: 非金融5/5
- Net Debt / EV / EV/EBITDA: 非金融4/5
- ROIC: 非金融2/5（赤字税引前利益または負債fact欠損は計算しない）
- 8306は金融業のため高度指標をすべてN/Aとした

最新6有報をEDINET APIから再取得し、保存済みfactとID、値、単位、連結区分を
全件照合した。対象値はすべてJPYで、桁膨張は検出されなかった。

## 残るGap

1. 現契約でJ-Quants詳細財務を利用できないため、全銘柄展開はEDINETのレート制限を守る再開可能バッチになる。
2. 企業独自extension tagだけで開示される科目はexact concept registryでは欠損する。自動的な名称推測は採用していない。
3. 負債が数値factとして存在しない場合、無借金と推測しない。このため7974のNet Debt/EVは未算出である。
4. IFRSのリース負債が他の借入金に内包され、個別開示されない場合は二重計上防止を優先する。
5. 金融複合企業は一般事業と金融子会社を連結で混ぜるため、通常企業向けEV系指標には追加の業種ポリシーが必要である。

## Phase 5.6 本番ユニバース結果

2026-08-24にアクティブ日本株4,604銘柄を対象として再開可能バッチを完走した。
EDINET対象は4,052銘柄、指定期間内の最新有報取得成功は3,831銘柄
（94.55%）、有報未検出は221銘柄だった。ETF・ファンド431、REIT 74、
優先株7、市場区分「その他」の非普通株商品40を取得対象外とし、金融業168銘柄は
factを保存したうえで通常企業向け高度指標だけを対象外とした。

- 保存量: 3,831銘柄、3,842文書、240,222 facts
- 入力取得率（保存銘柄比）: Cash 86.71%、Debt 76.77%、D&A 85.36%、
  Capex 80.61%、Goodwill 43.33%
- IFRS最新連結297銘柄: Cash 100%、Debt 91.58%、D&A 89.90%、
  Capex 90.91%、Goodwill 87.88%
- J-GAAP最新連結3,025銘柄: Cash 100%、Debt 88.23%、D&A 99.27%、
  Capex 93.16%、Goodwill 46.25%
- 高度指標（非金融の保存銘柄比）: Net Debt 89.22%、EBITDA 96.94%、
  標準FCF 93.07%、EV 45.02%、EV/EBITDA 42.37%、FCF Yield 87.99%、
  ROIC 37.43%
- 最終失敗: EDINET API 0件、XBRL解析0件、日付索引取得0件
- 完走パス: 8,417秒。3,474文書を解析し、362文書を再利用
- 詳細factテーブルと3索引の論理容量: 147.14 MiB
- DB本体の実測増加: 190.87 MiB。実行直後のWAL増加119.96 MiBは
  SQLiteの通常チェックポイント対象であり、VACUUMや強制削除は実施していない

### 取得不足の代表パターン

- Debt: 通常企業では借入金の集約値・短期/長期・社債・リースの開示粒度差が主因。
  `LeaseObligationsLiabilities` や企業拡張タグは、二重計上を避けるため自動合算しない。
  銀行固有の `BorrowingsFromOtherBanksBorrowedMoneyLiabilitiesBNK` は通常企業Debtへ
  読み替えない。
- Capex: `CapitalExpendituresOverviewOfCapitalExpendituresEtc` はTextBlockであり数値fact
  ではない。少数のIFRS企業は `CapitalExpendituresIFRS` や企業拡張の購入額タグだけを
  使用しており、exact mapping外では欠損を維持する。
- D&A: 主要な残存候補は販管費内減価償却、無形資産償却、減損込みの企業拡張タグ。
  全社CFのD&Aと意味が異なる値を代用・重複合算しない。
- Goodwill: J-GAAP企業は残高がない場合に残高factを開示せず、償却額や負ののれん益
  だけが存在することが多い。`GoodwillBeforeOffsetting` や取得原価は純残高へ代用しない。
- ROIC: Debt/Cashに加え、前期・当期の同一scope投下資本、正の税引前利益、正常な
  実効税率がすべて必要なため37.43%に留まる。欠損をゼロ補完して取得率を上げない。

### Phase 6での表示判断

- 安定して全体表示: EBITDA、標準FCF、FCF Yield、Net Debt。値がない銘柄は
  `missing`、金融業は`not_applicable`として理由を表示する。
- 一部銘柄のみ表示: EV、EV/EBITDA、Goodwill、詳細Debt/Capex/D&A。
  EV系は厳密なas-of時価総額入力が揃う銘柄だけに限定する。
- まだ主要比較指標にはしない: ROIC。現状は37.43%の検証可能銘柄だけ参考表示とし、
  ランキングや全体比較には使用しない。
