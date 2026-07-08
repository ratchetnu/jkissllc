import { redirect } from 'next/navigation'

// The admin front door is J KISS OS. /admin lands you in the Operations shell
// (floating dock / bottom nav); analytics lives at /admin/analytics.
export default function AdminIndex() {
  redirect('/admin/operations')
}
