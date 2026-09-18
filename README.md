# MS-Style Chart（public-data edition）

MarketSmith風の株価チャート＋評価パネルを、公開データだけで毎朝自動更新するアプリです。

- 表示: `index.html`（シングルファイル。GitHub Pages で公開、スマホからも閲覧可）
- 取得: `scripts/fetch.js`（GitHub Actions が毎朝 07:30 JST に実行 → `data/*.json` を更新 → commit）
- データ元
  - 株価: Stooq（キー不要）→ 失敗時 Yahoo Finance chart API（非公式）→ 失敗時 Twelve Data（`TWELVE_DATA_KEY` を設定した場合のみ）
  - 財務（希薄化後EPS）: SEC EDGAR companyfacts API
  - 決算発表日: SEC EDGAR submissions API の 8-K Item 2.02（提出時刻で反応日を判定）
  - インサイダー売買: SEC EDGAR Form 4（XML を解析、コードP=市場買付 / S=売却）
  - マクロ: FRED（DGS10, DGS2）、Cboe（VIX）

> 画面の「近似」表示（RS・EPS成長・A/D・総合スコア・ベース検出）は IBD の公式値ではなく本アプリ独自の計算です。バリュエーション帯・下落深さ・決算反応も「参考ゾーン」であり売買推奨ではありません。

---

## 初回セットアップ（約10分）

1. **リポジトリ作成**: GitHub で新規リポジトリ（Public）を作成し、このフォルダの中身をすべてアップロード（`git push` でも Web の「Upload files」でも可）。`.github/` と `.nojekyll` の隠しファイルも含めてください。
2. **Secrets 設定**: リポジトリの `Settings → Secrets and variables → Actions → New repository secret`
   - `SEC_USER_AGENT`（必須）: SEC の利用規約に沿って `氏名またはアプリ名 メールアドレス` の形式。例: `ms-style-chart yourname@example.com`
   - `TWELVE_DATA_KEY`（任意）: Stooq / Yahoo が両方失敗したときの予備。
3. **Actions を有効化**: `Actions` タブ → 「I understand my workflows, go ahead and enable them」→ 左の `Update market data` → `Run workflow` で初回実行。5〜10分で `data/` が更新されます（初回は Form 4 の取得が多いため長め）。
4. **Pages を有効化**: `Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: main / (root)` → Save。
5. 数分後 `https://<ユーザー名>.github.io/<リポジトリ名>/` を開く。右上に「データ更新: 日時」と表示されれば成功です（「（モック）」と付いていればまだ初回取得前）。

以後は毎朝自動で更新されます。手動更新は `Actions → Update market data → Run workflow`。

### 注意（GitHub の仕様）
- 無料プランの Pages は **Public リポジトリのみ**。ウォッチリストと `data/` の内容は誰でも閲覧できます。
- リポジトリに **60日間コミットが無いとスケジュール実行が自動停止**します（本ワークフローは毎日 `data/` をコミットするので通常は該当しません。停止した場合は Actions タブで再有効化）。
- スケジュールは UTC 指定（`30 22 * * 1-5` = 07:30 JST 火〜土）。

---

## TradingView CSV の取込（ローカルのみ）

画面右上の **「TV取込」** から、TradingView の「チャートデータをエクスポート」で保存した CSV をドラッグ＆ドロップします。

- 保存先は **そのブラウザの IndexedDB だけ**。GitHub にも外部にも送信されません（公開リポジトリに有料データを置かないための設計）。端末・ブラウザごとに取り込みが必要です。
- ファイル名 `BATS_AVGO, 1D_xxxx.csv` から銘柄と足を自動判定します（判定できない場合は銘柄欄に入力）。
- 株価: 重複する日付は TradingView の値で上書き（設定でオフ可）。自動取得の株価と調整方法（分割・配当）が違う場合、境目に段差が出ることがあります。
- インジケーター列: 株価スケールに近い列（EMA/MA 等）は「TV:〜」チップでオーバーレイ、それ以外（RSI/MACD 等）は下段セレクトに「TV: 〜」として追加されます。列名が `MACD` のときは `Signal`/`Histogram` 列も一緒に描画します。
- 推定値列（`EPS Estimate FQ/FY`, `Revenue Estimate FQ/FY` など「Estimate」を含む列）: 最終行の値を **取込のたびに日付付きスナップショット** として記録し、前回取込との差（＝コンセンサス修正の方向）を評価パネルに表示します。CSV 内では四半期境界でしか値が変わらないため、日次の修正を追うには定期的に（例: 週1回）取り込んでください。

## 底値参考ゾーン・急騰の過去発生率（評価パネル）

どちらも **予測モデルではなく、手元データの「過去の物差し」を並べたもの** です。

- **底値 参考ゾーン**: PER下位分位×TTM EPS、過去の下落幅（中央値/75%/最大）を直近高値に当てた水準、200日/50日線、直近ベース安値、52週安値、インサイダー買付の平均単価、週足下ヒゲ帯を価格順に列挙し、±3%以内に2件以上重なる帯を「厚い」帯として表示（チャートの「底値帯」トグルで描画）。
- **急騰の過去発生率**: 現在の RSI / 高値からの下落率 / 200日線乖離 / 出来高比 / RS線20日変化 に近い過去の日を抽出（幅はスライダーで調整）し、その後20/60営業日で +10%/+20% に到達した割合とリターン分布を、銘柄単独とウォッチリスト全体のプールで表示。n（エピソード数）が30未満は赤字＝参考にならない。さらに、各過去時点で「それ以前のデータだけ」で同じ計算をした場合の的中度（ウォークフォワード、Brierスキル）を併記し、条件付けが無条件より当たっていないときに分かるようにしています。
- 表示は「発生率」であって「確率」ではありません。分布が将来も続く保証はなく、件数も少ないため、判断材料の一つとして扱ってください。

## 銘柄の変更

`config.json` を編集して commit するだけです。

```json
{
  "symbols": ["AVGO", "NVDA", "GOOG", "FCX", "MU", "MSFT", "CIEN", "QQQ", "GLD", "TLT"],
  "bench": "SPY",
  "secSkip": ["QQQ", "GLD", "TLT"],
  "cikOverrides": {},
  "insiderMonths": 12,
  "form4MaxPerRun": 120,
  "peYears": 5,
  "keepBars": 2600
}
```

- `secSkip`: ETF など SEC の EPS / Form 4 が無い銘柄。
- `cikOverrides`: ティッカー→CIK の自動解決が失敗する場合に `{"BRK.B": 1067983}` のように指定。
- `form4MaxPerRun`: 1回の実行で新規に読む Form 4 の上限（SEC への負荷配慮。残りは翌日以降に取得）。

---

## ローカルでの確認

```bash
npm test                # パーサ・分析ロジックの単体テスト（ネットワーク不要）
node scripts/mock-data.js   # 合成データで data/ を生成（UI確認用）
node scripts/fetch.js       # 実データ取得（SEC_USER_AGENT 環境変数を設定してください）
npx serve .             # または任意の静的サーバーで index.html を開く
```

`index.html` をファイルとして直接開いた場合は `data/` を読めない（ブラウザの制約）ため、設定画面で「API直接（Twelve Data）」モードになります。

---

## データ仕様（`data/<SYM>.json`）

| キー | 内容 |
|---|---|
| `bars` | `[日付, 始値, 高値, 安値, 終値, 出来高]` の配列（最大 `keepBars` 本） |
| `priceSource` | `stooq` / `yahoo` / `twelvedata` |
| `drawdown` | 現在の高値からの下落率、過去の10%以上の下落局面一覧と分位 |
| `sec.qeps` | 四半期EPS（分割調整済み、`filed` は初回開示日、`derived: true` は 年次 − 3四半期 で導出したQ4） |
| `sec.ttm` | TTM EPS 系列（`filed` = その値が公開された日） |
| `sec.peBand` | 過去 `peYears` 年の PER 分位（10/25/50/75/90%）と、現在TTM EPS × 分位 の株価帯。`excludedNegative` / `excludedTrough` は分布から外した営業日数、`spread` は 90%点÷10%点、`suspect` が true なら信頼できない |
| `splits` | 適用した株式分割 `[{date, ratio}]` |
| `sec.earnings` | 8-K Item 2.02 ごとの反応日・ギャップ・終値変化・5営業日後 |
| `sec.insiders` | Form 4 集計（買付件数/金額、買い手一覧、売却合計） |
| `errors` | 取得時のエラー（画面右パネル末尾にも表示） |

`data/cache/form4/<SYM>.json` は解析済み Form 4 のキャッシュです（削除すると再取得）。

---

## 既知の制約・推測を含む点

- Stooq は自動アクセスを拒否することがあります（"Access denied" / 日次上限）。その場合は Yahoo → Twelve Data の順で自動フォールバックし、`priceSource` で判別できます。Yahoo の chart API は非公式で、予告なく変わる可能性があります。
- 次回決算日は SEC からは取得できないため「前回反応日 + 91日」の推定です。
- PER 帯は「実績 TTM EPS」ベースです。将来 EPS（コンセンサス）は無料で安定取得できる公式ソースが無いため扱っていません。
- **株式分割**: SEC の EPS ファクトは提出当時の値で保存され、分割後に遡って調整されるのは「その後に提出された期」だけです（例: AVGO の 2023-01-29 期は 10:1 分割後も 8.80 のまま、2023-07-30 期は 0.77 に改訂）。混在させると TTM が壊れるため、Yahoo から分割履歴を取得し、各値をその値が載った提出日より後の分割で割って現在の株数基準に揃えています。分割履歴が取れなかった場合は PER 分布を出さず、その旨を表示します。
- **EPS の日付**: 各四半期は「最初に開示された日」で時系列に載せます（後年の 10-K による再掲で日付が後ろにずれると、古い EPS が長期間使われ続けてしまうため）。値そのものは最新の改訂値を使います。
- **PER 分布の除外**: 赤字期と、TTM EPS が同期間の中央値の 35% 未満まで落ちた減益期は分布から外します（分母がゼロに近づくと PER が発散して上位分位を支配するため）。除外日数は画面に表示されます。分布幅（90%点÷10%点）が 10 倍を超えた場合は「分割調整もれの可能性」として警告を出します。
- **場中の未確定バー**: 米国市場の引け（16:00 ET）前に実行した場合、最終バーは当日の途中経過なので自動的に捨てます。定時実行は 18:30 ET なので通常は影響しません。
- Form 4 の "P" は市場買付ですが、10b5-1 計画に基づく買付や、役員以外（10%株主）の買付も含みます。買い手の役職を併記しているので確認してください。

ライセンス: MIT（同梱の TradingView Lightweight Charts™ は Apache-2.0。画面フッターに帰属表示あり）
