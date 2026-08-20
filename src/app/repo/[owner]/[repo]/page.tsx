import type { Metadata } from "next";
import { AnalysisReport } from "@/components/AnalysisReport";
import { normalizeRepoUrl } from "@/lib/url";
import { NotFoundNotice } from "@/components/NotFoundNotice";

type Props = { params: Promise<{ owner: string; repo: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { owner, repo } = await params;
  return { title: `${owner}/${repo} — OSS Health` };
}

export default async function RepoPage({ params }: Props) {
  const { owner, repo } = await params;
  // The path itself is user input, so it goes through the same validation as
  // the form (spec 29.2/29.3) before any request is made on its behalf.
  const normalized = normalizeRepoUrl(`https://github.com/${owner}/${repo}`);
  if (!normalized.ok) return <NotFoundNotice />;

  return <AnalysisReport owner={normalized.ref.owner} repo={normalized.ref.repo} />;
}
