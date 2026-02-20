import { NextRequest, NextResponse } from 'next/server'
import { getSupabase, TABLE } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const limit = parseInt(searchParams.get('limit') ?? '100')

  const { data, error } = await getSupabase()
    .from(TABLE())
    .select('captured_at, waze_count, affected_areas, alerts_in_areas, avg_rain, max_rain, severity')
    .order('captured_at', { ascending: true })
    .limit(limit)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(data)
}
