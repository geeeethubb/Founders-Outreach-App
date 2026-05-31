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
      .eq('user_id', user