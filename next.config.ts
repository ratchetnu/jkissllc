import type { NextConfig } from "next";
import { withBotId } from "botid/next/config";

const nextConfig: NextConfig = {
  /* config options here */
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
