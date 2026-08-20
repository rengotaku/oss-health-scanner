import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

// Makes the Cloudflare bindings declared in wrangler.jsonc (D1, vars, secrets)
// available to `next dev` through miniflare, so local dev exercises the real
// D1 SQL engine rather than a stand-in.
initOpenNextCloudflareForDev();

const nextConfig: NextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
