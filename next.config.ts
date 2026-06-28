import type { NextConfig } from "next";
import { withBotId } from "botid/next/config";

const nextConfig: NextConfig = {
  /* config options here */
};

// Wrap with Vercel BotID — injects the invisible challenge proxy for protected forms.
export default withBotId(nextConfig);
