# OSS Repository Health Scanner — 詳細仕様書

- バージョン: v0.1
- 作成日: 2026-08-20
- 想定フェーズ: MVP
- 対象: GitHub上の公開OSSリポジトリ
- 入力方式: GitHub Repository URLのみ
- 基本方針: **オンデマンド解析 + Repository単位キャッシュ**
- LLM利用: **なし**
- 大規模Crawler: **MVPでは実装しない**

---

## 1. プロダクト概要

### 1.1 目的

GitHub Repository URLを入力すると、そのOSSについて以下を自動収集・算出し、**人間が短時間で「現在の健康状態・継続性・コミュニティの実態・セキュリティ衛生」を理解できる画面**として返す。

単なるStarランキングではなく、以下を重視する。

- 現在もメンテナンスされているか
- Contributor数が実態を伴っているか
- 一部Maintainerへの依存が強すぎないか
- Bot / 明示AI AgentによるContributionで数字が膨らんでいないか
- Issue / PRが適切に処理されているか
- Releaseが継続しているか
- OpenSSF等から見てセキュリティ衛生に大きな問題がないか
- 数値の取得日時と欠損を明示し、ブラックボックス評価にしない

### 1.2 プロダクトが答える質問

> 「このOSSは、今も健全に維持されているように見えるか？」

### 1.3 プロダクトが答えない質問

MVPでは以下は対象外。

- 「このOSSが私の用途に最適か」
- 自然言語によるOSS検索
- OSS同士の機能比較
- README内容をAIで評価すること
- コード品質そのもののAI評価
- AI生成コード率の推定
- Claude Code / Cursor / Copilot補助利用率の推定
- Private Repositoryの診断
- GitHub以外（GitLab等）のRepository
- 世界中のRepositoryの常時Crawler

---

## 2. 基本ユーザーフロー

```text
トップページ
   ↓
GitHub URL入力
   ↓
URL検証・正規化
   ↓
Cache確認
   ├─ Fresh Cacheあり → 即時表示
   │
   └─ Cacheなし / Stale
          ↓
      基本情報取得
          ↓
      まず基本カード表示
          ↓
      詳細指標を並列取得
          ↓
      Score計算
          ↓
      UIを順次更新
          ↓
      Cache保存
```

### 2.1 入力例

```text
https://github.com/ggerganov/llama.cpp
```

許可する形式:

```text
https://github.com/{owner}/{repo}
http://github.com/{owner}/{repo}
github.com/{owner}/{repo}
```

正規化後:

```text
owner = ggerganov
repo  = llama.cpp
canonical_url = https://github.com/ggerganov/llama.cpp
```

### 2.2 入力エラー

以下の場合は解析しない。

- GitHub以外のドメイン
- owner/repositoryを特定できないURL
- Issue / Pull Request / Commitなど下位URL
- Repositoryが存在しない
- Private Repository
- RepositoryではなくProfile URL
- 削除済みRepository

表示例:

```text
このURLから公開GitHub Repositoryを確認できませんでした。
RepositoryトップページのURLを入力してください。
```

---

## 3. MVPのデータソース

### 3.1 優先順位

1. **GitHub REST API**
   - 現在値のSource of Truth
2. **ecosyste.ms**
   - Commit / Issue / PR等の履歴集約
   - GitHub API呼び出し削減
3. **OpenSSF Scorecard**
   - セキュリティ開発プロセス評価
4. **deps.dev**
   - Packageとの対応を安全に特定できる場合のみ補助利用
   - MVPの総合Scoreには原則必須にしない

### 3.2 なぜdeps.devを必須にしないか

入力がGitHub URLだけの場合、

```text
1 Repository = 1 Package
```

とは限らない。

例:

- Monorepo
- 複数npm package
- Python + JS package併存
- Package Registry未公開
- Repository名とPackage名が不一致

誤ったPackageに紐付けて脆弱性やLicenseを表示する方が危険なため、MVPでは以下の扱いとする。

```text
Repository → Package mappingを高信頼で確認できる
  → deps.dev情報を表示

確認できない
  → "Package security data: unavailable"
```

---

## 4. 解析レベル

ユーザーにモード選択はさせない。
内部的に2段階で処理する。

### Level 1: Basic

目標: 1〜2秒程度で画面を成立させる。

取得項目:

- Repository名
- Owner
- Description
- Stars
- Forks
- Archived
- Created At
- Updated At
- Pushed At
- Default Branch
- Primary Language
- License
- Open Issues概数
- Latest Release

### Level 2: Health Analysis

Basic表示後に並列処理する。

取得・算出:

- Contributor weekly activity
- Active Contributor
- Repeat Contributor
- Effective Contributor
- Top contributor concentration
- Bot判定
- Known AI Agent判定
- 90日 / 365日活動
- PR統計
- Issue統計
- Release cadence
- OpenSSF Scorecard
- Health Score
- Status label
- Warning / Positive signals

---

## 5. 取得指標一覧

### 5.1 Repository基本情報

| 指標 | MVP | 主データソース |
|---|---:|---|
| Stars | ○ | GitHub |
| Forks | ○ | GitHub |
| Watchers | △ | GitHub |
| Created At | ○ | GitHub |
| Updated At | ○ | GitHub |
| Pushed At | ○ | GitHub |
| Archived | ○ | GitHub |
| License | ○ | GitHub |
| Language | ○ | GitHub |
| Default Branch | ○ | GitHub |
| Open Issues概数 | ○ | GitHub |
| Latest Release | ○ | GitHub |

### 5.2 開発活動

| 指標 | MVP | 算出 |
|---|---:|---|
| 直近30日Commit | ○ | GitHub / ecosyste.ms |
| 直近90日Commit | ○ | GitHub / ecosyste.ms |
| 直近365日Commit | ○ | GitHub |
| 最終Commit経過日数 | ○ | GitHub |
| 90日Active Contributors | ○ | Contributor weekly activity |
| 365日Active Contributors | ○ | Contributor weekly activity |
| Active Weeks | ○ | Contributor weekly activity |
| Activity trend | △ | 直近90日 vs その前90日 |

### 5.3 Contributor健全性

| 指標 | MVP |
|---|---:|
| Raw Contributor数 | ○ |
| Active Contributor数 | ○ |
| Repeat Contributor数 | ○ |
| Effective Contributor数 | ○ |
| Core Maintainer数 | ○ |
| One-shot Contributor比率 | ○ |
| Top1 Contribution Share | ○ |
| Top3 Contribution Share | ○ |
| Top5 Contribution Share | △ |
| Bot Contributor数 | ○ |
| Known AI Agent数 | ○ |
| Human/Unknown Contributor数 | ○ |

### 5.4 Issue / PR

| 指標 | MVP |
|---|---:|
| Total Issues | ○ |
| Total PR | ○ |
| Merged PR | ○ |
| Bot PR | ○ |
| Average Issue Close Time | ○ |
| Average PR Close Time | ○ |
| Issue Author数 | ○ |
| PR Author数 | ○ |
| Open/Closed比率 | △ |
| Median First Response Time | Phase 2 |

### 5.5 Release

| 指標 | MVP |
|---|---:|
| Latest Release Date | ○ |
| Latest Release Age | ○ |
| 直近Release一覧 | ○ |
| Median Release Interval | ○ |
| Release Delay Ratio | ○ |
| Release有無 | ○ |

### 5.6 Security

| 指標 | MVP |
|---|---:|
| OpenSSF Overall Score | ○（利用可能な場合） |
| OpenSSF checks | ○ |
| License存在 | ○ |
| Dependency Vulnerability | △ |
| Package License | △ |
| Dependency Graph | Phase 2 |

---

## 6. Contributorの定義

単純なContributor数を主要評価値にしない。

### 6.1 Raw Contributor

RepositoryでContributionが確認されたContributor。

```text
raw_contributors
```

### 6.2 Active Contributor

直近90日以内に1回以上Commitが確認できたContributor。

```text
active_90d = commits_90d >= 1
```

### 6.3 Repeat Contributor

直近365日で以下のどちらかを満たすContributor。

```text
commits_365d >= 2
OR
active_weeks_365d >= 2
```

### 6.4 Effective Contributor

コミュニティの実効的な厚みを見るための独自指標。

条件:

```text
active_365d = true
AND repeat_contributor = true
AND contributor_type NOT IN (BOT, KNOWN_AI_AGENT)
```

目的:

```text
Raw Contributors = 183
```

だけではなく、

```text
Raw Contributors          183
Active 90d                 48
Repeat 365d                37
Bots                       23
Known AI Agents             7
Effective Contributors     31
```

のように表示する。

### 6.5 Core Maintainer

暫定定義:

```text
commits_365d >= 5
AND active_weeks_365d >= 3
AND contributor_type NOT IN (BOT, KNOWN_AI_AGENT)
```

この閾値は実データを見て調整する。

---

## 7. Bot / AI Agentの分類

### 7.1 分類カテゴリ

```text
HUMAN_OR_UNKNOWN
BOT
KNOWN_AI_AGENT
```

AI補助を使っている人間を「AI」と推測しない。

### 7.2 Bot判定

高信頼なシグナルのみ利用する。

例:

- GitHub user type = Bot
- loginが `[bot]` を含む
- known bot list
- ecosyste.msのbot判定

### 7.3 Known AI Agent判定

明示的な証拠がある場合のみ。

例:

- GitHub Copilot Coding Agentとして記録
- Author / Co-author metadata
- 明示的Agent identity
- 既知Agent account

### 7.4 判定しないもの

以下は推定しない。

```text
人間アカウント
 ↓
Claude Codeで99%生成
 ↓
本人名義でcommit
```

これは `HUMAN_OR_UNKNOWN` とする。

### 7.5 スコアへの影響

AI Agent比率そのものを直接「悪い」と評価しない。

代わりに、

```text
Effective Human/Unknown Contributorsが少ない
AND
Known Agent Contribution比率が非常に高い
```

場合のみ、

```text
⚠️ Human maintainer resilience may be low
```

というSignalを表示する。

これにより、

- AI利用を不当に減点しない
- Contributor数の水増しも防ぐ

---

## 8. Contributor集中度

### 8.1 Top1 Share

```text
top1_share =
top_contributor_commits_365d
/
all_human_unknown_commits_365d
```

### 8.2 Top3 Share

```text
top3_share =
top_3_contributors_commits_365d
/
all_human_unknown_commits_365d
```

Bot / Known AI Agentは分母から除外する。

### 8.3 UI判定

暫定:

| Top3 Share | 表示 |
|---:|---|
| < 40% | 🟢 分散 |
| 40–65% | 🟡 やや集中 |
| 65–85% | 🟠 高集中 |
| > 85% | 🔴 非常に高集中 |

ただしContributorが1〜2人の小規模OSSでは「悪いOSS」と断定せず、

```text
Maintainer concentration is high
```

という事実表示に留める。

---

## 9. Health Score

### 9.1 基本思想

Health Scoreは、

> 「OSSの品質」

ではなく、

> 「Repositoryが現在どれだけ健全に維持されているように見えるか」

を表す。

用途適合性は含めない。

### 9.2 Score構成

```text
Health Score
├─ Maintenance            30%
├─ Community Resilience   25%
├─ Security Hygiene       20%
├─ Release Health         15%
└─ Adoption               10%
```

### 9.3 欠損データ

欠損値を0点扱いしない。

例:

```text
OpenSSF Score unavailable
```

ならSecurityを除外して残りのWeightを再正規化する。

```text
score =
Σ(category_score × available_weight)
/
Σ(available_weight)
```

UIには必ず、

```text
Score coverage: 80%
```

を表示する。

### 9.4 Score Band

| Score | 表示 |
|---:|---|
| 85–100 | Excellent |
| 70–84 | Healthy |
| 55–69 | Mixed |
| 40–54 | Caution |
| 0–39 | High Risk / Low Confidence |

名称はMVPテストで調整する。

---

## 10. Maintenance Score

Weight: 30%

### 10.1 Commit Recency

暫定スコア:

| 最終Commit | Score |
|---|---:|
| ≤ 7日 | 100 |
| ≤ 30日 | 90 |
| ≤ 90日 | 75 |
| ≤ 180日 | 55 |
| ≤ 365日 | 35 |
| > 365日 | 15 |
| Archived | 0 |

### 10.2 Activity Continuity

直近365日のActive Week数を利用。

例:

```text
active_weeks_365d / 52
```

ただし「Commit数が多いほど正義」にはしない。

### 10.3 Issue / PR Maintenance

利用可能な場合、

- Average Issue Close Time
- Average PR Close Time
- Recent PR Activity

を利用。

### 10.4 Maintenance Score案

```text
Maintenance =
Commit Recency        45%
Activity Continuity   25%
Issue Health          15%
PR Health             15%
```

---

## 11. Community Resilience Score

Weight: 25%

### 11.1 構成

```text
Community Resilience =
Effective Contributors   35%
Repeat Contributor Ratio 25%
Top3 Concentration       25%
Core Maintainers         15%
```

### 11.2 Effective Contributors Score

暫定:

| 人数 | Score |
|---:|---:|
| 0 | 0 |
| 1 | 30 |
| 2–3 | 50 |
| 4–7 | 70 |
| 8–15 | 85 |
| ≥16 | 100 |

小規模OSSを極端に不利にしないため、人数を線形評価しない。

### 11.3 Repeat Ratio

```text
repeat_ratio =
repeat_contributors_365d
/
active_contributors_365d
```

### 11.4 Contributor集中

Top3 Shareが低いほど高スコア。

暫定:

| Top3 Share | Score |
|---:|---:|
| ≤ 35% | 100 |
| ≤ 50% | 85 |
| ≤ 65% | 65 |
| ≤ 80% | 40 |
| > 80% | 20 |

---

## 12. Security Hygiene Score

Weight: 20%

### 12.1 MVP

OpenSSF Scorecardが利用可能なら、そのOverall Scoreおよび主要Checkを利用。

```text
OpenSSF 8.2 / 10
→ Security Hygiene 82 / 100
```

必要に応じて、重大CheckをSignalとして別表示する。

### 12.2 OpenSSFがない場合

```text
Security Hygiene: N/A
Reason: OpenSSF Scorecard data unavailable
```

0点にはしない。

### 12.3 将来

- deps.dev
- OSV advisory
- Dependency vulnerability
- Dependency freshness
- SBOM

を追加可能。

---

## 13. Release Health Score

Weight: 15%

### 13.1 単純な「最新Releaseから何日」だけで評価しない

月次ReleaseのOSSと、年1ReleaseのOSSは性質が異なるため。

### 13.2 Release Delay Ratio

直近5回程度のReleaseからMedian intervalを計算。

```text
median_interval = median(
  release_1 - release_2,
  release_2 - release_3,
  ...
)

release_delay_ratio =
days_since_latest_release / median_interval
```

### 13.3 判定例

| Delay Ratio | Score |
|---:|---:|
| ≤ 1.0 | 100 |
| ≤ 1.5 | 90 |
| ≤ 2.0 | 70 |
| ≤ 3.0 | 45 |
| > 3.0 | 20 |

### 13.4 Releaseを使わないRepository

Releaseがないこと自体を減点しない。

```text
Release Health = N/A
```

としてWeightを再正規化する。

---

## 14. Adoption Score

Weight: 10%

Starを主要評価にしない。

### 14.1 初期案

```text
Star Score =
min(100, 20 × log10(stars + 1))
```

目安:

```text
10 stars      ≒ 21
100 stars     ≒ 40
1,000 stars   ≒ 60
10,000 stars  ≒ 80
100,000 stars ≒ 100
```

Forkも補助利用する。

```text
Adoption =
Star Score 80%
Fork Score 20%
```

将来的にはecosyste.ms等を使ったRepositoryカテゴリ別Percentileを検討する。

---

## 15. 「完成したOSS」と「死んだOSS」の問題

Activityが低いだけで「死んでいる」と判定しない。

### 15.1 Status Label

Scoreとは別にStatusを付与する。

```text
ACTIVE
LOW_CHANGE
STALE
ARCHIVED
INDETERMINATE
```

### 15.2 暫定ルール

#### ACTIVE

```text
last_commit <= 90 days
```

#### LOW_CHANGE

例:

```text
90 < last_commit <= 365 days
AND repository not archived
AND historical release/activity indicates low-change project
```

表示:

```text
Low-change project
更新頻度は低いですが、放棄されたRepositoryとは断定できません。
```

#### STALE

例:

```text
last_commit > 365 days
AND no recent release
AND no meaningful recent PR/Issue activity
```

#### ARCHIVED

GitHub `archived = true`

#### INDETERMINATE

データ不足。

### 15.3 禁止表現

自動判定だけで以下を断定しない。

```text
Dead OSS
Abandoned
Unsafe
```

---

## 16. UI仕様

## 16.1 トップページ

```text
┌──────────────────────────────────────────┐
│ OSS Health                              │
│                                          │
│ GitHub repository health at a glance    │
│                                          │
│ ┌──────────────────────────────────────┐ │
│ │ https://github.com/owner/repository  │ │
│ └──────────────────────────────────────┘ │
│                              [Analyze]   │
└──────────────────────────────────────────┘
```

入力は1つだけ。

Filters / AI prompt / advanced optionsは置かない。

---

## 16.2 結果ファーストビュー

```text
llama.cpp                              ACTIVE

Health Score
86 / 100     Healthy

Score coverage 95%
Analyzed 3 min ago

Maintenance            92  █████████░
Community Resilience   81  ████████░░
Security Hygiene       84  ████████░░
Release Health         89  █████████░
Adoption               98  ██████████

🟢 直近90日も継続的に開発
🟢 実効Contributorが十分
🟡 Top3 Contributorへの集中がやや高い
🟢 OpenSSF Scorecard良好
```

### UI原則

- 総合点だけを見せない
- 数字 + 短い日本語をセット
- Green / Yellow / Orange / Redだけに依存しない
- 欠損を隠さない
- 「なぜこの点数か」を1クリックで確認できる

---

## 16.3 Contributorカード

```text
Community

Raw Contributors             183
Active Contributors (90d)     48
Repeat Contributors (365d)    37
Effective Contributors        31
Core Maintainers              14

Bot Contributors              23
Known AI Agents                7

Top 1 contribution share      28%
Top 3 contribution share      62%

[ Why Effective Contributors? ]
```

### Tooltip

```text
Effective Contributor

直近1年に継続的なContributionがあり、
Botまたは明示AI AgentではないContributorです。

AI支援を利用している人間を推測で除外することはありません。
```

---

## 16.4 Activityカード

```text
Activity

Last commit               2 days ago
Commits / 30d             87
Commits / 90d            241
Active weeks / 1y         47 / 52

90d contributors          48
```

簡易Sparklineを表示可能。

---

## 16.5 Securityカード

```text
Security Hygiene

OpenSSF Scorecard       8.4 / 10

Branch Protection      Good
Code Review            Good
Dependency Update      Caution
Security Policy        Good

Package vulnerability data
Not available
```

「データなし」と「問題なし」を明確に分ける。

---

## 16.6 Data Freshness

画面下部に必ず表示。

```text
Data freshness

GitHub              2 min ago
ecosyste.ms         6 hours ago
OpenSSF             3 days ago

Score calculated    2 min ago
```

---

## 17. オンデマンド解析設計

MVPではCrawlerを持たない。

### 17.1 Cache Miss

```text
Request
 ↓
Normalize URL
 ↓
Repository DB lookup
 ↓
Cache MISS
 ↓
Acquire analysis lock
 ↓
GitHub Basic API
 ↓
Basic result返却
 ↓
Health APIs並列実行
 ↓
Score
 ↓
DB保存
 ↓
Complete
```

### 17.2 Cache Hit

```text
Request
 ↓
Repository DB lookup
 ↓
fresh cache
 ↓
即時返却
```

### 17.3 Same Repositoryへの同時アクセス

同一Repositoryに対する解析を重複実行しない。

```text
github.com/foo/bar
 Request A → Analysis開始
 Request B → 同じAnalysis Jobを購読
 Request C → 同じAnalysis Jobを購読
```

Redis等で、

```text
analysis_lock:{repo_id}
```

を持つ。

---

## 18. Cache戦略

### 18.1 TTL

MVP初期値:

```text
Basic repository metadata   1 hour
Health metrics              6 hours
OpenSSF                     24 hours
ecosyste.ms                 6 hours
Release metrics             6 hours
```

ユーザー向けには1つの、

```text
Analyzed X hours ago
```

として表示する。

### 18.2 Stale-While-Revalidate

Phase 1.5候補。

```text
Cache 8 hours old
 ↓
即時Staleデータ表示
 +
裏でRequest-triggered refresh
```

常時Crawlerではなく、ユーザーアクセスをトリガーにする。

---

## 19. レスポンス時間設計

### 19.1 目標

| 状態 | UX目標 |
|---|---:|
| Fresh Cache Hit | 100–500ms |
| Basic Cache Miss | 0.5–2秒 |
| Health Analysis通常 | 3–8秒 |
| External API遅延 | Partial resultを先に表示 |
| GitHub stats cold | 完了待ちを限定 |

数値はSLOではなくMVP設計目標。

### 19.2 GitHub Statisticsの202対策

GitHub Statistics APIは、統計が未生成の場合 `202 Accepted` を返すことがある。

Retry例:

```text
0 sec   first request
1 sec   retry
3 sec   retry
7 sec   retry
```

MVPでは1リクエストの統計待機Budgetを最大約7〜8秒とする。

完了しなければ、

```text
Contributor details are still unavailable.
```

としてPartial resultを返す。

ページ全体を失敗扱いにしない。

### 19.3 大規模Repository

GitHubの一部Statistics APIには大規模Repositoryで制約がある。

特にaddition/deletion値はScoreの主要入力にしない。

Commit件数・活動週・Contributor活動を主に利用する。

---

## 20. API負荷設計

### 20.1 GitHub API Limit

MVPでは認証済みServer-side API利用を前提とする。

GitHub REST APIの一般的な認証済みPrimary Limit:

```text
5,000 requests / hour
```

Unauthenticated:

```text
60 requests / hour
```

したがって、本サービスでUnauthenticated API運用は不可。

### 20.2 Secondary Limit

Primary Limitだけを見ない。

GitHubにはSecondary Rate Limitがあり、代表的には:

```text
Concurrent requests <= 100
REST endpoint points <= 900 points/minute
```

制限は変更され得るため、Application側で余裕を持つ。

### 20.3 RepositoryあたりAPI Budget

目標:

```text
Typical GitHub requests / new repository <= 8
Hard cap <= 12
```

概念例:

```text
Repository metadata       1
Latest/recent Releases    1
Contributor statistics    1–4  ※202 retry含む
Commit activity           0–1
Fallback                   0–2
--------------------------------
Typical                    4–8
Worst budget              12
```

Issue / PR集約は可能な限りecosyste.msを利用し、GitHubの全履歴Paginationを避ける。

### 20.4 理論上の処理数

8 requests/repositoryの場合:

```text
5,000 / 8
= 625 uncached repositories / hour
```

12 requests/repositoryの場合:

```text
5,000 / 12
≈ 416 uncached repositories / hour
```

ただしこれはPrimary Limitだけを使った理論値。

実運用目標は余裕を持ち、

```text
200–300 uncached analyses / hour
```

程度を1認証枠あたりの初期安全目標とする。

Cache HitはGitHub APIを消費しない。

### 20.5 重要な観点

利用者数より、

```text
「1時間あたり何件の新規Repositoryが投入されるか」
```

が負荷の主要指標。

例えば:

```text
月間10,000 users
```

でも、多くが同一Popular OSSを見るならAPI負荷は低い。

逆に、

```text
1時間で1,000種類の未知Repository
```

を投入されるとRate Limitが問題になる。

---

## 21. 負荷防御

### 21.1 Rate Limit

自サービス側でも制限する。

未ログイン:

```text
例: 10 analyses / IP / hour
```

将来的にUser Account導入後:

```text
Free: X uncached analyses/day
```

### 21.2 Repository Lock

同じRepositoryへの同時解析を1本にまとめる。

### 21.3 API Semaphore

MVP例:

```text
GitHub concurrent calls      10–20
OpenSSF concurrent calls      5–10
ecosyste.ms concurrent calls  5–10
```

GitHubの上限100並列まで使い切らない。

### 21.4 Timeout

```text
GitHub basic API       3 sec
External enrichment    3 sec
Overall first result   2 sec target
Overall health         8 sec target
```

外部API1つの障害で全画面を落とさない。

### 21.5 Circuit Breaker

例:

```text
OpenSSF 5xx増加
 ↓
OpenSSF呼び出し停止
 ↓
Security = temporarily unavailable
```

---

## 22. Backend API案

### 22.1 Analyze

```http
POST /api/v1/analyze
```

Request:

```json
{
  "url": "https://github.com/owner/repository"
}
```

Response:

```json
{
  "analysis_id": "ana_xxx",
  "repository": {
    "owner": "owner",
    "name": "repository"
  },
  "status": "processing",
  "cached": false
}
```

### 22.2 Result

```http
GET /api/v1/analyses/{analysis_id}
```

Response:

```json
{
  "status": "complete",
  "coverage": 0.95,
  "health_score": 86,
  "status_label": "ACTIVE",
  "scores": {
    "maintenance": 92,
    "community_resilience": 81,
    "security_hygiene": 84,
    "release_health": 89,
    "adoption": 98
  }
}
```

### 22.3 Repository result

```http
GET /api/v1/repos/{owner}/{repo}
```

Fresh Cacheがある場合は即時返却。

---

## 23. Analysis State

```text
QUEUED
FETCHING_BASIC
FETCHING_ACTIVITY
FETCHING_SECURITY
SCORING
COMPLETE
PARTIAL
FAILED
```

### PARTIAL

一部データソースが失敗しても利用可能な場合。

例:

```json
{
  "status": "partial",
  "coverage": 0.75,
  "unavailable": [
    "openssf"
  ]
}
```

---

## 24. データモデル案

### repositories

```text
id
github_repo_id
owner
name
canonical_url
description
stars
forks
archived
license
language
created_at
updated_at
pushed_at
last_fetched_at
```

### analyses

```text
id
repository_id
status
health_score
score_coverage
status_label

maintenance_score
community_score
security_score
release_score
adoption_score

started_at
completed_at
algorithm_version
```

### contributor_metrics

```text
analysis_id
raw_contributors
active_90d
active_365d
repeat_365d
effective_contributors
core_maintainers

bot_contributors
known_ai_agents

top1_share
top3_share
top5_share
```

### activity_metrics

```text
analysis_id
commits_30d
commits_90d
commits_365d
active_weeks_365d
last_commit_at
```

### issue_pr_metrics

```text
analysis_id
total_issues
total_prs
merged_prs
bot_prs
avg_issue_close_seconds
avg_pr_close_seconds
issue_authors
pr_authors
source_updated_at
```

### release_metrics

```text
analysis_id
latest_release_at
release_count_sample
median_interval_days
release_delay_ratio
```

### security_metrics

```text
analysis_id
openssf_score
openssf_checks_json
deps_data_available
vulnerability_count
source_updated_at
```

---

## 25. Algorithm Versioning

スコア式は今後必ず変わるため、AnalysisにVersionを保存。

```text
algorithm_version = "0.1.0"
```

Score更新時:

```text
0.1.0 → 0.2.0
```

過去Scoreと現在Scoreが混ざらないようにする。

UIにも必要なら、

```text
Scoring model v0.1
```

を表示。

---

## 26. Score説明機能

Scoreには必ずReasonsを保存する。

例:

```json
{
  "maintenance": {
    "score": 92,
    "signals": [
      {
        "type": "positive",
        "text": "Last commit was 2 days ago"
      },
      {
        "type": "positive",
        "text": "47 active weeks in the past year"
      }
    ]
  }
}
```

これによりUIで、

```text
Maintenance 92
[ Why? ]

✓ 最終Commit 2日前
✓ 過去52週中47週で活動
```

を実現する。

---

## 27. Confidence / Coverage

Scoreとは別にデータ充足率を持つ。

```text
Health Score   86
Coverage       95%
```

### Coverageの目的

```text
86点 / データ95%
```

と、

```text
86点 / データ45%
```

を同じ信頼度に見せない。

### Coverage算出

利用可能Category Weightの合計。

例:

Security 20%が欠損:

```text
Coverage = 80%
```

---

## 28. エラー処理

### GitHub 404

```text
Repository not found or not publicly accessible.
```

### GitHub Rate Limit

Fresh Cacheがあれば:

```text
Cached resultを表示
```

なければ:

```text
Analysis is temporarily unavailable.
```

### ecosyste.ms failure

```text
Issue / PR metrics = unavailable
```

残りでScoreを再計算。

### OpenSSF failure / no data

```text
Security Hygiene = N/A
```

### deps.dev mapping failure

```text
Package data = unavailable
```

---

## 29. セキュリティ

### 29.1 GitHub Token

Clientへ渡さない。

```text
Browser
  ↓
Own Backend
  ↓
GitHub API
```

### 29.2 SSRF対策

ユーザー入力URLをそのままfetchしない。

URLから、

```text
owner
repo
```

だけを抽出し、Backendが固定GitHub API endpointへ問い合わせる。

### 29.3 URL許可

```text
host == github.com
```

を厳密に検証。

---

## 30. Observability

最低限記録する。

### API

```text
github_requests_total
github_requests_per_analysis
github_rate_limit_remaining
github_403_total
github_429_total

ecosystems_latency
openssf_latency
```

### Analysis

```text
analysis_total
analysis_cache_hit_rate
analysis_duration_p50
analysis_duration_p95
analysis_partial_rate
analysis_failure_rate

new_repositories_per_hour
```

### 特に重要

```text
GitHub requests / uncached analysis
```

この数値が8を超えて増えていないか監視する。

---

## 31. MVP技術構成例

特定Frameworkには固定しないが、シンプルな構成例:

```text
Frontend
  Next.js
     │
     ▼
Backend API
  Next.js API / FastAPI / Go
     │
     ├── PostgreSQL
     │
     ├── Redis
     │
     ├── GitHub REST API
     │
     ├── ecosyste.ms
     │
     └── OpenSSF Scorecard
```

Redis用途:

```text
cache
analysis lock
rate limiting
short-lived job state
```

PostgreSQL:

```text
repository
analysis
metrics
score history
```

MVP規模ならJob Queue専用製品は必須ではない。

---

## 32. MVP画面

必要なのは原則3画面。

### 1. Home

```text
GitHub URL input
Analyze button
```

### 2. Repository Analysis

```text
Overall Health
Status
Category Scores
Signals
Activity
Contributor
Security
Release
Raw Metrics
Freshness
```

### 3. Error / Not Found

Repository取得不能時。

ログイン・Dashboard・お気に入り・比較機能は後回し。

---

## 33. MVPで実装しないもの

- LLM
- Chat
- OSS自然言語検索
- Recommendation
- 全GitHub Crawler
- 定期全件更新
- Private Repository
- User Account
- Billing
- Repository比較
- 通知
- GitLab
- AIコード検出
- Source Code品質解析
- Dependency SBOM生成
- 独自Vulnerability scanner

---

## 34. Phase 2候補

### 比較

```text
Repo A vs Repo B
```

### History

```text
Health Score
90 → 87 → 72
```

### Change Detection

```text
OpenSSF score dropped
Maintainer concentration increased
Release activity stopped
```

### Dependency Intelligence

deps.dev / OSVを利用。

### Public Score Page

```text
/service/github.com/owner/repo
```

### Badge

```text
OSS Health: 86 / 100
```

### API提供

```text
GET /public/v1/github/{owner}/{repo}
```

---

## 35. MVP受け入れ条件

### 入力

- [ ] GitHub Repository URLを解析できる
- [ ] 不正URLを拒否できる
- [ ] canonical owner/repoへ正規化できる

### 基本情報

- [ ] Stars
- [ ] Forks
- [ ] License
- [ ] Archived
- [ ] Last push
- [ ] Latest release

### Contributor

- [ ] 90日Active Contributor
- [ ] Repeat Contributor
- [ ] Effective Contributor
- [ ] Bot分類
- [ ] Known AI Agent分類
- [ ] Top3 concentration

### Score

- [ ] 5カテゴリScore
- [ ] Overall Health Score
- [ ] Coverage
- [ ] Algorithm Version
- [ ] Score理由

### UI

- [ ] Basic情報を先に表示
- [ ] 詳細値を後から更新
- [ ] 欠損値をN/A表示
- [ ] Data freshness表示
- [ ] Score理由を確認可能

### Performance

- [ ] Fresh Cache p95 < 500msを目標
- [ ] Cache Miss Basic表示 < 2秒を目標
- [ ] 通常Health Analysis < 8秒を目標
- [ ] GitHub API typical ≤ 8 requests/repository
- [ ] 同Repositoryの同時解析をdedupe

### Reliability

- [ ] OpenSSF障害でもGitHub診断は表示
- [ ] ecosyste.ms障害でもBasic診断は表示
- [ ] GitHub Statistics 202を処理
- [ ] Rate Limitを監視
- [ ] 403/429で無限Retryしない

---

## 36. 最初に検証すべきリスク

### Risk 1: Scoreの納得感

技術より最重要。

検証:

```text
有名OSS 20〜50件
```

を人間が見て、

```text
「このScoreなら感覚的に妥当」
```

になるか。

### Risk 2: 「低活動 = 悪い」の誤判定

成熟OSSを不当に低く評価しないこと。

### Risk 3: Contributor指標の意味

Raw ContributorよりEffective Contributorが本当に判断に役立つか。

### Risk 4: ecosyste.msのFreshness

データが古い場合にGitHub現在値と矛盾しないか。

### Risk 5: OpenSSF Coverage

すべてのRepositoryでScorecardデータが存在するとは限らない。

### Risk 6: GitHub API Cost

実測する。

最重要KPI:

```text
GitHub API calls / new repository analysis
```

### Risk 7: Statistics API latency

202 Acceptedがどの程度発生し、どの程度待つか実Repositoryで測定する。

---

## 37. MVP開発順序

### Step 1

GitHub URL → Repository Basic情報。

### Step 2

Contributor Statistics取得。

### Step 3

Effective Contributor / Concentration算出。

### Step 4

ScoreなしでRaw Metrics UIを作る。

### Step 5

20〜50 OSSでMetricsを観察。

### Step 6

Health Score v0.1を実装。

### Step 7

ecosyste.ms連携。

### Step 8

OpenSSF連携。

### Step 9

Cache / dedupe / rate limit。

### Step 10

レスポンス時間・API call数を実測してThreshold調整。

---

## 38. 重要な設計判断まとめ

### 決定

```text
入力                GitHub URLのみ
LLM                 使わない
Crawler             MVPでは使わない
解析                On-demand
Cache               Repository単位
GitHub               Source of Truth
ecosyste.ms          履歴集約の補助
OpenSSF              Security評価
deps.dev             条件付き補助
AI判定               Known Agentのみ
AI利用推測           しない
Contributor評価      Effective Contributor中心
Overall Score        あり
Score内訳            必須
Coverage             必須
Freshness            必須
```

### サービスのコア価値

```text
GitHubで見える大量の数字
          ↓
「今、このOSSをどう見ればいいか」
に変換する
```

その中でも最大の差別化候補は、

```text
Raw Contributor
        ↓
Effective Contributor
        +
Maintainer Concentration
        +
Bot / Known AI Agent separation
```

による、**AI時代向けのContributor健全性評価**。

---

## 39. 参考にした現行仕様（2026-08-20確認）

- GitHub REST API
  - Repository Statistics API
  - Contributor weekly activity
  - Statistics未生成時の `202 Accepted`
  - REST API Primary / Secondary Rate Limits
  - Releases API
- OpenSSF Scorecard
  - REST API / published Scorecard result
- deps.dev
  - Package Version / License / Dependency / Advisory data
- ecosyste.ms
  - Repository / Commit / Issue / Pull Request metadata APIs

外部APIの仕様・Rate Limitは変更される可能性があるため、実装時には固定値をコードへ散在させず設定値として管理する。
