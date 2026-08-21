import type { NextConfig } from "next";
import { withBotId } from "botid/next/config";

const nextConfig: NextConfig = {
  /* config options here */
  // These packages provide server-only binary assets (libheif wasm and the
  // Unicode signing fonts), so load them from node_modules at runtime.
  serverExternalPackages: ['heic-convert', 'dejavu-fonts-ttf'],
  outputFileTracingIncludes: {
    '/api/admin/careers': [
      './node_modules/dejavu-fonts-ttf/ttf/DejaVuSans.ttf',
      './node_modules/dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf',
    ],
  },
  async redirects() {
    return [
      // The platform's public page moved from /opspilot to /operion (brand rename).
      // Permanent redirect preserves old links, bookmarks, and SEO.
      { source: '/opspilot', destination: '/operion', permanent: true },
    ];
  },
};

// Wrap with Vercel BotID — injects the invisible challenge proxy for protected forms.
export default withBotId(nextConfig);
