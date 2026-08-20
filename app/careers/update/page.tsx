import UpdateApplicationForm from './UpdateApplicationForm'

export default async function ApplicantUpdatePage({ searchParams }: {
  searchParams: Promise<{ token?: string }>
}) {
  const { token = '' } = await searchParams
  return <UpdateApplicationForm token={token} />
}
