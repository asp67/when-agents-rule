// serve.cjs: the zero-download way to run the game. It must serve the folder, refuse
// anything outside it (however the path is spelled) and hidden folders such as .git,
// and revalidate so an updated game is picked up.
const test = require('node:test'), assert = require('node:assert/strict');
const net = require('node:net'), path = require('node:path');
const { createServer } = require('../serve.cjs');

async function withServer(fn) {
    const server = createServer(path.resolve(__dirname, '..'));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const origin = 'http://127.0.0.1:' + server.address().port;
    try { await fn(origin, server.address().port); } finally { await new Promise(r => server.close(r)); }
}
// A raw request, so the path reaches the server exactly as written (fetch normalizes "..").
function raw(port, target) {
    return new Promise((resolve, reject) => {
        const s = net.connect(port, '127.0.0.1', () => s.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
        let data = ''; s.on('data', d => data += d); s.on('end', () => resolve(Number(data.split(' ')[1]))); s.on('error', reject);
    });
}

test('serves the game with the right types', () => withServer(async origin => {
    const index = await fetch(origin + '/');
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    assert.match(await index.text(), /When Agents Rule/);
    assert.match((await fetch(origin + '/js/game.js')).headers.get('content-type'), /javascript/);
    assert.match((await fetch(origin + '/samples/index.json')).headers.get('content-type'), /application\/json/);
    assert.equal((await fetch(origin + '/no-such-file.js')).status, 404);
}));

test('nothing outside the folder or in hidden folders is served', async () => {
    // A served folder with a secret right beside it, so an escape has something to find.
    const fs = require('node:fs'), os = require('node:os');
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'war-serve-')), root = path.join(base, 'site');
    fs.mkdirSync(path.join(root, 'js'), { recursive: true }); fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(path.join(root, 'index.html'), 'ok'); fs.writeFileSync(path.join(root, '.git', 'config'), 'secret');
    fs.writeFileSync(path.join(base, 'secret.txt'), 'secret');
    const server = createServer(root);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
        assert.equal(await raw(port, '/index.html'), 200);
        for (const t of ['/../secret.txt', '/..%2fsecret.txt', '/..%5csecret.txt', '/%2e%2e/secret.txt', '/js/%2e%2e/%2e%2e/secret.txt',
                         '/.git/config', '/js/..%2f.git/config'])
            assert.equal(await raw(port, t), 404, t);
    } finally { await new Promise(r => server.close(r)); fs.rmSync(base, { recursive: true, force: true }); }
});

test('an unchanged file revalidates with 304', () => withServer(async origin => {
    const first = await fetch(origin + '/index.html');
    const again = await fetch(origin + '/index.html', { headers: { 'If-Modified-Since': first.headers.get('last-modified') } });
    assert.equal(again.status, 304);
    assert.equal(first.headers.get('cache-control'), 'no-cache');
}));

// A hidden folder by another name (b1284). The check read the path as it was spelled, and a
// path can be spelled so that no part of it starts with a dot and it still ends in .git:
// Windows keeps a short name for every folder (GIT~1 for .git), a link or junction may
// point into one, and "file::$DATA" is the file by its stream. With --host 0.0.0.0 that
// handed .git/config and .claude to anyone on the network.
test('a hidden folder is not served under another name', async () => {
    const fs = require('node:fs'), os = require('node:os'), { execFileSync } = require('node:child_process');
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'war-serve-')), root = path.join(base, 'site');
    fs.mkdirSync(path.join(root, '.git'), { recursive: true }); fs.mkdirSync(path.join(base, 'outside'));
    fs.writeFileSync(path.join(root, 'index.html'), 'ok'); fs.writeFileSync(path.join(root, '.git', 'config'), 'secret');
    fs.writeFileSync(path.join(base, 'outside', 'secret.txt'), 'secret');
    const targets = ['/index.html::$DATA', '/index.html:x'];
    // A junction (a symlink elsewhere) from a harmless name into the hidden folder, and one out of the root.
    let linked = false;
    try {
        fs.symlinkSync(path.join(root, '.git'), path.join(root, 'visible'), 'junction');
        fs.symlinkSync(path.join(base, 'outside'), path.join(root, 'out'), 'junction');
        linked = true; targets.push('/visible/config', '/out/secret.txt');
    } catch (e) { /* no right to make links here: the short name below still tests the rule */ }
    // The short name Windows gave ".git", if this volume gives them.
    let short = null;
    if (process.platform === 'win32') {
        try { const m = execFileSync('cmd', ['/c', 'dir', '/x', '/ad', root], { encoding: 'utf8' }).split(/\r?\n/).map(l => l.match(/\s([A-Z0-9_~]+~\d)\s+\.git\s*$/i)).find(Boolean); short = m && m[1]; }
        catch (e) { /* no listing: nothing to add */ }
        if (short) targets.push('/' + short + '/config', '/' + short.toLowerCase() + '/config');
    }
    const server = createServer(root);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
        assert.equal(await raw(port, '/index.html'), 200);
        assert.ok(linked || short, 'this machine offers a second name for the hidden folder to test with');
        for (const t of targets) assert.equal(await raw(port, t), 404, t);
    } finally { await new Promise(r => server.close(r)); fs.rmSync(base, { recursive: true, force: true }); }
});

// Bound to this computer, the server answers to this computer's names only: a page on
// another site that points a name of its own at 127.0.0.1 reads nothing through a browser.
test('a server for this computer only answers to its own names', async () => {
    const server = createServer(path.resolve(__dirname, '..'), { hosts: ['localhost', '127.0.0.1', '[::1]'] });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const ask = host => new Promise((resolve, reject) => {
        const s = net.connect(port, '127.0.0.1', () => s.write(`GET /index.html HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
        let data = ''; s.on('data', d => data += d); s.on('end', () => resolve(Number(data.split(' ')[1]))); s.on('error', reject);
    });
    try {
        for (const h of ['localhost:' + port, '127.0.0.1:' + port, 'LOCALHOST', '[::1]:' + port]) assert.equal(await ask(h), 200, h);
        for (const h of ['evil.example:' + port, 'localhost.evil.example', '127.0.0.1.evil.example:' + port, 'x']) assert.equal(await ask(h), 403, h);
    } finally { await new Promise(r => server.close(r)); }
});
