import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { Address6 } from 'ip-address';
import {
  isPublicIp,
  assertPublicHttpUrl,
  createGuardedFetch,
  strictPortGate,
  SecurityRejectionError,
  FetchFailureError,
} from '../src/host/guarded-fetch.js';

const fakeResolver = (map) => ({ async resolve(host) { return map[host] ?? []; } });
const allowAll = () => true;
const allowAllPorts = () => true;

test('isPublicIp rejects private ranges and accepts public ones', () => {
  for (const bad of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.9', '169.254.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1']) {
    assert.equal(isPublicIp(bad), false, bad);
  }
  for (const bad of ['::1', 'fe80::1', 'fc00::1', '::ffff:8.8.8.8']) {
    assert.equal(isPublicIp(bad), false, bad);
  }
  assert.ok(new Address6('::ffff:8.8.8.8') !== undefined);
  for (const good of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
    assert.equal(isPublicIp(good), true, good);
  }
});

test('assertPublicHttpUrl enforces protocol, port, credentials and DNS', async () => {
  await assert.rejects(assertPublicHttpUrl('ftp://x.example/f'), SecurityRejectionError);
  await assert.rejects(assertPublicHttpUrl('https://user:letmein@x.example/'), SecurityRejectionError);
  await assert.rejects(assertPublicHttpUrl('http://127.0.0.1:8080/'), SecurityRejectionError);
  await assert.rejects(assertPublicHttpUrl('http://localhost/'), SecurityRejectionError);
  await assert.rejects(assertPublicHttpUrl('https://miss.example/', fakeResolver({}), isPublicIp, strictPortGate, false), SecurityRejectionError);
  const handedOff = await assertPublicHttpUrl('https://miss.example/', fakeResolver({}));
  assert.equal(handedOff.proxied, true, 'DNS failure hands resolution to the proxy');
  await assert.rejects(assertPublicHttpUrl('https://evil.example/', fakeResolver({ 'evil.example': ['203.0.113.9'] })), SecurityRejectionError);
  const ok = await assertPublicHttpUrl('https://good.example/a?b=1', fakeResolver({ 'good.example': ['93.184.216.34'] }));
  assert.deepEqual(ok.ips, ['93.184.216.34']);
});

test('guarded fetch dials the verified IP and follows redirects re-asserting each hop', async () => {
  const dialed = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/final' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('hello ' + req.headers['user-agent']);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const fetcher = createGuardedFetch({
    resolver: fakeResolver({ 'loopback.test': ['127.0.0.1'] }),
    ipPolicy: (ip) => ip === '127.0.0.1',
    portGate: allowAllPorts,
    onDial: (ip) => dialed.push(ip),
  });
  try {
    const result = await fetcher.fetch('http://loopback.test:' + port + '/redirect', { totalTimeoutMs: 5000 });
    assert.equal(result.status, 200);
    assert.equal(result.body.toString(), 'hello Droplets-DSH');
    assert.deepEqual(dialed, ['127.0.0.1', '127.0.0.1'], 'each hop re-dials the verified IP');
    assert.ok(result.finalUrl.endsWith('/final'));
  } finally {
    server.close();
  }
});

test('guarded fetch aborts oversized bodies with a typed error', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(Buffer.alloc(1024 * 1024, 1));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const fetcher = createGuardedFetch({
    resolver: fakeResolver({ 'loopback.test': ['127.0.0.1'] }),
    ipPolicy: (ip) => ip === '127.0.0.1',
    portGate: allowAllPorts,
  });
  try {
    await assert.rejects(
      () => fetcher.fetch('http://loopback.test:' + port + '/big', { maxBodyBytes: 1024, totalTimeoutMs: 5000 }),
      (error) => error instanceof FetchFailureError && error.code === 'FETCH_BODY_LIMIT',
    );
  } finally {
    server.close();
  }
});


test('fake-IP proxy answers route through the CONNECT tunnel', async () => {
  const tunneled = [];
  const origin = http.createServer((req, res) => {
    tunneled.push(req.url);
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('via tunnel');
  });
  await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve));
  const originPort = origin.address().port;
  const proxyServer = http.createServer();
  proxyServer.on('connect', (req, socket) => {
    const upstream = net.connect({ host: '127.0.0.1', port: originPort }, () => {
      socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  await new Promise((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
  const proxyPort = proxyServer.address().port;
  const fetcher = createGuardedFetch({
    resolver: fakeResolver({ 'fake.example': ['198.18.1.85'] }),
    ipPolicy: allowAll,
    portGate: allowAllPorts,
    systemProxy: async () => 'http://127.0.0.1:' + proxyPort,
  });
  try {
    const result = await fetcher.fetch('http://fake.example/doc', { totalTimeoutMs: 8000 });
    assert.equal(result.status, 200);
    assert.equal(result.body.toString(), 'via tunnel');
    assert.deepEqual(tunneled, ['/doc']);
  } finally {
    proxyServer.close();
    origin.close();
  }
});

test('fake-IP without any proxy fails with a typed error', async () => {
  const fetcher = createGuardedFetch({
    resolver: fakeResolver({ 'fake.example': ['198.18.1.85'] }),
    ipPolicy: allowAll,
    portGate: allowAllPorts,
    systemProxy: async () => null,
  });
  await assert.rejects(
    () => fetcher.fetch('http://fake.example/doc', { totalTimeoutMs: 5000 }),
    (error) => error instanceof FetchFailureError && error.code === 'FETCH_FAKEIP_NO_PROXY',
  );
});

test('mixed resolutions still reject real private addresses beside fake-IPs', async () => {
  await assert.rejects(
    assertPublicHttpUrl('https://mixed.example/', fakeResolver({ 'mixed.example': ['198.18.1.85', '192.168.1.9'] })),
    SecurityRejectionError,
  );
});
