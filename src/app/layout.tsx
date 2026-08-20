import type { Metadata } from "next";
import Link from "next/link";
import { Fraunces, IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import { ALGORITHM_VERSION } from "@/lib/config";
import "./globals.css";

const fraunces = Fraunces({
  subsets: ["latin"],
  display: "swap",
  axes: ["SOFT", "WONK", "opsz"],
  variable: "--font-fraunces",
});

const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--font-plex-sans",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--font-plex-mono",
});

export const metadata: Metadata = {
  title: "OSS Health — GitHub repository health at a glance",
  description:
    "GitHub Repository URL から、メンテナンス状況・Contributor の実態・セキュリティ衛生を読み取れる形で提示します。",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body className={`${fraunces.variable} ${plexSans.variable} ${plexMono.variable}`}>
        <div className="shell">
          <header className="masthead">
            <Link href="/" className="masthead__mark">
              OSS <span>Health</span>
            </Link>
            <span className="masthead__meta">Scoring model v{ALGORITHM_VERSION}</span>
          </header>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
