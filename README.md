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
   ├── ecosyste.ms       （Issue / PR 履歴の集約）
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

**GitHub の呼び出し回数を予算として強制する（§20.3）**
1 Repository あたり typical 8 / hard cap 12。cap は `GithubClient` 側で強制していて、
超えると例外になる（後から集計するだけでは、ページネーションの事故が静かに quota を食う）。
contributor statistics 1 本から Raw contributor 数・commit 窓・活動週・bot 判定まで
まとめて取ることで予算内に収めている。`GET /api/v1/metrics` で
`github_requests_per_analysis` を確認できる。

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

Scoring model のバージョンは analysis に保存される（現在 `0.1.0`）。閾値は実データを見て
調整する前提で、すべて `src/lib/config.ts` に集約してある。
