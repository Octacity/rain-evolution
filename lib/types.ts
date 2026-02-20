export interface StationData {
  m05: number
  m15: number
  h01: number
  h02: number
  h03: number
  h04: number
  h24: number
  h96: number
  mes: number
}

export interface Station {
  kind: string
  read_at: string
  name: string
  is_new: boolean
  location: [number, number]
  data: StationData
}

export interface RainResponse {
  objects: Station[]
}

export interface Polygon {
  _id: string
  title: string
  main_neighborhood: string
  status_code: number
  status_name: string
  geometry: Array<Array<[number, number]>>
  lat_centroid: number
  lng_centroid: number
  area_km2: number
  waze_flood_count: number
  acumulado_chuva_15_min_1: number
}

export interface WazeAlert {
  uuid: string
  type: string
  subtype: string
  street: string
  city: string
  country: string
  location: { x: number; y: number }
  pubMillis: number
  reliability: number
  confidence: number
}

export interface WazeResponse {
  alerts: WazeAlert[]
}

export interface FloodMetrics {
  wazeFloodCount: number
  affectedAreaCount: number
  alertsInAreasCount: number
}

export interface SnapshotRow {
  captured_at: string
  waze_count: number
  affected_areas: number
  alerts_in_areas: number
  avg_rain: number
  max_rain: number
  severity: number
}
