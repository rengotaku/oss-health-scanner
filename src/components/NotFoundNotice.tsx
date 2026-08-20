import Link from "next/link";
import { NORMALIZE_MESSAGE } from "@/lib/url";

/** Screen 3 of spec 32: the error / not-found view. */
export function NotFoundNotice() {
  return (
    <section className="failure">
      <p className="failure__code">Invalid repository</p>
      <h1 className="failure__title">この URL は解析できません</h1>
      <p className="failure__body">{NORMALIZE_MESSAGE}</p>
      <p className="failure__body">
        <Link href="/">トップページへ戻る</Link>
      </p>
    </section>
  );
}
