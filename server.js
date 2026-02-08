const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3000;

// API endpoints to proxy
const APIS = {
    '/api/rain': 'http://websempre.rio.rj.gov.br/json/chuvas',
    '/api/polygons': 'https://octa-api-871238133710.us-central1.run.app/mongo/Polygons/latest',
    '/api/waze': 'https://www.waze.com/row-partnerhub-api/partners/11349199295/waze-feeds/c37c11ba-ff9d-4ad5-8ecc-4e4f12e91efb?format=1'
};

// MIME types
const MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

// Proxy request to external API
function proxyRequest(targetUrl, res) {
    const protocol = targetUrl.startsWith('https') ? https : http;

    const options = {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json'
        }
    };

    protocol.get(targetUrl, options, (proxyRes) => {
        let data = '';
        proxyRes.on('data', chunk => data += chunk);
        proxyRes.on('end', () => {
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(data);
        });
    }).on('error', (err) => {
        console.error(`Error proxying ${targetUrl}:`, err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
    });
}

// Serve static files
function serveStaticFile(filePath, res) {
    const ext = path.extname(filePath);
    const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('File not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': mimeType });
        res.end(data);
    });
}

// Create server
const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url);
    const pathname = parsedUrl.pathname;

    console.log(`${new Date().toISOString()} - ${req.method} ${pathname}`);

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(200, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });
        res.end();
        return;
    }

    // Check if it's an API request
    if (APIS[pathname]) {
        proxyRequest(APIS[pathname], res);
        return;
    }

    // Serve static files
    let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);

    // Security: prevent directory traversal
    if (!filePath.startsWith(__dirname)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    serveStaticFile(filePath, res);
});

server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║     Rain Evolution Monitor - Server Started              ║
╠══════════════════════════════════════════════════════════╣
║                                                          ║
║  🌧️  Server running at: http://localhost:${PORT}           ║
║                                                          ║
║  API Endpoints:                                          ║
║    /api/rain     - Rain stations data                    ║
║    /api/polygons - Polygon status data                   ║
║    /api/waze     - Waze flood alerts                     ║
║                                                          ║
║  Press Ctrl+C to stop the server                         ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
`);
});
