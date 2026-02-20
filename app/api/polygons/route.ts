import { NextResponse } from 'next/server'

const UPSTREAM_URL = 'https://octa-api-871238133710.us-central1.run.app/mongo/Polygons/latest'

export async function GET() {
  try {
    const res = await fetch(UPSTREAM_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'application/json',
      },
      next: { revalidate: 0 },
    })
    const data = await res.json()
    return NextResponse.json(data)
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 502 })
  }
}
