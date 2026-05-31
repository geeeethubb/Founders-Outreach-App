import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const id = params.id

    // emails table has no ON DELETE CASCADE so we must delete children manually
    // 1. Delete email events tied to this contact's emails
    const { data: emailRows } = await supabase
      .from('emails')
      .select('id')
      .eq('contact_id', id)

    if (emailRows && emailRows.length > 0) {
      const emailIds = emailRows.map((e) => e.id)
      await supabase.from('email_events').delete().in('email_id', emailIds)
    }

    // 2. Delete emails
    await supabase.from('emails')