import { AnalyzeForm } from "@/components/AnalyzeForm";

export default function HomePage() {
  return (
    <section className="home">
      <h1 className="home__title">
        GitHub repository
        <br />
        health, <em>measured</em>.
      </h1>

      <p className="home__lede">
        Repository の URL を入れると、メンテナンスの継続性・Contributor の実態・Release の
        リズム・セキュリティ衛生を収集して、そのまま読める形で並べます。Star ランキングでは
        なく「いま健全に維持されているように見えるか」を扱います。
      </p>

      <AnalyzeForm />

      <p className="home__question">「このOSSは、今も健全に維持されているように見えるか？」</p>

      <div className="home__notes">
        <p className="home__note">
          <b>Effective Contributor</b>
          Raw な Contributor 数ではなく、継続的に手を入れていて Bot でも明示 AI Agent でもない
          人数を数えます。
        </p>
        <p className="home__note">
          <b>AI 利用は推測しない</b>
          明示的な Agent アカウントだけを Agent として数え、AI 支援を使う人間を推測で分類する
          ことはしません。
        </p>
        <p className="home__note">
          <b>欠損は隠さない</b>
          取得できなかった指標は 0 点にせず N/A として除外し、Score とは別に coverage を出します。
        </p>
        <p className="home__note">
          <b>低活動 ≠ 死んだ OSS</b>
          更新が少ないだけの成熟 OSS を放棄と断定せず、LOW_CHANGE として事実のまま示します。
        </p>
      </div>
    </section>
  );
}
