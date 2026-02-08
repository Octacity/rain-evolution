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

// State management
const state = {
    stations: [],
    polygons: [],
    wazeAlerts: [],
    history: [], // Array of { timestamp, avgRain, activeStations, totalRain }
    selectedStation: null,
    refreshInterval: 30000,
    intervalId: null,
    map: null,
    markers: {
        stations: [],
        waze: [],
        polygons: []
    },
    chart: null,
    currentChartType: 'evolution'
};

// Initialize the application
async function init() {
    initMap();
    initChart();
    setupEventListeners();
    await refreshData();
    startAutoRefresh();
}

// Initialize Leaflet map
function initMap() {
    state.map = L.map('map').setView([-22.9068, -43.1729], 11);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        subdomains: 'abcd',
        maxZoom: 19
    }).addTo(state.map);
}

// Initialize Chart.js
function initChart() {
    const ctx = document.getElementById('mainChart').getContext('2d');
    state.chart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: []
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                intersect: false,
                mode: 'index'
            },
            plugins: {
                legend: {
                    display: true,
                    labels: { color: '#94a3b8' }
                }
            },
            scales: {
                x: {
                    grid: { color: '#334155' },
                    ticks: { color: '#94a3b8' }
                },
                y: {
                    grid: { color: '#334155' },
                    ticks: { color: '#94a3b8' }
                }
            }
        }
    });
}

// Setup event listeners
function setupEventListeners() {
    // Refresh button
    document.getElementById('refreshBtn').addEventListener('click', refreshData);

    // Interval buttons
    document.querySelectorAll('.interval-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.interval-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            state.refreshInterval = parseInt(e.target.dataset.interval);
            startAutoRefresh();
        });
    });

    // Tab buttons
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', (e) => {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            e.target.classList.add('active');
            state.currentChartType = e.target.dataset.chart;
            updateChart();
        });
    });

    // Filter buttons
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            renderStationList(e.target.dataset.sort);
        });
    });
}

// Start auto-refresh
function startAutoRefresh() {
    if (state.intervalId) {
        clearInterval(state.intervalId);
    }
    state.intervalId = setInterval(refreshData, state.refreshInterval);
}

// Fetch data from all APIs
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

        // Process rain data
        if (rainData.status === 'fulfilled' && rainData.value) {
            state.stations = rainData.value.objects || [];
        }

        // Process polygon data
        if (polygonData.status === 'fulfilled' && polygonData.value) {
            state.polygons = Array.isArray(polygonData.value) ? polygonData.value : [];
        }

        // Process Waze data - filter for flood alerts only
        if (wazeData.status === 'fulfilled' && wazeData.value) {
            const allAlerts = wazeData.value.alerts || [];
            state.wazeAlerts = allAlerts.filter(a => a.subtype === 'HAZARD_WEATHER_FLOOD');
        }

        // Add to history
        addToHistory();

        // Update UI
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

// Fetch with timeout
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

// Add current state to history
function addToHistory() {
    const activeStations = state.stations.filter(s => s.data?.h01 > 0).length;
    const totalRain = state.stations.reduce((sum, s) => sum + (s.data?.h01 || 0), 0);
    const avgRain = state.stations.length > 0 ? totalRain / state.stations.length : 0;

    state.history.push({
        timestamp: new Date(),
        avgRain: avgRain.toFixed(1),
        activeStations,
        totalRain: totalRain.toFixed(1),
        maxRain: Math.max(...state.stations.map(s => s.data?.h01 || 0))
    });

    // Keep only last 100 data points
    if (state.history.length > 100) {
        state.history.shift();
    }
}

// Update all UI components
function updateUI() {
    updateSummary();
    renderStationList();
    renderPolygonList();
    renderAlertList();
    updateMapMarkers();
    updateChart();
    updateCityTrend();
}

// Calculate and display city-wide rain trend
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
    const avgRecent = recent.reduce((sum, h) => sum + parseFloat(h.avgRain), 0) / recent.length;
    const firstAvg = parseFloat(recent[0].avgRain);
    const lastAvg = parseFloat(recent[recent.length - 1].avgRain);
    const trend = lastAvg - firstAvg;

    const activeCount = state.stations.filter(s => s.data?.h01 > 0).length;
    const heavyCount = state.stations.filter(s => s.data?.h01 > 10).length;

    if (activeCount === 0) {
        iconEl.textContent = '';
        titleEl.textContent = 'No Active Rain';
        titleEl.style.color = '#22c55e';
        subtitleEl.textContent = 'City is dry';
    } else if (trend > 0.5) {
        iconEl.textContent = '';
        titleEl.textContent = 'Rain Intensifying';
        titleEl.style.color = '#ef4444';
        subtitleEl.textContent = `+${trend.toFixed(1)}mm trend | ${activeCount} stations active`;
    } else if (trend < -0.5) {
        iconEl.textContent = '';
        titleEl.textContent = 'Rain Decreasing';
        titleEl.style.color = '#22c55e';
        subtitleEl.textContent = `${trend.toFixed(1)}mm trend | ${activeCount} stations active`;
    } else {
        iconEl.textContent = '';
        titleEl.textContent = 'Rain Stable';
        titleEl.style.color = '#eab308';
        subtitleEl.textContent = `${activeCount} stations with rain`;
    }

    if (heavyCount > 5) {
        titleEl.textContent = 'Heavy Rain Event';
        titleEl.style.color = '#dc2626';
        subtitleEl.textContent = `${heavyCount} stations with >10mm/h`;
    }
}

// Update summary cards
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
    document.getElementById('alertCount').textContent = state.wazeAlerts.length;
    document.getElementById('polygonCount').textContent = affectedPolygons;
}

// Render station list
function renderStationList(sortBy = 'rain') {
    const container = document.getElementById('stationList');

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

        // Calculate trend based on recent measurements
        let trendClass = 'trend-stable';
        let trendIcon = '→';

        if (m05 > 0.5) {
            trendClass = 'trend-up';
            trendIcon = '↑↑';
        } else if (m15 > m05 && m15 > 0) {
            trendClass = 'trend-down';
            trendIcon = '↓';
        } else if (m15 > 0 || m05 > 0) {
            trendClass = 'trend-up';
            trendIcon = '↑';
        }

        let itemClass = 'station-item';
        if (h01 > 10) itemClass += ' heavy';
        else if (h01 > 0) itemClass += ' raining';

        return `
            <div class="${itemClass}" data-station="${station.name}" onclick="focusStation('${station.name}')">
                <span class="station-name">${station.name}</span>
                <span>
                    <span class="station-value">${h01.toFixed(1)}mm</span>
                    <span class="station-trend ${trendClass}">${trendIcon}</span>
                </span>
            </div>
        `;
    }).join('');
}

// Render polygon list (only non-normal status)
function renderPolygonList() {
    const container = document.getElementById('polygonList');

    const affected = state.polygons
        .filter(p => p.status_code > 0)
        .sort((a, b) => b.status_code - a.status_code);

    if (affected.length === 0) {
        container.innerHTML = '<div class="polygon-item"><span class="polygon-info"><span class="polygon-title" style="color: #22c55e;">All areas normal</span></span></div>';
        return;
    }

    container.innerHTML = affected.map(polygon => {
        const status = STATUS_MAP[polygon.status_code] || STATUS_MAP[0];
        return `
            <div class="polygon-item" onclick="focusPolygon('${polygon._id}')">
                <div class="polygon-info">
                    <div class="polygon-title">${polygon.title || polygon.main_neighborhood || 'Unknown Area'}</div>
                    <div class="polygon-subtitle">${polygon.main_route || ''}</div>
                </div>
                <span class="badge ${status.class}">${status.name}</span>
            </div>
        `;
    }).join('');
}

// Render Waze flood alerts
function renderAlertList() {
    const container = document.getElementById('alertList');

    if (state.wazeAlerts.length === 0) {
        container.innerHTML = '<div class="alert-item"><span class="alert-content"><span class="alert-street" style="color: #22c55e;">No flood alerts</span></span></div>';
        return;
    }

    const sorted = [...state.wazeAlerts].sort((a, b) => b.pubMillis - a.pubMillis);

    container.innerHTML = sorted.slice(0, 20).map(alert => {
        const time = new Date(alert.pubMillis).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        return `
            <div class="alert-item" onclick="focusWazeAlert(${alert.location.x}, ${alert.location.y})">
                <span class="alert-icon">🌊</span>
                <div class="alert-content">
                    <div class="alert-street">${alert.street || 'Unknown location'}</div>
                    <div class="alert-time">${time} - ${alert.city || 'Rio de Janeiro'}</div>
                </div>
            </div>
        `;
    }).join('');
}

// Update map markers
function updateMapMarkers() {
    // Clear existing markers
    state.markers.stations.forEach(m => m.remove());
    state.markers.waze.forEach(m => m.remove());
    state.markers.polygons.forEach(m => m.remove());
    state.markers = { stations: [], waze: [], polygons: [] };

    // Add station markers
    state.stations.forEach(station => {
        if (!station.location) return;

        const h01 = station.data?.h01 || 0;
        let color = '#22c55e'; // green for no rain
        let size = 8;

        if (h01 > 20) { color = '#dc2626'; size = 16; } // red for heavy
        else if (h01 > 10) { color = '#ea580c'; size = 14; } // orange
        else if (h01 > 5) { color = '#eab308'; size = 12; } // yellow
        else if (h01 > 0) { color = '#3b82f6'; size = 10; } // blue for light rain

        const marker = L.circleMarker([station.location[0], station.location[1]], {
            radius: size,
            fillColor: color,
            color: '#fff',
            weight: 2,
            fillOpacity: 0.8
        }).addTo(state.map);

        marker.bindPopup(`
            <div class="popup-title">${station.name}</div>
            <div class="popup-row"><span class="popup-label">5 min:</span> ${station.data?.m05 || 0} mm</div>
            <div class="popup-row"><span class="popup-label">15 min:</span> ${station.data?.m15 || 0} mm</div>
            <div class="popup-row"><span class="popup-label">1 hour:</span> ${station.data?.h01 || 0} mm</div>
            <div class="popup-row"><span class="popup-label">3 hours:</span> ${station.data?.h03 || 0} mm</div>
            <div class="popup-row"><span class="popup-label">24 hours:</span> ${station.data?.h24 || 0} mm</div>
            <div class="popup-row"><span class="popup-label">Month:</span> ${station.data?.mes || 0} mm</div>
        `);

        state.markers.stations.push(marker);
    });

    // Add Waze flood alert markers
    state.wazeAlerts.forEach(alert => {
        if (!alert.location) return;

        const marker = L.marker([alert.location.y, alert.location.x], {
            icon: L.divIcon({
                className: 'waze-marker',
                html: '<div style="font-size: 20px;">🌊</div>',
                iconSize: [24, 24],
                iconAnchor: [12, 12]
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

    // Add polygon overlays for non-normal status
    state.polygons.filter(p => p.status_code > 0).forEach(polygon => {
        if (!polygon.geometry || polygon.geometry.length === 0) return;

        const status = STATUS_MAP[polygon.status_code] || STATUS_MAP[0];

        // Convert coordinates from [lng, lat] to [lat, lng] for Leaflet
        const coords = polygon.geometry[0].map(coord => [coord[1], coord[0]]);

        const poly = L.polygon(coords, {
            color: status.color,
            weight: 2,
            fillOpacity: 0.3
        }).addTo(state.map);

        poly.bindPopup(`
            <div class="popup-title">${polygon.title || polygon.main_neighborhood}</div>
            <div class="popup-row"><span class="popup-label">Status:</span> <span style="color: ${status.color}">${polygon.status_name}</span></div>
            <div class="popup-row"><span class="popup-label">Rain 15min:</span> ${polygon.acumulado_chuva_15_min_1 || 0} mm</div>
            <div class="popup-row"><span class="popup-label">Flood count:</span> ${polygon.waze_flood_count || 0}</div>
            <div class="popup-row"><span class="popup-label">Area:</span> ${polygon.area_km2?.toFixed(2) || 0} km²</div>
        `);

        state.markers.polygons.push(poly);
    });
}

// Update chart based on selected type
function updateChart() {
    switch (state.currentChartType) {
        case 'evolution':
            updateEvolutionChart();
            break;
        case 'distribution':
            updateDistributionChart();
            break;
        case 'top10':
            updateTop10Chart();
            break;
    }
}

// Evolution chart - shows rain trend over time
function updateEvolutionChart() {
    if (state.history.length === 0) return;

    const labels = state.history.map(h => h.timestamp.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }));

    state.chart.config.type = 'line';
    state.chart.data = {
        labels,
        datasets: [
            {
                label: 'Average Rain (mm/h)',
                data: state.history.map(h => h.avgRain),
                borderColor: '#3b82f6',
                backgroundColor: 'rgba(59, 130, 246, 0.1)',
                fill: true,
                tension: 0.3
            },
            {
                label: 'Max Rain (mm/h)',
                data: state.history.map(h => h.maxRain),
                borderColor: '#ef4444',
                backgroundColor: 'transparent',
                borderDash: [5, 5],
                tension: 0.3
            },
            {
                label: 'Active Stations',
                data: state.history.map(h => h.activeStations),
                borderColor: '#22c55e',
                backgroundColor: 'transparent',
                yAxisID: 'y1',
                tension: 0.3
            }
        ]
    };

    state.chart.options.scales.y1 = {
        position: 'right',
        grid: { display: false },
        ticks: { color: '#94a3b8' }
    };

    state.chart.update();
}

// Distribution chart - shows rain intensity distribution
function updateDistributionChart() {
    const ranges = [
        { label: 'No Rain (0)', min: 0, max: 0 },
        { label: 'Light (0-2)', min: 0.01, max: 2 },
        { label: 'Moderate (2-5)', min: 2, max: 5 },
        { label: 'Heavy (5-10)', min: 5, max: 10 },
        { label: 'Very Heavy (10-20)', min: 10, max: 20 },
        { label: 'Extreme (>20)', min: 20, max: Infinity }
    ];

    const counts = ranges.map(range => {
        return state.stations.filter(s => {
            const rain = s.data?.h01 || 0;
            if (range.max === 0) return rain === 0;
            return rain > range.min && rain <= range.max;
        }).length;
    });

    state.chart.config.type = 'bar';
    state.chart.data = {
        labels: ranges.map(r => r.label),
        datasets: [{
            label: 'Number of Stations',
            data: counts,
            backgroundColor: ['#22c55e', '#3b82f6', '#eab308', '#ea580c', '#dc2626', '#7c2d12']
        }]
    };

    delete state.chart.options.scales.y1;
    state.chart.update();
}

// Top 10 stations chart
function updateTop10Chart() {
    const top10 = [...state.stations]
        .sort((a, b) => (b.data?.h01 || 0) - (a.data?.h01 || 0))
        .slice(0, 10);

    state.chart.config.type = 'bar';
    state.chart.data = {
        labels: top10.map(s => s.name),
        datasets: [
            {
                label: '1 Hour (mm)',
                data: top10.map(s => s.data?.h01 || 0),
                backgroundColor: '#3b82f6'
            },
            {
                label: '15 Min (mm)',
                data: top10.map(s => s.data?.m15 || 0),
                backgroundColor: '#22c55e'
            }
        ]
    };

    delete state.chart.options.scales.y1;
    state.chart.options.indexAxis = 'y';
    state.chart.update();
    state.chart.options.indexAxis = 'x';
}

// Focus map on station
function focusStation(name) {
    const station = state.stations.find(s => s.name === name);
    if (station && station.location) {
        state.map.setView([station.location[0], station.location[1]], 14);

        // Find and open popup
        state.markers.stations.forEach(marker => {
            if (marker.getPopup().getContent().includes(name)) {
                marker.openPopup();
            }
        });
    }
}

// Focus map on polygon
function focusPolygon(id) {
    const polygon = state.polygons.find(p => p._id === id);
    if (polygon && polygon.lat_centroid && polygon.lng_centroid) {
        state.map.setView([polygon.lat_centroid, polygon.lng_centroid], 14);
    }
}

// Focus map on Waze alert
function focusWazeAlert(lng, lat) {
    state.map.setView([lat, lng], 16);
}

// Update last refresh time
function updateLastRefresh() {
    const now = new Date().toLocaleTimeString('pt-BR');
    document.getElementById('lastUpdate').textContent = `Updated: ${now}`;
    document.getElementById('statusDot').style.background = '#22c55e';
}

// Show/hide loading overlay
function showLoading() {
    document.getElementById('loadingOverlay').classList.remove('hidden');
}

function hideLoading() {
    document.getElementById('loadingOverlay').classList.add('hidden');
}

// Show error toast
function showError(message) {
    const toast = document.getElementById('errorToast');
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', init);

// Make functions available globally for onclick handlers
window.focusStation = focusStation;
window.focusPolygon = focusPolygon;
window.focusWazeAlert = focusWazeAlert;
