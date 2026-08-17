// Campaigns and whether each has a reference email.
//
// Read-only, for the campaign picker on the scout page. Deliberately its own
// route rather than a query param on the campaigns list: that list is read by a
// V1 screen and widening it risks a shipped page for the sake of a dropdown.

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { listCampaignsWithReference, ReferenceMigrationMissingError } from '@/lib/campaigns/reference'

export async function GET() {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    return NextResponse.json({ campaigns: await listCampaignsWithReference(user.id) })
  } catch (e) {
    // A missing migration is not an error the picker should shout about — it
    // just means no campaign can carry a reference yet.
    if (e instanceof ReferenceMigrationMissingError) {
      return NextResponse.json({ campaigns: [], migrationMissing: true })
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed' }, { status: 500 })
  }
}
