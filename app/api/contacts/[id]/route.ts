import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json()

    const { data, error } = await supabase
      .from('contacts')
      .update({
        name: body.name,
        email: body.email || null,
        company: body.company || null,
        role: body.role || null,
        location: body.location || null,
        linkedin_url: body.linkedin_url || null,
        twitter_handle: body.twitter_handle || null,
        notes: body.notes || null,
        tags: body.tags ?? [],
      })
      .eq('id', params.id)
      .eq('user_id', user.id)
      .select()
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, contact: data })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Update failed' },
      { status: 500 }
    )
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const id = params.id

    const { data: emailRows } = await supabase.from('emails').select('id').eq('contact_id', id)
    if (emailRows && emailRows.length > 0) {
      await supabase.from('email_events').delete().in('email_id', emailRows.map((e) => e.id))
    }
    await supabase.from('emails').delete().eq('contact_id', id)

    const { data: convRows } = await supabase.from('conversations').select('id').eq('contact_id', id)
    if (convRows && convRows.length > 0) {
      await supabase.from('conversation_messages').delete().in('conversation_id', convRows.map((c) => c.id))
    }
    await supabase.from('conversations').delete().eq('contact_id', id)
    await supabase.from('contact_research').delete().eq('contact_id', id)

    const { error } = await supabase.from('contacts').delete().eq('id', id).eq('user_id', user.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Delete contact error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Delete failed' },
      { status: 500 }
    )
  }
}
