import { checkBotId } from 'botid/server'

// Returns true only when Vercel BotID is confident the caller is an unverified
// bot. Fails OPEN (returns false) on any error or low confidence, so a real
// customer is never blocked even if BotID is unconfigured or the check throws.
// Rate limiting remains the always-on baseline alongside this.
export async function isBlockedBot(): Promise<boolean> {
  try {
    const v = await checkBotId()
    // Only block when BotID actually ran (not bypassed) and is confident this is
    // an unverified bot. If the check was bypassed/unprovisioned, never block.
    return v.isBot === true && v.isVerifiedBot !== true && v.bypassed !== true
  } catch {
    return false
  }
}
