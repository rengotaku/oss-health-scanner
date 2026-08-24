# OSS Repository Health Scanner

GitHub の Repository URL を1つ入れると、その OSS が **いま健全に維持されているように見えるか**
を、収集した数値と欠損状況ごと提示する。仕様は `oss_repository_health_scanner_spec_v0.1.md`
の v0.1（MVP）に対応する。

- 入力は GitHub Repository URL のみ
- LLM は使わない
- 全 GitHub の Crawler は持たない（アクセスをトリガーにしたオンデマンド解析）
- Repository 単位でキャッシュする

## アーキテクチャ

Cloudflare Workers 上の Next.js（`@opennextjs/cloudflare`）で、フロントと API を同一リポジトリに置く。

```
Browser
   │
   ▼
Next.js on Cloudflare Workers
   ├── D1        repositories / analyses / metrics / rate limit / counters
   ├── Cache API 外部 API レスポンスのソース別 TTL
   ├── GitHub REST API   （現在値の source of truth）
   ├── ecosyste.ms       （commit / Issue / PR 履歴の集約。Contributor 指標の主ソース）
   ├── OpenSSF Scorecard （セキュリティ開発プロセス評価）
   └── deps.dev          （Package 対応が高信頼で特定できる場合のみ）
```

Redis と Postgres は使わない。仕様書 §31 が Redis に割り当てていた 4 つの役割は、
Cloudflare 上では次に対応する。

| 役割 | 実装 | 理由 |
|---|---|---|
| Analysis lock / dedupe（§17.3） | D1 の条件付き `UPDATE` + 期限付き lock | D1 は単一プライマリで強整合なので `meta.changes === 1` が真の compare-and-set になる。Durable Object を持ち込まずに同一 Repository の重複解析を1本化できる |
| Self rate limit（§21.1） | D1 の IP × 時間バケットのカウンタ | 結果整合の KV では計数がズレて上限を超える |
| 外部 API レスポンス cache（§18.1） | Cache API（`cf.cacheTtl`）+ D1 の analysis TTL | ソース別 TTL をそのまま表現できる |
| Health 解析の後段実行（§17.1） | `ctx.waitUntil()` | Basic を先に返してから詳細を続ける形が素直に書ける |

D1 は SQLite なので、仕様書 §24 のデータモデルがそのまま `migrations/0001_init.sql` に載る。
ローカル開発も miniflare 経由で同じ D1 を使うため、ローカルと production で SQL の挙動が分かれない。

## セットアップ

```bash
make install
make types            # cloudflare-env.d.ts を生成
make migrate          # ローカル D1 にマイグレーション適用
make dev-vars         # pass から .dev.vars を生成（GITHUB_TOKEN）
make run              # http://localhost:3210
```

`GITHUB_TOKEN` は public repository のデータ取得に scope 不要の PAT でよい。
**未認証の GitHub REST は 60 req/hour しかなく、このサービスは成立しない**（§20.1）ため、
トークンが無い場合は解析を実行せず `TOKEN_MISSING` を返す（黙って未認証で叩かない）。

秘密は `pass` に置き、`make dev-vars` が実行時に `.dev.vars`（gitignore 済み）へ書き出す。
`make clean-secrets` で消える。production では `wrangler secret put GITHUB_TOKEN`。

### ローカル開発の注意点（実測で踏んだもの）

- **dev サーバ稼働中に `wrangler d1 execute --local` を実行しない**。同じ SQLite に別プロセスから
  書いても dev サーバ側に反映されず、消したはずのキャッシュが生き続ける。状態をリセットするなら
  サーバを止めて `rm -rf .wrangler/state && make migrate`
- **health stage（`ctx.waitUntil` 側）の `console` 出力は `next dev` の stdout に出ない**。
  どのソースがどう失敗したかは `GET /api/v1/repos/{owner}/{repo}` の `diagnostics` を見る
  （ソース別に `ok` / `empty` / `pending` / `too_large` / `error` を記録している）

### 画面だけ確認したいとき

GitHub の quota を使わずにレポート画面を見るためのローカル fixture がある。

```bash
make seed             # ローカル D1 に完成済み analysis を1件入れる
make run
open http://localhost:3210/repo/ggerganov/llama.cpp
make shots            # sm / md / lg × light / dark のスクリーンショット
```

fixture は cache hit として返るため、トークン無しでも API ルートから DB、描画まで実物が動く。

## 検証

```bash
make ci               # typecheck → lint → test → build
```

`make test` だけでは JSX の型が通らないので、`make build`（`next build` の型チェック）まで
含めて緑にする。

## デプロイ

```bash
npx wrangler d1 create oss-health          # database_id を wrangler.jsonc に反映
make migrate-remote
npx wrangler secret put GITHUB_TOKEN
make deploy
```

## 設計上の判断

数値の出し方について、仕様書から引き継いだ判断のうち実装上重要なもの。

**欠損は 0 点にしない（§9.3 / §27）**
OpenSSF が未スキャンの Repository は「セキュリティ検査に落ちた」わけではない。
欠損したカテゴリは除外して残りの weight を再正規化し、Score とは別に coverage を出す。
`86点 / データ95%` と `86点 / データ45%` を同じ信頼度に見せない。

**Contributor 数は Raw だけでは見ない（§6）**
Raw / Active(90d) / Repeat(365d) / Effective / Core Maintainer を並列に出す。
Effective Contributor は「直近1年に継続的な Contribution があり、Bot でも明示 AI Agent でもない」
人数で、コミュニティの実効的な厚みを表す。

**AI 利用は推測しない（§7.4）**
分類は `HUMAN_OR_UNKNOWN` / `BOT` / `KNOWN_AI_AGENT` の3つで、後者2つは
GitHub の account type・`[bot]` サフィックス・既知 Agent アカウントという高信頼シグナルのみ。
人間名義のアカウントが AI でコードを生成していても `HUMAN_OR_UNKNOWN` のままにする。
Agent 比率そのものを減点にはせず、「実効の人間 Contributor が少なく既知 Agent の比重が高い」
場合にのみ resilience の signal として出す（§7.5）。

**集中度の分母から自動化を除く（§8.2）**
Bot と Agent の commit を分母・分子の両方から外す。除かないと、Dependabot の大量 commit で
maintainer 集中が薄まって見える。

**Release は「最新から何日」で測らない（§13.2）**
月次 Release の OSS と年1 Release の OSS を同じ基準で測れないため、その Repository 自身の
Release 間隔の中央値に対する経過倍率で評価する。Release を使っていないこと自体は減点しない。

**低活動を「死んだ OSS」と断定しない（§15）**
Score とは別に `ACTIVE` / `LOW_CHANGE` / `STALE` / `ARCHIVED` / `INDETERMINATE` を付ける。
1年以上動きが無い場合でも、Release と Issue/PR の両方が止まっていることを確認できるまで
`STALE` にしない。`Dead` / `Abandoned` / `Unsafe` は自動判定では出さない。

**deps.dev は対応が確定するときだけ使う（§3.2）**
1 Repository = 1 Package とは限らない（monorepo、複数 package、Registry 未公開、名前の不一致）。
deps.dev が単一の package identity を返すときだけ表示し、それ以外は
`Package security data: unavailable` にする。誤った Package の脆弱性を出す方が危険なため。

**Contributor 指標の主ソースは GitHub ではなく ecosyste.ms**

仕様書 §20.3 は GitHub の `stats/contributors` を 1〜4 リクエストの主力として設計しているが、
実測（2026-08-20）でその前提が成立しないことが分かった。

| Repository | `stats/contributors` |
|---|---|
| chalk/ansi-styles | 数十 KB（利用可能） |
| vitejs/vite | 3.1 MB |
| kubernetes/kubernetes | 29 MB |
| curl/curl | 24.8 MB（gzip 展開後） |
| torvalds/linux | 71 MB |
| curl/curl・facebook/react 等 | `202 Accepted` が 8 秒の予算内で解消しないことがある |

Worker は isolate メモリ 128 MB と CPU 時間の制約があり、この規模は parse できない。加えて
`content-length` はレスポンスが gzip かつ chunked のため **null** で、ヘッダによるサイズ判定は
機能しない（デコード済みバイト数をストリームで数える必要がある）。

そこで **`commits.ecosyste.ms` の集約値を Contributor 指標の主ソース**にし、GitHub の週次統計は
「安価に読めたときだけ使う高精度版」に降格した。ecosyste.ms はリポジトリ規模に依らず数百 KB で、
`past_year_committers[]`（login + commit 数）・bot 判定・DDS を返す。これは仕様書 §3.1 / §20.3 が
ecosyste.ms に与えている役割（GitHub の全履歴 Pagination を避ける履歴集約）を commit へ広げたもの。

代償として、ecosyste.ms 経路では **90日窓と Contributor ごとの活動週が取得できない**。これらは
0 ではなく N/A として表示し、Core Maintainer は「Commit 数のみで判定」と明示する。
どちらのソースを使ったかは `contributor_metrics.source` に保存する。

**Raw Contributor は GitHub 単体では正しく出ない**

`stats/contributors` は上位 100 人で打ち切られる。実測で 30 リポジトリ中 8 件が
「ちょうど 100」を返し（vuejs/core・tokio・flask・requests・express・lodash・jquery・moment）、
ecosyste.ms の実数（curl 1,516 / rust-lang/rust 7,723）と混在すると比較不能になる。
そのため Raw Contributor は ecosyste.ms の総数が取れる場合は必ずそちらを使う。

**OpenSSF の `-1` は低評価ではない（判定不能）**

Scorecard は判定できなかった check を `-1` で返す。これを低スコアとして扱うと、評価されて
いない項目を「Weak」と報告してしまう（curl/curl の Branch-Protection・CI-Tests・Packaging が該当）。
`-1` は null に正規化し、N/A として表示する。欠損を 0 点にしないという §9.3 の原則と同じ扱い。

**GitHub の呼び出し回数を予算として強制する（§20.3）**
1 Repository あたり typical 8 / hard cap 12。cap は `GithubClient` 側で強制していて、
超えると例外になる（後から集計するだけでは、ページネーションの事故が静かに quota を食う）。
Contributor 指標を ecosyste.ms（GitHub の quota を消費しない）に寄せているため、GitHub への
呼び出しは repository metadata / releases / commit_activity / contributor statistics の 4 系統に
収まる。実測は 6.4 requests / uncached analysis。`GET /api/v1/metrics` で
`github_requests_per_analysis` を確認できる。

## キャリブレーション（Risk 1 / 2 / 6 / 7）

有名 OSS 30 件を実解析した結果は `dev/calibrate.mjs` で再現できる（`make run` 後に
`node dev/calibrate.mjs --out out.json`）。2026-08-20 時点の実測:

- **GitHub API 呼び出し数 = 6.4 requests / uncached analysis**。§20.3 の typical 8 以内（Risk 6）
- 403 / 429 はゼロ
- **PARTIAL 率 82%**。大半は「Contributor 指標が ecosyste.ms 経路（90日窓なし）」か
  「GitHub 統計が 202」で、障害ではない。PARTIAL が常態なので、この状態を「一部欠損」以上の
  意味に使わないこと
- Score の分布は 40〜88（30 件全体を測ったのは `algorithm_version` 0.2.0 時点。0.3.0 の
  変更は下記 6 件の抜き取りでのみ実測している）

### Release Health の校正（適用済み・`algorithm_version` 0.1.0 → 0.2.0）

初版では Release score が最低値 20 になった repo が 24 件中 **10 件** あり、実質「リリース頻度が
高い」ことを報告していた。実リリース履歴 27 件で原因を測ると、高頻度そのものではなく
**同日に複数リリースを打つリポジトリで間隔中央値が 0.0 日になる**ことだった（monorepo の
一括タグ付け）。

| repository | 生の間隔中央値 | 比率 |
|---|---|---|
| facebook/react | 0.0 日 | 141,733 |
| openssl/openssl | 0.0 日 | 13,064 |
| redis/redis | 0.0 日 | 2,109 |
| expressjs/express | 0.2 日 | 528 |

4 案を実データで比較した（`dev/release-calibration.mjs` で再現できる）。

| 案 | 最低値20 | 最高値100 | N/A | 平均 |
|---|---|---|---|---|
| 現行（初版） | 8 | 6 | 1 | 62.9 |
| 中央値に 14 日の下限 | 4 | 11 | 1 | 74.6 |
| **同日リリースを1件に畳んでから下限（採用）** | **3** | **12** | **1** | **79.8** |
| 直近1年の全リリースから中央値 | 9 | 8 | 1 | 62.5 |
| 週次未満は N/A | 1 | 3 | **14** | 78.6 |

「直近1年の全リリース」は現行より悪化し（svelte 70→20、deno 70→45）、「週次未満は N/A」は
25 件中 14 件が N/A になって 15% のカテゴリが半分以上消えるため、いずれもデータで却下した。

採用した実装は 2 点:

1. 同じ日に公開されたリリースは 1 回のリリースイベントとして数える（表示は全件そのまま）
2. 間隔中央値に 14 日の下限を置く（`RELEASE_MIN_MEDIAN_INTERVAL_DAYS`）

変動した 11 件はいずれも実際のリリース間隔と整合する。例:

| repository | 生の中央値 | 畳み込み後 | 経過 | 比率 | score |
|---|---|---|---|---|---|
| expressjs/express | 0.2 日 | 116 日 | 100 日 | 0.9 | 20 → 100（実際に約4か月周期） |
| facebook/react | 0.0 日 | 26 日 | 29.5 日 | 1.1 | 20 → 90 |
| openssl/openssl | 0.0 日 | 14 日 | 71.7 日 | 5.1 | 20 → 45（依然として遅い） |
| redis/redis | 0.0 日 | 14 日 | 2.5 日 | 0.2 | 20 → 100（2.5 日前にリリース済み） |

適用後の分布（同じ 30 件で再解析）:

| | 最低値20 | 最高値100 | 平均 |
|---|---|---|---|
| Release score 前 | 10 / 24 | 5 | 58.5 |
| Release score 後 | **2 / 24** | 12 | 80.8 |

総合 Health Score は平均 72.5 → 75.2、レンジ 40〜91 → 40〜88。スコア式が変わったため
`algorithm_version` を **0.2.0** に上げた。

### Community Resilience の校正（適用済み・`algorithm_version` 0.2.0 → 0.3.0）

`chalk/ansi-styles` の表示が実感と合わないという指摘から実データを見ると、この Repository の
Community 系の値はすべて**直近1年の commit 6 件**から計算されていた。

```
commits365d  6      ← 分母
top1Share    0.667  ← 6 件中 4 件を「67%」として提示
top3Share    1.000  ← 3 人しか commit していないので必ず 100%
community    24     ← 総合を 53 / Caution まで引き下げていた
```

比率ではなく標本数の言い換えを比率として出していた。仕様書 §8.3 は「Contributor が1〜2人の
小規模 OSS では事実表示に留める」、§11.2 は「小規模 OSS を極端に不利にしない」と書いているが、
実装は両方を点数に算入していた。

判定の切り分けは**人数ではなく commit の標本数**にした。`sqlite/sqlite` は 1,897 commit を
4 人で書いており、その 100% 集中は本物の所見なので残す必要がある。

- 直近1年の人間 commit が `MIN_COMMITS_FOR_COMMUNITY`（20）件未満のとき Top1/3/5 share を N/A にする
- 同条件で Community Resilience 自体を N/A にし、weight を再正規化して coverage を落とす
  （Release Health / Security の欠損と同じ扱い）
- 件数（実効 Contributor 数・Core Maintainer 数）は従来どおり表示する。伏せるのはスコアだけ
- 分母（`直近1年の Commit（人間のみ）`）と N/A の理由を画面に出す

実測（2026-08-20、6 件の抜き取り）:

| repository | c365 | top1 | top3 | community | 総合 | coverage |
|---|---|---|---|---|---|---|
| chalk/ansi-styles | 6 | N/A | N/A | N/A | 53 → **62** | 75% |
| chalk/chalk | 10 | N/A | N/A | N/A | 64 → 68 | 75% |
| sindresorhus/slugify | 4 | N/A | N/A | N/A | 40 | 75% |
| moment/moment | 28 | 100% | 100% | 46 | 58 | 85% |
| sqlite/sqlite | 1,897 | 61% | 100% | 66 | 72 | 85% |
| kubernetes/kubernetes | 5,355 | 6% | 14% | 89 | 86 | 100% |

`moment`（28 commit を1人）と `sqlite`（1,897 commit を4人）は引き続き採点される。本物の
bus factor 1 を抑制しないことを回帰テストで固定してある。

`algorithm_version` は版をまたいで比較しないこと（0.1.0 / 0.2.0 / 0.3.0 のスコアは互換ではない）。

## API

| Method | Path | 用途 |
|---|---|---|
| POST | `/api/v1/analyze` | URL を渡して解析開始。Basic が描ける時点で返る |
| GET | `/api/v1/analyses/{analysis_id}` | 進行中の解析をポーリングする |
| GET | `/api/v1/repos/{owner}/{repo}` | 保存済みの結果を読むだけ（新規解析を起こさない） |
| GET | `/api/v1/metrics` | 当該時間帯の observability カウンタ |

## MVP に入っていないもの

LLM / Chat / OSS 自然言語検索 / Recommendation / 全 GitHub Crawler / 定期全件更新 /
Private Repository / User Account / Billing / Repository 比較 / 通知 / GitLab /
AI コード検出 / Source Code 品質解析 / SBOM 生成 / 独自 Vulnerability scanner。

Scoring model のバージョンは analysis に保存される（現在 `0.3.0`）。閾値は実データを見て
調整する前提で、すべて `src/lib/config.ts` に集約してある。
