// POST /api/career/scout/worker — the older address of the shared worker.
//
// Kept so a dispatch sent by a previous deployment, a saved script or a
// document still lands. The handler is the one in lib/runs/worker-route.ts
// (claim by token, then switch on the run's kind); the segment config is
// declared here literally because Next reads it from the route file.

import type { NextRequest } from 'next/server'
import { workerHealth, workerPost } from '@/lib/runs/worker-route'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(request: NextRequest) {
  return workerPost(request)
}

export async function GET() {
  return workerHealth()
}
