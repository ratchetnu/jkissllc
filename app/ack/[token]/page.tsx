import AckClient from './AckClient'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Respond to Dispatch' }

// Public one-tap acknowledgement page — reached from an SMS/email reminder link. No
// login: the token in the URL is the capability (mirrors the /route/[token] confirm page).
export default async function AckPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return <AckClient token={token} />
}
