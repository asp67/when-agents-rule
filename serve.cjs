#!/usr/bin/env node
// Serve When Agents Rule from this folder. Node built-ins only -- nothing is downloaded.
//
//   node serve.cjs                 http://localhost:8088, this computer only
//   node serve.cjs --open          ...and open it in the default browser
//   node serve.cjs --port 9000     another port
//   node serve.cjs --host 0.0.0.0  also reachable from other devices on your network
//
// Loopback by default on purpose: the model library keeps API keys in the page's
// storage, and a server other devices can reach is a different proposition. The port
// is 8088 because 8080 is where llama.cpp listens by default, and a model server and
// the game on the same port is the most common first-run collision.
'use strict';
const fs = require('node:fs'), http = require('node:http'), path = require('node:path'), os = require('node:os');

const ROOT = __dirname;
const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.jsonl': 'application/x-ndjson; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.gif': 'image/gif', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

function createServer(root = ROOT) {
    root = path.resolve(root);
    return http.createServer((req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
        let rel;
        try { rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
        catch (e) { res.writeHead(400); return res.end(); }
        rel = rel.replace(/^\/+/, '') || 'index.html';
        const file = path.resolve(root, rel);
        // Nothing outside this folder, however the path is spelled.
        if (!file.startsWith(root + path.sep) || rel.split(/[\\/]/).some(p => p.startsWith('.') && p !== '.')) {
            res.writeHead(404); return res.end();
        }
        let stat;
        try { stat = fs.statSync(file); } catch (e) { res.writeHead(404); return res.end(); }
        if (!stat.isFile()) { res.writeHead(404); return res.end(); }
        // Revalidate on every load: an updated game is picked up at once, an unchanged
        // one costs a 304. Asset URLs carry ?v= cache-busters as well.
        const modified = stat.mtime.toUTCString();
        const headers = { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
                          'Last-Modified': modified, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
        const since = req.headers['if-modified-since'];
        if (since && Math.floor(stat.mtimeMs / 1000) <= Math.floor(Date.parse(since) / 1000)) {
            res.writeHead(304, headers); return res.end();
        }
        headers['Content-Length'] = stat.size;
        res.writeHead(200, headers);
        if (req.method === 'HEAD') return res.end();
        fs.createReadStream(file).pipe(res);
    });
}

function main(argv) {
    const opt = { port: 8088, host: '127.0.0.1', open: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--port') opt.port = Number(argv[++i]);
        else if (argv[i] === '--host') opt.host = String(argv[++i] || '');
        else if (argv[i] === '--open') opt.open = true;
        else if (argv[i] === '--help' || argv[i] === '-h') { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 8).join('\n')); return; }
    }
    if (!Number.isInteger(opt.port) || opt.port < 0 || opt.port > 65535) { console.error('--port must be 0-65535'); process.exit(2); }
    const server = createServer();
    server.on('error', e => {
        if (e.code === 'EADDRINUSE') console.error(`Port ${opt.port} is already in use (a model server?). Try: node serve.cjs --port ${opt.port + 1}`);
        else console.error(e.message);
        process.exit(1);
    });
    server.listen(opt.port, opt.host, () => {
        const port = server.address().port, local = `http://localhost:${port}/`;
        console.log(`When Agents Rule is being served at ${local}`);
        if (opt.host !== '127.0.0.1' && opt.host !== 'localhost' && opt.host !== '::1') {
            const lan = Object.values(os.networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && !a.internal).map(a => `http://${a.address}:${port}/`);
            if (lan.length) console.log('On your network: ' + lan.join('  '));
            console.log('Reachable from other devices. API keys stay in each browser, but anyone who can reach this address can use the page.');
        }
        console.log('Press Ctrl+C to stop.');
        if (opt.open) {
            const { spawn } = require('node:child_process');
            const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', local]]
                : process.platform === 'darwin' ? ['open', [local]] : ['xdg-open', [local]];
            try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch (e) { /* the URL is printed above */ }
        }
    });
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { createServer };
