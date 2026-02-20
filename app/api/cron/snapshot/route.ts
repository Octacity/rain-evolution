import { NextRequest, NextResponse } from 'next/server'
import { getSupabase, TABLE } from '@/lib/supabase'

export const dynamic = 'force-dynamic'
import type { Station, Polygon, WazeAlert, RainResponse, WazeResponse } from '@/lib/types'

const RAIN_URL = 'http://websempre.rio.rj.gov.br/json/chuvas'
const POLYGONS_URL = 'https://octa-api-871238133710.us-central1.run.app/mongo/Polygons/latest'
const WAZE_URL =
  'https://www.waze.com/row-partnerhub-api/partners/11349199295/waze-feeds/c37c11ba-ff9d-4ad5-8ecc-4e4f12e91efb?format=1'

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Accept: 'application/json',
}

const SIX_HOURS = 6 * 60 * 60 * 1000

function isPointInPolygon(lat: number, lng: number, ring: Array<[number, number]>): boolean {
  let inside = false
  const n = ring.length
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const yi = ring[i][1] // lat
    const xi = ring[i][0] // lng
    const yj = ring[j][1]
    const xj = ring[j][0]
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

function countAlertsInAffectedAreas(wazeAlerts: WazeAlert[], polygons: Polygon[]): number {
  const affected = polygons.filter((p) => p.status_code > 0 && p.geometry?.length > 0)
  if (affected.length === 0) return 0

  let count = 0
  for (const alert of wazeAlerts) {
    if (!alert.location) continue
    const lat = alert.location.y
    const lng = alert.location.x
    for (const poly of affected) {
      if (isPointInPolygon(lat, lng, poly.geometry[0])) {
        count++
        break
      }
    }
  }
  return count
}

function computeSeverity(
  polygons: Polygon[],
  wazeFloodCount: number,
  affectedAreaCount: number,
  alertsInAreasCount: number
): number {
  const maxPolygonSeverity =
    polygons.length > 0 ? Math.max(...polygons.map((p) => p.status_code)) : 0

  if (maxPolygonSeverity >= 3) return 3
  if (alertsInAreasCount > 5 || affectedAreaCount > 10) return 2
  if (affectedAreaCount > 0 || wazeFloodCount > 10) return 1
  return 0
}

export async function GET(req: NextRequest) {
  // Auth check
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Fetch all three upstream APIs in parallel
  const [rainRes, polygonsRes, wazeRes] = await Promise.allSettled([
    fetch(RAIN_URL, { headers: FETCH_HEADERS }),
    fetch(POLYGONS_URL, { headers: FETCH_HEADERS }),
    fetch(WAZE_URL, { headers: FETCH_HEADERS }),
  ])

  if (rainRes.status === 'rejected' || polygonsRes.status === 'rejected') {
    return NextResponse.json({ error: 'Upstream fetch failed (rain or polygons)' }, { status: 502 })
  }

  const rainData: RainResponse = await rainRes.value.json()
  const polygonsData: Polygon[] = await polygonsRes.value.json()
  const wazeData: WazeResponse = wazeRes.status === 'fulfilled'
    ? await wazeRes.value.json().catch(() => ({ alerts: [] }))
    : { alerts: [] }

  const stations: Station[] = rainData.objects || []
  const polygons: Polygon[] = Array.isArray(polygonsData) ? polygonsData : []
  const allAlerts: WazeAlert[] = wazeData.alerts || []
  const floodAlerts = allAlerts.filter((a) => a.subtype === 'HAZARD_WEATHER_FLOOD')

  // Rain guard: need at least 3 flood alerts started in the last 6 hours
  const recentFlood = floodAlerts.filter((a) => a.pubMillis > Date.now() - SIX_HOURS)
  if (recentFlood.length < 3) {
    return NextResponse.json({ skipped: true, reason: 'rain_guard', recentFloodCount: recentFlood.length })
  }

  // Compute metrics
  const wazeFloodCount = floodAlerts.length
  const affectedAreaCount = polygons.filter((p) => p.status_code > 0).length
  const alertsInAreasCount = countAlertsInAffectedAreas(floodAlerts, polygons)

  const totalRain = stations.reduce((sum, s) => sum + (s.data?.h01 || 0), 0)
  const avg_rain = stations.length > 0 ? parseFloat((totalRain / stations.length).toFixed(2)) : 0
  const max_rain = stations.length > 0 ? Math.max(...stations.map((s) => s.data?.h01 || 0)) : 0

  const severity = computeSeverity(polygons, wazeFloodCount, affectedAreaCount, alertsInAreasCount)

  // Insert into Supabase
  const { error } = await getSupabase().from(TABLE()).insert({
    waze_count: wazeFloodCount,
    affected_areas: affectedAreaCount,
    alerts_in_areas: alertsInAreasCount,
    avg_rain,
    max_rain,
    severity,
    raw: { waze: wazeData, polygons: polygonsData, rain: rainData },
  })

  if (error) {
    console.error('Supabase insert error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    ok: true,
    waze_count: wazeFloodCount,
    affected_areas: affectedAreaCount,
    alerts_in_areas: alertsInAreasCount,
    avg_rain,
    max_rain,
    severity,
  })
}
