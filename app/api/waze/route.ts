import { NextResponse } from 'next/server'

const UPSTREAM_URL =
  'https://www.waze.com/row-partnerhub-api/partners/11349199295/waze-feeds/c37c11ba-ff9d-4ad5-8ecc-4e4f12e91efb?format=1'

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
