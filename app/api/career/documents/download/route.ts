import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { contentTypeFor, loadDocument } from '@/lib/career/documents/store'

export const dynamic = 'force-dynamic'

/**
 * Streams a generated document to the signed-in user.
 *
 * Storage paths are self-describing (`supabase:career-docs/<user>/…` or
 * `local:<user>/…`) and every one of them begins with the owner's user id, so
 * authorization is a prefix check — a path that names another user's folder is
 * refused before anything is read. The browser never sees a bucket URL.
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const path = new URL(request.url).searchParams.get('path') ?? ''
    if (!path) return NextResponse.json({ error: 'path is required' }, { status: 400 })

    const owned =
      path.startsWith(`supabase:career-docs/${user.id}/`) || path.startsWith(`local:${user.id}/`)
    if (!owned || path.includes('..')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const data = await loadDocument(path)
    if (!data) return NextResponse.json({ error: 'Document not found' }, { status: 404 })

    const filename = path.split('/').pop() ?? 'document'
    const download = new URL(request.url).searchParams.get('inline') ? 'inline' : 'attachment'
    return new NextResponse(new Uint8Array(data), {
      status: 200,
      headers: {
        'Content-Type': contentTypeFor(filename),
        'Content-Disposition': `${download}; filename="${filename.replace(/"/g, '')}"`,
        'Content-Length': String(data.length),
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}
