import Script from 'next/script'

export default function Home() {
  return (
    <>

      <div className="loading-overlay" id="loadingOverlay">
        <div className="loading-spinner"></div>
      </div>
      <div className="error-toast" id="errorToast"></div>

      <div className="app-layout">
        {/* Header */}
        <header className="header">
          <div className="header-left">
            <h1>Flood Evolution Monitor</h1>
            <span className="severity-pill severity-0" id="severityPill">Normal</span>
          </div>
          <div className="header-right">
            <div className="status-indicator">
              <div className="status-dot" id="statusDot"></div>
              <span id="lastUpdate">Connecting...</span>
            </div>
            <div className="interval-selector">
              <button className="interval-btn active" data-interval="30000">30s</button>
              <button className="interval-btn" data-interval="60000">1m</button>
              <button className="interval-btn" data-interval="300000">5m</button>
            </div>
            <button className="refresh-btn" id="refreshBtn">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
              Refresh
            </button>
          </div>
        </header>

        {/* Left Column: Charts + Map */}
        <div className="left-column">
          <div className="charts-row">
            <div className="chart-panel">
              <div className="chart-header">
                <span className="chart-label">Flood Evolution</span>
              </div>
              <div className="chart-canvas-wrap">
                <canvas id="floodChart"></canvas>
              </div>
            </div>
            <div className="chart-panel">
              <div className="chart-header">
                <div className="chart-tabs">
                  <button className="chart-tab active" data-chart="rain">Rain</button>
                  <button className="chart-tab" data-chart="distribution">Distribution</button>
                  <button className="chart-tab" data-chart="top10">Top 10</button>
                </div>
              </div>
              <div className="chart-canvas-wrap">
                <canvas id="rainChart"></canvas>
              </div>
            </div>
          </div>
          <div className="map-section">
            <div id="map"></div>
          </div>
        </div>

        {/* Event Panel */}
        <div className="event-panel">
          <div className="panel">
            <div className="panel-header">
              <span className="panel-title">City Overview</span>
            </div>
            <div className="city-trend" id="cityTrend">
              <div className="city-trend-icon" id="cityTrendIcon">-</div>
              <div className="city-trend-text">
                <div className="city-trend-title" id="cityTrendTitle">Loading...</div>
                <div className="city-trend-subtitle" id="cityTrendSubtitle">Analyzing data</div>
              </div>
            </div>
            <div className="summary-grid">
              <div className="summary-card">
                <div className="summary-value" id="activeStations">-</div>
                <div className="summary-label">Stations Raining</div>
              </div>
              <div className="summary-card">
                <div className="summary-value" id="avgRain">-</div>
                <div className="summary-label">Avg 1h (mm)</div>
              </div>
              <div className="summary-card alert" id="floodAlertsCard">
                <div className="summary-value" id="floodAlerts">-</div>
                <div className="summary-label">Flood Alerts</div>
              </div>
              <div className="summary-card attention" id="polygonAlertsCard">
                <div className="summary-value" id="polygonAlerts">-</div>
                <div className="summary-label">Areas Affected</div>
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <span className="panel-title">Rain Stations</span>
              <span className="panel-badge" id="stationCount">0</span>
            </div>
            <div className="filter-controls">
              <button className="filter-btn active" data-sort="rain">By Rain</button>
              <button className="filter-btn" data-sort="name">By Name</button>
              <button className="filter-btn" data-sort="trend">By Trend</button>
            </div>
            <div className="station-list" id="stationList"></div>
          </div>

          <div className="panel" style={{ flex: 1 }}>
            <div className="panel-title">Notable Moments</div>
            <div className="timeline-list" id="notableTimeline">
              <div className="event-empty">Monitoring for events...</div>
            </div>
          </div>
        </div>
      </div>

      <Script src="/app.js" strategy="afterInteractive" />
    </>
  )
}
