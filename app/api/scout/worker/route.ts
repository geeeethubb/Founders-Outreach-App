// POST /api/scout/worker — executes one leg of an enqueued scout run, either kind.
// GET  /api/scout/worker — health, for the readiness probe.
//
// See lib/runs/worker-route.ts. Segment config is declared here literally:
// Next reads it from the route file, and a worker with the default function
// ceiling would die mid-claim.

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
