// API endpoints (through proxy to avoid CORS)
const API = {
    WAZE: '/api/waze',
    POLYGONS: '/api/polygons',
    RAIN: '/api/rain'
};

// Status codes mapping
const STATUS_MAP = {
    0: { name: 'Normal', color: '#22c55e', class: 'badge-normal' },
    1: { name: 'Attention', color: '#eab308', class: 'badge-attention' },
    2: { name: 'Alert', color: '#ea580c', class: 'badge-alert' },
    3: { name: 'Critical', color: '#dc2626', class: 'badge-critical' }
};

// Severity thresholds
const SEVERITY_THRESHOLDS = {
    criticalPolygonStatus: 3,
    alertAlertsInAreas: 5,
    alertAffectedAreas: 10,
    attentionWazeAlerts: 10,
    notableAlertSpike: 5,
    notableMaxEvents: 50
};

// State management
const state = {
    stations: [],
    polygons: [],
    wazeAlerts: [],
    history: [],
    floodMetrics: { wazeFloodCount: 0, affectedAreaCount: 0, alertsInAreasCount: 0 },
    notableEvents: [],
    refreshInterval: 30000,
    intervalId: null,
    map: null,
    markers: {
        stations: [],
        waze: [],
        polygons: []
    },
    floodChart: null,
    rainChart: null,
    currentRainChartType: 'rain'
};

// --- Core Flood Algorithms ---

function isPointInPolygon(lat, lng, ring) {
    let inside = false;
    const n = ring.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const yi = ring[i][1]; // lat
        const xi = ring[i][0]; // lng
        const yj = ring[j][1];
        const xj = ring[j][0];
        if (((yi > lat) !== (yj > lat)) &&
            (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
            inside = !inside;
        }
    }
    return inside;
}

function countAlertsInAffectedAreas(wazeAlerts, polygons) {
    const affected = polygons.filter(p => p.status_code > 0 && p.geometry?.length > 0);
    if (affected.length === 0) return 0;

    let count = 0;
    for (const alert of wazeAlerts) {
        if (!alert.location) continue;
        const lat = alert.location.y;
        const lng = alert.location.x;
        for (const poly of affected) {
            if (isPointInPolygon(lat, lng, poly.geometry[0])) {
                count++;
                break;
            }
        }
    }
    return count;
}

function computeFloodMetrics() {
    state.floodMetrics = {
        wazeFloodCount: state.wazeAlerts.length,
        affectedAreaCount: state.polygons.filter(p => p.status_code > 0).length,
        alertsInAreasCount: countAlertsInAffectedAreas(state.wazeAlerts, state.polygons)
    };
}

function computeOverallSeverity() {
    const m = state.floodMetrics;
    const maxPolygonSeverity = state.polygons.length > 0
        ? Math.max(...state.polygons.map(p => p.status_code))
        : 0;

    if (maxPolygonSeverity >= SEVERITY_THRESHOLDS.criticalPolygonStatus)
        return { level: 3, label: 'Critical', color: '#dc2626' };
    if (m.alertsInAreasCount > SEVERITY_THRESHOLDS.alertAlertsInAreas || m.affectedAreaCount > SEVERITY_THRESHOLDS.alertAffectedAreas)
        return { level: 2, label: 'Alert', color: '#ea580c' };
    if (m.affectedAreaCount > 0 || m.wazeFloodCount > SEVERITY_THRESHOLDS.attentionWazeAlerts)
        return { level: 1, label: 'Attention', color: '#eab308' };
    return { level: 0, label: 'Normal', color: '#22c55e' };
}

// --- History & Notable Events ---

function addToHistory() {
    const activeStations = state.stations.filter(s => s.data?.h01 > 0).length;
    const totalRain = state.stations.reduce((sum, s) => sum + (s.data?.h01 || 0), 0);
    const avgRain = state.stations.length > 0 ? totalRain / state.stations.length : 0;

    state.history.push({
        timestamp: new Date(),
        wazeFloodCount: state.floodMetrics.wazeFloodCount,
        affectedAreaCount: state.floodMetrics.affectedAreaCount,
        alertsInAreasCount: state.floodMetrics.alertsInAreasCount,
        avgRain: parseFloat(avgRain.toFixed(1)),
        maxRain: Math.max(0, ...state.stations.map(s => s.data?.h01 || 0)),
        activeStations,
        maxSeverity: computeOverallSeverity().level
    });

    if (state.history.length > 100) {
        state.history.shift();
    }

    detectNotableEvents();
}

function detectNotableEvents() {
    if (state.history.length < 2) return;

    const prev = state.history[state.history.length - 2];
    const curr = state.history[state.history.length - 1];
    const time = curr.timestamp;

    const alertDelta = curr.wazeFloodCount - prev.wazeFloodCount;
    const areaDelta = curr.affectedAreaCount - prev.affectedAreaCount;
    const overlapDelta = curr.alertsInAreasCount - prev.alertsInAreasCount;

    if (alertDelta > 0 && areaDelta > 0 && overlapDelta > 0) {
        state.notableEvents.push({
            timestamp: time,
            message: `Flood convergence — alerts, areas, and overlap all rising`,
            severity: 'critical'
        });
    } else {
        if (alertDelta >= SEVERITY_THRESHOLDS.notableAlertSpike) {
            state.notableEvents.push({
                timestamp: time,
                message: `+${alertDelta} new flood alerts reported`,
                severity: 'alert'
            });
        }
        if (areaDelta > 0) {
            state.notableEvents.push({
                timestamp: time,
                message: `${areaDelta} new area(s) entered affected status`,
                severity: 'attention'
            });
        } else if (areaDelta < 0) {
            state.notableEvents.push({
                timestamp: time,
                message: `${Math.abs(areaDelta)} area(s) returned to normal`,
                severity: 'normal'
            });
        }
    }

    if (state.notableEvents.length > SEVERITY_THRESHOLDS.notableMaxEvents) {
        state.notableEvents = state.notableEvents.slice(-SEVERITY_THRESHOLDS.notableMaxEvents);
    }
}

// --- Initialization ---

async function init() {
    initMap();
    initFloodChart();
    initRainChart();
    setupEventListeners();
    await refreshData();
    startAutoRefresh();
}

function initMap() {
    state.map = L.map('map').setView([-22.9068, -43.1729], 11);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        subdomains: 'abcd',
        maxZoom: 19
    }).addTo(state.map);
}

function createChartOptions() {
    return {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: 'index' },
        plugins: {
            legend: {
                display: true,
                position: 'top',
                labels: {
                    color: '#94a3b8',
                    usePointStyle: true,
                    padding: 12,
                    font: { size: 10 }
                }
            },
            tooltip: {
                backgroundColor: '#1e293b',
                titleColor: '#e2e8f0',
                bodyColor: '#94a3b8',
                borderColor: '#334155',
                borderWidth: 1,
                padding: 10
            }
        },
        scales: {
            x: {
                grid: { color: 'rgba(51, 65, 85, 0.5)' },
                ticks: { color: '#94a3b8', font: { size: 10 } }
            },
            y: {
                position: 'left',
                grid: { color: 'rgba(51, 65, 85, 0.5)' },
                ticks: { color: '#94a3b8' },
                beginAtZero: true
            }
        }
    };
}

function initFloodChart() {
    const ctx = document.getElementById('floodChart').getContext('2d');
    state.floodChart = new Chart(ctx, {
        type: 'line',
        data: { labels: [], datasets: [] },
        options: createChartOptions()
    });
}

function initRainChart() {
    const ctx = document.getElementById('rainChart').getContext('2d');
    state.rainChart = new Chart(ctx, {
        type: 'line',
        data: { labels: [], datasets: [] },
        options: createChartOptions()
    });
}

function setupEventListeners() {
    document.getElementById('refreshBtn').addEventListener('click', refreshData);

    document.querySelectorAll('.interval-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.interval-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            state.refreshInterval = parseInt(e.target.dataset.interval);
            startAutoRefresh();
        });
    });

    document.querySelectorAll('.chart-tab').forEach(tab => {
        tab.addEventListener('click', (e) => {
            document.querySelectorAll('.chart-tab').forEach(t => t.classList.remove('active'));
            e.target.classList.add('active');
            state.currentRainChartType = e.target.dataset.chart;
            updateRainChartView();
        });
    });

    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            renderStationList(e.target.dataset.sort);
        });
    });
}

function startAutoRefresh() {
    if (state.intervalId) clearInterval(state.intervalId);
    state.intervalId = setInterval(refreshData, state.refreshInterval);
}

// --- Data Fetching ---

async function refreshData() {
    const btn = document.getElementById('refreshBtn');
    btn.disabled = true;

    try {
        showLoading();

        const [rainData, polygonData, wazeData] = await Promise.allSettled([
            fetchWithTimeout(API.RAIN),
            fetchWithTimeout(API.POLYGONS),
            fetchWithTimeout(API.WAZE)
        ]);

        if (rainData.status === 'fulfilled' && rainData.value) {
            state.stations = rainData.value.objects || [];
        }
        if (polygonData.status === 'fulfilled' && polygonData.value) {
            state.polygons = Array.isArray(polygonData.value) ? polygonData.value : [];
        }
        if (wazeData.status === 'fulfilled' && wazeData.value) {
            const allAlerts = wazeData.value.alerts || [];
            state.wazeAlerts = allAlerts.filter(a => a.subtype === 'HAZARD_WEATHER_FLOOD');
        }

        computeFloodMetrics();
        addToHistory();
        updateUI();
        updateLastRefresh();
        hideLoading();
    } catch (error) {
        console.error('Error refreshing data:', error);
        showError('Failed to fetch data. Retrying...');
        hideLoading();
    }

    btn.disabled = false;
}

async function fetchWithTimeout(url, timeout = 10000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        return await response.json();
    } catch (error) {
        clearTimeout(timeoutId);
        throw error;
    }
}

// --- UI Updates ---

function updateUI() {
    updateCityTrend();
    updateSummary();
    renderStationList();
    updateNotableTimeline();
    updateMapMarkers();
    updateFloodChart();
    updateRainChartView();
}

function updateCityTrend() {
    const iconEl = document.getElementById('cityTrendIcon');
    const titleEl = document.getElementById('cityTrendTitle');
    const subtitleEl = document.getElementById('cityTrendSubtitle');

    if (state.history.length < 2) {
        iconEl.textContent = '?';
        titleEl.textContent = 'Analyzing...';
        subtitleEl.textContent = 'Need more data points';
        return;
    }

    const recent = state.history.slice(-5);
    const firstAvg = recent[0].avgRain;
    const lastAvg = recent[recent.length - 1].avgRain;
    const trend = lastAvg - firstAvg;

    const activeCount = state.stations.filter(s => s.data?.h01 > 0).length;
    const heavyCount = state.stations.filter(s => s.data?.h01 > 10).length;

    if (activeCount === 0) {
        iconEl.textContent = '\u2600\uFE0F';
        titleEl.textContent = 'No Active Rain';
        titleEl.style.color = '#22c55e';
        subtitleEl.textContent = 'City is dry';
    } else if (trend > 0.5) {
        iconEl.textContent = '\u26C8\uFE0F';
        titleEl.textContent = 'Rain Intensifying';
        titleEl.style.color = '#ef4444';
        subtitleEl.textContent = `+${trend.toFixed(1)}mm trend | ${activeCount} stations active`;
    } else if (trend < -0.5) {
        iconEl.textContent = '\uD83C\uDF24\uFE0F';
        titleEl.textContent = 'Rain Decreasing';
        titleEl.style.color = '#22c55e';
        subtitleEl.textContent = `${trend.toFixed(1)}mm trend | ${activeCount} stations active`;
    } else {
        iconEl.textContent = '\uD83C\uDF27\uFE0F';
        titleEl.textContent = 'Rain Stable';
        titleEl.style.color = '#eab308';
        subtitleEl.textContent = `${activeCount} stations with rain`;
    }

    if (heavyCount > 5) {
        iconEl.textContent = '\u26A0\uFE0F';
        titleEl.textContent = 'Heavy Rain Event';
        titleEl.style.color = '#dc2626';
        subtitleEl.textContent = `${heavyCount} stations with >10mm/h`;
    }

    // Update header severity pill from flood metrics
    const severity = computeOverallSeverity();
    const pillEl = document.getElementById('severityPill');
    pillEl.className = `severity-pill severity-${severity.level}`;
    pillEl.textContent = severity.label;
}

function updateSummary() {
    const activeStations = state.stations.filter(s => s.data?.h01 > 0).length;
    const totalRain = state.stations.reduce((sum, s) => sum + (s.data?.h01 || 0), 0);
    const avgRain = state.stations.length > 0 ? (totalRain / state.stations.length).toFixed(1) : '0';
    const affectedPolygons = state.polygons.filter(p => p.status_code > 0).length;

    document.getElementById('activeStations').textContent = activeStations;
    document.getElementById('avgRain').textContent = avgRain;
    document.getElementById('floodAlerts').textContent = state.wazeAlerts.length;
    document.getElementById('polygonAlerts').textContent = affectedPolygons;
    document.getElementById('stationCount').textContent = state.stations.length;
}

function updateNotableTimeline() {
    const container = document.getElementById('notableTimeline');

    if (state.notableEvents.length === 0) {
        container.innerHTML = '<div class="event-empty">Monitoring for events...</div>';
        return;
    }

    const recent = [...state.notableEvents].reverse().slice(0, 10);
    container.innerHTML = recent.map(event => {
        const time = event.timestamp.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const severityColors = {
            critical: '#dc2626',
            alert: '#ea580c',
            attention: '#eab308',
            normal: '#22c55e'
        };
        const color = severityColors[event.severity] || '#94a3b8';
        return `
            <div class="timeline-item">
                <div class="timeline-dot" style="background: ${color}"></div>
                <div class="timeline-content">
                    <span class="timeline-time">${time}</span>
                    <span class="timeline-msg">${event.message}</span>
                </div>
            </div>
        `;
    }).join('');
}

// --- Chart ---

// --- Flood Chart (always visible, left panel) ---

function updateFloodChart() {
    if (state.history.length === 0) return;

    const chart = state.floodChart;
    const labels = state.history.map(h =>
        h.timestamp.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    );

    chart.options.scales.y.title = { display: true, text: 'Areas / Overlap', color: '#94a3b8' };
    chart.options.scales.y1 = {
        position: 'right',
        title: { display: true, text: 'Waze Alerts', color: '#f97316' },
        grid: { display: false },
        ticks: { color: '#f97316' },
        beginAtZero: true
    };

    chart.data = {
        labels,
        datasets: [
            {
                label: 'Affected Areas',
                data: state.history.map(h => h.affectedAreaCount),
                borderColor: '#eab308',
                backgroundColor: 'rgba(234, 179, 8, 0.08)',
                fill: false,
                tension: 0.3,
                pointRadius: 3,
                pointBackgroundColor: '#eab308',
                borderWidth: 2,
                yAxisID: 'y'
            },
            {
                label: 'Alerts in Areas',
                data: state.history.map(h => h.alertsInAreasCount),
                borderColor: '#dc2626',
                backgroundColor: 'rgba(220, 38, 38, 0.15)',
                fill: true,
                tension: 0.3,
                pointRadius: 4,
                pointBackgroundColor: '#dc2626',
                borderWidth: 2.5,
                yAxisID: 'y'
            },
            {
                label: 'Waze Alerts',
                data: state.history.map(h => h.wazeFloodCount),
                borderColor: '#f97316',
                backgroundColor: 'rgba(249, 115, 22, 0.08)',
                fill: false,
                tension: 0.3,
                pointRadius: 3,
                pointBackgroundColor: '#f97316',
                borderWidth: 2,
                yAxisID: 'y1'
            }
        ]
    };

    chart.update();
}

// --- Rain Chart (right panel, tabbed) ---

function resetRainChartScales() {
    const opts = state.rainChart.options;
    opts.indexAxis = 'x';
    delete opts.scales.y1;
    opts.scales.x = {
        grid: { color: 'rgba(51, 65, 85, 0.5)' },
        ticks: { color: '#94a3b8', font: { size: 10 } }
    };
    opts.scales.y = {
        position: 'left',
        grid: { color: 'rgba(51, 65, 85, 0.5)' },
        ticks: { color: '#94a3b8' },
        beginAtZero: true
    };
}

function updateRainChartView() {
    switch (state.currentRainChartType) {
        case 'rain': updateRainEvolutionChart(); break;
        case 'distribution': updateDistributionChart(); break;
        case 'top10': updateTop10Chart(); break;
    }
}

function updateRainEvolutionChart() {
    if (state.history.length === 0) return;

    const chart = state.rainChart;
    const labels = state.history.map(h =>
        h.timestamp.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    );

    chart.config.type = 'line';
    resetRainChartScales();

    chart.options.scales.y.title = { display: true, text: 'Rain (mm/h)', color: '#94a3b8' };
    chart.options.scales.y1 = {
        position: 'right',
        title: { display: true, text: 'Stations', color: '#22c55e' },
        grid: { display: false },
        ticks: { color: '#22c55e' },
        beginAtZero: true
    };

    chart.data = {
        labels,
        datasets: [
            {
                label: 'Avg Rain (mm/h)',
                data: state.history.map(h => h.avgRain),
                borderColor: '#3b82f6',
                backgroundColor: 'rgba(59, 130, 246, 0.1)',
                fill: true,
                tension: 0.3,
                pointRadius: 3,
                borderWidth: 2,
                yAxisID: 'y'
            },
            {
                label: 'Max Rain (mm/h)',
                data: state.history.map(h => h.maxRain),
                borderColor: '#ef4444',
                backgroundColor: 'transparent',
                borderDash: [5, 5],
                fill: false,
                tension: 0.3,
                pointRadius: 2,
                borderWidth: 1.5,
                yAxisID: 'y'
            },
            {
                label: 'Active Stations',
                data: state.history.map(h => h.activeStations),
                borderColor: '#22c55e',
                backgroundColor: 'transparent',
                fill: false,
                tension: 0.3,
                pointRadius: 3,
                borderWidth: 2,
                yAxisID: 'y1'
            }
        ]
    };

    chart.update();
}

function updateDistributionChart() {
    const chart = state.rainChart;
    const ranges = [
        { label: 'None (0)', min: 0, max: 0 },
        { label: 'Light (0-2)', min: 0.01, max: 2 },
        { label: 'Mod (2-5)', min: 2, max: 5 },
        { label: 'Heavy (5-10)', min: 5, max: 10 },
        { label: 'V.Heavy (10-20)', min: 10, max: 20 },
        { label: 'Extreme (>20)', min: 20, max: Infinity }
    ];

    const counts = ranges.map(range => {
        return state.stations.filter(s => {
            const rain = s.data?.h01 || 0;
            if (range.max === 0) return rain === 0;
            return rain > range.min && rain <= range.max;
        }).length;
    });

    chart.config.type = 'bar';
    resetRainChartScales();
    chart.options.scales.y.title = { display: true, text: 'Stations', color: '#94a3b8' };

    chart.data = {
        labels: ranges.map(r => r.label),
        datasets: [{
            label: 'Stations',
            data: counts,
            backgroundColor: ['#22c55e', '#3b82f6', '#eab308', '#ea580c', '#dc2626', '#7c2d12']
        }]
    };

    chart.update();
}

function updateTop10Chart() {
    const chart = state.rainChart;
    const top10 = [...state.stations]
        .sort((a, b) => (b.data?.h01 || 0) - (a.data?.h01 || 0))
        .slice(0, 10);

    chart.config.type = 'bar';
    resetRainChartScales();
    chart.options.indexAxis = 'y';

    chart.data = {
        labels: top10.map(s => s.name),
        datasets: [
            {
                label: '1h (mm)',
                data: top10.map(s => s.data?.h01 || 0),
                backgroundColor: '#3b82f6'
            },
            {
                label: '15m (mm)',
                data: top10.map(s => s.data?.m15 || 0),
                backgroundColor: '#22c55e'
            }
        ]
    };

    chart.update();
}

// --- Station & Alert Lists ---

function renderStationList(sortBy = 'rain') {
    const container = document.getElementById('stationList');
    document.getElementById('stationCount').textContent = state.stations.length;

    let sorted = [...state.stations];

    switch (sortBy) {
        case 'rain':
            sorted.sort((a, b) => (b.data?.h01 || 0) - (a.data?.h01 || 0));
            break;
        case 'name':
            sorted.sort((a, b) => a.name.localeCompare(b.name));
            break;
        case 'trend':
            sorted.sort((a, b) => {
                const trendA = (a.data?.m15 || 0) - (a.data?.m05 || 0);
                const trendB = (b.data?.m15 || 0) - (b.data?.m05 || 0);
                return trendB - trendA;
            });
            break;
    }

    container.innerHTML = sorted.map(station => {
        const h01 = station.data?.h01 || 0;
        const m15 = station.data?.m15 || 0;
        const m05 = station.data?.m05 || 0;

        let trendClass = 'trend-stable';
        let trendIcon = '\u2192';

        if (m05 > 0.5) {
            trendClass = 'trend-up';
            trendIcon = '\u2191\u2191';
        } else if (m15 > m05 && m15 > 0) {
            trendClass = 'trend-down';
            trendIcon = '\u2193';
        } else if (m15 > 0 || m05 > 0) {
            trendClass = 'trend-up';
            trendIcon = '\u2191';
        }

        let itemClass = 'station-item';
        if (h01 > 10) itemClass += ' heavy';
        else if (h01 > 0) itemClass += ' raining';

        return `
            <div class="${itemClass}" onclick="focusStation('${station.name}')">
                <span class="station-name">${station.name}</span>
                <span>
                    <span class="station-value">${h01.toFixed(1)}mm</span>
                    <span class="station-trend ${trendClass}">${trendIcon}</span>
                </span>
            </div>
        `;
    }).join('');
}


// --- Map ---

function updateMapMarkers() {
    state.markers.stations.forEach(m => m.remove());
    state.markers.waze.forEach(m => m.remove());
    state.markers.polygons.forEach(m => m.remove());
    state.markers = { stations: [], waze: [], polygons: [] };

    // All polygons — faint for normal, bright for affected
    state.polygons.forEach(polygon => {
        if (!polygon.geometry || polygon.geometry.length === 0) return;

        const coords = polygon.geometry[0].map(coord => [coord[1], coord[0]]);
        const isAffected = polygon.status_code > 0;
        const status = STATUS_MAP[polygon.status_code] || STATUS_MAP[0];

        const poly = L.polygon(coords, {
            color: isAffected ? status.color : '#334155',
            weight: isAffected ? 2 : 0.5,
            fillColor: isAffected ? status.color : 'transparent',
            fillOpacity: isAffected ? 0.3 : 0
        }).addTo(state.map);

        if (isAffected) {
            poly.bindPopup(`
                <div class="popup-title">${polygon.title || polygon.main_neighborhood}</div>
                <div class="popup-row"><span class="popup-label">Status:</span> <span style="color: ${status.color}">${polygon.status_name}</span></div>
                <div class="popup-row"><span class="popup-label">Rain 15min:</span> ${polygon.acumulado_chuva_15_min_1 || 0} mm</div>
                <div class="popup-row"><span class="popup-label">Waze floods:</span> ${polygon.waze_flood_count || 0}</div>
                <div class="popup-row"><span class="popup-label">Area:</span> ${polygon.area_km2?.toFixed(2) || 0} km2</div>
            `);
        }

        state.markers.polygons.push(poly);
    });

    // Waze flood markers — prominent
    state.wazeAlerts.forEach(alert => {
        if (!alert.location) return;

        const marker = L.marker([alert.location.y, alert.location.x], {
            icon: L.divIcon({
                className: 'waze-marker',
                html: '<div style="font-size: 18px; filter: drop-shadow(0 0 4px rgba(220,38,38,0.6));">🌊</div>',
                iconSize: [22, 22],
                iconAnchor: [11, 11]
            })
        }).addTo(state.map);

        const time = new Date(alert.pubMillis).toLocaleString('pt-BR');
        marker.bindPopup(`
            <div class="popup-title">Flood Alert</div>
            <div class="popup-row"><span class="popup-label">Street:</span> ${alert.street || 'Unknown'}</div>
            <div class="popup-row"><span class="popup-label">City:</span> ${alert.city || 'Rio de Janeiro'}</div>
            <div class="popup-row"><span class="popup-label">Time:</span> ${time}</div>
            <div class="popup-row"><span class="popup-label">Reliability:</span> ${alert.reliability}/10</div>
        `);

        state.markers.waze.push(marker);
    });

    // Station markers — subdued
    state.stations.forEach(station => {
        if (!station.location) return;

        const h01 = station.data?.h01 || 0;
        let color = '#475569';
        let size = 4;

        if (h01 > 20) { color = '#dc2626'; size = 8; }
        else if (h01 > 10) { color = '#ea580c'; size = 7; }
        else if (h01 > 5) { color = '#eab308'; size = 6; }
        else if (h01 > 0) { color = '#3b82f6'; size = 5; }

        const marker = L.circleMarker([station.location[0], station.location[1]], {
            radius: size,
            fillColor: color,
            color: 'rgba(255,255,255,0.3)',
            weight: 1,
            fillOpacity: 0.6
        }).addTo(state.map);

        marker.bindPopup(`
            <div class="popup-title">${station.name}</div>
            <div class="popup-row"><span class="popup-label">5 min:</span> ${station.data?.m05 || 0} mm</div>
            <div class="popup-row"><span class="popup-label">15 min:</span> ${station.data?.m15 || 0} mm</div>
            <div class="popup-row"><span class="popup-label">1 hour:</span> ${station.data?.h01 || 0} mm</div>
            <div class="popup-row"><span class="popup-label">3 hours:</span> ${station.data?.h03 || 0} mm</div>
            <div class="popup-row"><span class="popup-label">24 hours:</span> ${station.data?.h24 || 0} mm</div>
        `);

        state.markers.stations.push(marker);
    });
}

// --- Navigation ---

function focusStation(name) {
    const station = state.stations.find(s => s.name === name);
    if (station && station.location) {
        state.map.setView([station.location[0], station.location[1]], 14);
        state.markers.stations.forEach(marker => {
            if (marker.getPopup()?.getContent()?.includes(name)) {
                marker.openPopup();
            }
        });
    }
}

function focusPolygon(id) {
    const polygon = state.polygons.find(p => p._id === id);
    if (polygon && polygon.lat_centroid && polygon.lng_centroid) {
        state.map.setView([polygon.lat_centroid, polygon.lng_centroid], 14);
        state.markers.polygons.forEach(marker => {
            if (marker.getPopup()?.getContent()?.includes(id)) {
                marker.openPopup();
            }
        });
    }
}

function focusWazeAlert(lng, lat) {
    state.map.setView([lat, lng], 16);
}

// --- Utilities ---

function updateLastRefresh() {
    const now = new Date().toLocaleTimeString('pt-BR');
    document.getElementById('lastUpdate').textContent = `Updated: ${now}`;
    document.getElementById('statusDot').style.background = '#22c55e';
}

function showLoading() {
    document.getElementById('loadingOverlay').classList.remove('hidden');
}

function hideLoading() {
    document.getElementById('loadingOverlay').classList.add('hidden');
}

function showError(message) {
    const toast = document.getElementById('errorToast');
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
}

// --- Bootstrap ---

document.addEventListener('DOMContentLoaded', init);

window.focusStation = focusStation;
window.focusPolygon = focusPolygon;
window.focusWazeAlert = focusWazeAlert;
