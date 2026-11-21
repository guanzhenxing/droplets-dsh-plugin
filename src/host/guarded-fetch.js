/**
 * SSRF-guarded fetching, ported from droplets' guardedFetchCore/security
 * (apps/desktop/src/main/fetch) for the plugin's Node runtime:
 *   - URL must be http(s) on ports 80/443, no credentials;
 *   - every hop re-resolves DNS and rejects any non-public address
 *     (loopback, RFC1918, CGNAT, link-local, multicast, v4-mapped v6 …);
 *   - the socket dials the exact verified IP (no second lookup → no DNS
 *     rebinding), keeping SNI/hostname for TLS validation;
 *   - redirects are re-asserted per hop, cross-origin 307/308 with a body
 *     is refused, credential headers are stripped across origins;
 *   - body reads are capped (50 MB inbox default) with first-byte and total
 *     timeouts so a stalled or oversized response aborts cleanly.
 */
import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { Address4, Address6 } from 'ip-address';
import { Agent, request as undiciRequest } from 'undici';

/** DNS resolver abstraction (test injection; default node:dns/promises). */
export const defaultDnsResolver = {
  async resolve(host) {
    const { lookup } = await import('node:dns/promises');
    const results = await lookup(host, { all: true });
    return results.map((r) => r.address);
  },
};

/** Security rejection (private network / bad protocol …): never auto-retried. */
export class SecurityRejectionError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'SecurityRejectionError';
    this.securityRejection = true;
    this.details = details;
  }
}

/** Non-security fetch failure (network / timeout / size limit / redirects). */
export class FetchFailureError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FetchFailureError';
    this.code = code;
  }
}

/** IANA special-purpose ranges (v4). Non-globally-unicast is rejected. */
const V4_CIDRS = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
  '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.168.0.0/16',
  '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
];

const V6_CIDRS = [
  '::/128', '::1/128', 'fe80::/10', 'fc00::/7', 'ff00::/8', '2001:db8::/32',
  '2001::/32', '2001:2::/48', '64:ff9b::/96', '::ffff:0:0/96', '2002::/16',
];

function v4BigInt(addr) {
  const parts = addr.parsedAddress.map((p) => BigInt(Number(p)));
  return (parts[0] << 24n) | (parts[1] << 16n) | (parts[2] << 8n) | parts[3];
}

function v6BigInt(addr) {
  let value = 0n;
  for (const group of addr.parsedAddress) {
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

function v4Range(cidr) {
  const [base, prefixStr] = cidr.split('/');
  const prefix = BigInt(prefixStr);
  const start = v4BigInt(new Address4(base));
  const size = 1n << (32n - prefix);
  return { start, end: start + size - 1n };
}

function v6Range(cidr) {
  const [base, prefixStr] = cidr.split('/');
  const prefix = BigInt(prefixStr);
  const start = v6BigInt(new Address6(base));
  const size = 1n << (128n - prefix);
  return { start, end: start + size - 1n };
}

const V4_RANGES = V4_CIDRS.map(v4Range);
const V6_RANGES = V6_CIDRS.map(v6Range);

function inRanges(value, ranges) {
  return ranges.some((r) => value >= r.start && value <= r.end);
}

/** True only for globally-unicast addresses; v4-mapped v6 is rejected. */
export function isPublicIp(ip) {
  const trimmed = ip.trim();
  let a4 = null;
  try {
    a4 = new Address4(trimmed);
  } catch {
    a4 = null;
  }
  if (a4) return !inRanges(v4BigInt(a4), V4_RANGES);
  let a6;
  try {
    a6 = new Address6(trimmed);
  } catch {
    return false;
  }
  return !inRanges(v6BigInt(a6), V6_RANGES);
}

function isIpLiteral(host) {
  try {
    new Address4(host);
    return true;
  } catch {
    /* fallthrough */
  }
  try {
    new Address6(host);
    return true;
  } catch {
    return false;
  }
}

const FAKE_PROXY_V4 = (() => {
  const [base, prefixStr] = '198.18.0.0/15'.split('/');
  const prefix = BigInt(prefixStr);
  const parts = base.split('.').map((p) => BigInt(Number(p)));
  const start = (parts[0] << 24n) | (parts[1] << 16n) | (parts[2] << 8n) | parts[3];
  return { start, end: start + (1n << (32n - prefix)) - 1n };
})();

function v4Value(ip) {
  const parts = ip.trim().split('.').map((p) => BigInt(Number(p)));
  return (parts[0] << 24n) | (parts[1] << 16n) | (parts[2] << 8n) | parts[3];
}

/** fake-IP proxy ranges (Clash/Surge): hand resolution to the proxy, not a rejection. */
export function isFakeProxyIp(ip) {
  try {
    const value = v4Value(ip);
    return value >= FAKE_PROXY_V4.start && value <= FAKE_PROXY_V4.end;
  } catch {
    return false;
  }
}

/**
 * System http(s) proxy URL: env first (http/https schemes only — SOCKS is
 * unsupported), then the macOS system proxy. Returns null when absent.
 */
export async function getSystemProxyUrl() {
  const fromEnv = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  if (typeof fromEnv === 'string' && /^https?:\/\//i.test(fromEnv)) return fromEnv;
  try {
    const { execFile } = await import('node:child_process');
    const stdout = await new Promise((resolve, reject) => {
      execFile('scutil', ['--proxy'], { timeout: 2000 }, (error, out) => (error ? reject(error) : resolve(String(out ?? ''))));
    });
    const https = /HTTPSEnable\s*:\s*1/.test(stdout);
    const http = /HTTPEnable\s*:\s*1/.test(stdout);
    const scheme = https ? 'HTTPS' : http ? 'HTTP' : null;
    if (scheme === null) return null;
    const host = new RegExp(scheme + 'Proxy\\s*:\\s*(\\S+)').exec(stdout)?.[1];
    const port = new RegExp(scheme + 'Port\\s*:\\s*(\\d+)').exec(stdout)?.[1];
    if (!host || !port) return null;
    return 'http://' + host + ':' + port;
  } catch {
    return null;
  }
}

/** Production port policy: only 80/443 (protocol defaults allowed). */
export const strictPortGate = (port) => {
  if (port === null) return true;
  return port === 80 || port === 443;
};

/**
 * Pre-flight assertion for one hop: protocol, port, credentials, and every
 * resolved IP must be public. Returns the verified URL and IPs.
 */
export async function assertPublicHttpUrl(raw, resolver = defaultDnsResolver, ipPolicy = isPublicIp, portGate = strictPortGate, allowFakeProxy = true) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new SecurityRejectionError(`无法解析的 URL：${raw.slice(0, 120)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SecurityRejectionError(`不允许的协议：${url.protocol.replace(':', '')}（仅 http/https）`);
  }
  const port = url.port === '' ? null : Number(url.port);
  if (!portGate(port)) {
    throw new SecurityRejectionError(`不允许的端口：${url.port || '(默认)'}（仅 80/443）`);
  }
  if (url.username || url.password) {
    throw new SecurityRejectionError('不允许携带用户名/密码的 URL');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIpLiteral(host)) {
    if (!ipPolicy(host)) throw new SecurityRejectionError(`目标主机是内网/保留地址：${host}`);
    return { url, ips: [host] };
  }
  const hostLower = host.toLowerCase();
  if (hostLower === 'localhost' || hostLower.endsWith('.localhost') || hostLower.endsWith('.local') || hostLower.endsWith('.internal')) {
    throw new SecurityRejectionError(`不允许的本地域名：${host}`);
  }
  let resolved;
  try {
    resolved = await resolver.resolve(host);
  } catch {
    resolved = [];
  }
  if (resolved.length === 0 && !allowFakeProxy) {
    throw new SecurityRejectionError(`域名解析失败：${host}`);
  }
  // fake-IP proxy answers (Clash/Surge) mean the local resolver is virtual:
  // the real resolution belongs to the proxy, so verification steps aside.
  const fakeOnly = resolved.length > 0 && resolved.every((ip) => isFakeProxyIp(ip));
  if (resolved.length === 0 && allowFakeProxy) {
    return { url, ips: [], proxied: true };
  }
  const bad = resolved.find((ip) => !isFakeProxyIp(ip) && !ipPolicy(ip));
  if (bad) {
    throw new SecurityRejectionError(`域名解析到内网/保留地址：${host} → ${bad}`);
  }
  return { url, ips: fakeOnly ? [] : resolved, proxied: fakeOnly };
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const REDIRECT_DOWNGRADES = new Set([301, 302, 303]);
const SAFE_CROSS_ORIGIN_HEADERS = new Set(['accept', 'accept-language']);

function keepSafeHeaders(headers) {
  const kept = {};
  for (const [name, value] of Object.entries(headers)) {
    if (SAFE_CROSS_ORIGIN_HEADERS.has(name.toLowerCase())) kept[name] = value;
  }
  return kept;
}

/**
 * CONNECT-tunnel connector through an http proxy: dial the proxy, issue
 * CONNECT for the real target, then TLS-upgrade for https targets with the
 * hostname kept as SNI (certificate validation stays on). Works uniformly
 * for http and https targets and avoids ProxyAgent's opaque internals.
 */
function tunnelConnector(proxyUrl, connectTimeoutMs) {
  const proxy = new URL(proxyUrl);
  const proxyHost = proxy.hostname.replace(/^\[|\]$/g, '');
  const proxyPort = Number(proxy.port) || 80;
  return (options, callback) => {
    const port = Number(options.port) || (options.protocol === 'https:' ? 443 : 80);
    let settled = false;
    const done = (err, socket) => {
      if (settled) return;
      settled = true;
      if (err) callback(err, null);
      else callback(null, socket ?? new net.Socket());
    };
    const fail = (code, message) => {
      socket.destroy();
      done(new FetchFailureError(code, message));
    };
    const socket = net.connect({ host: proxyHost, port: proxyPort });
    socket.setTimeout(connectTimeoutMs);
    socket.once('timeout', () => fail('FETCH_CONNECT_TIMEOUT', `代理连接超时：${proxyHost}:${proxyPort}`));
    socket.once('error', (err) => fail('FETCH_NETWORK', `代理连接失败：${err.message}`));
    socket.once('connect', () => {
      socket.setTimeout(connectTimeoutMs);
      socket.write(`CONNECT ${options.hostname}:${port} HTTP/1.1\r\nHost: ${options.hostname}:${port}\r\n\r\n`);
      let buffer = '';
      const onData = (chunk) => {
        buffer += chunk.toString('latin1');
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) {
          if (buffer.length > 8192) {
            socket.removeListener('data', onData);
            fail('FETCH_NETWORK', '代理 CONNECT 响应异常');
          }
          return;
        }
        socket.removeListener('data', onData);
        const statusLine = buffer.slice(0, buffer.indexOf('\r\n'));
        if (!/\s2\d\d\s/.test(statusLine)) {
          socket.destroy();
          done(new FetchFailureError('FETCH_NETWORK', `代理拒绝 CONNECT：${statusLine}`), null);
          return;
        }
        socket.setTimeout(0);
        if (options.protocol === 'https:') {
          const tlsSocket = tls.connect({ socket, servername: options.hostname, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] });
          tlsSocket.once('secureConnect', () => done(null, tlsSocket));
          tlsSocket.once('error', (err) => done(new FetchFailureError('FETCH_NETWORK', `TLS 握手失败：${err.message}`), null));
        } else {
          done(null, socket);
        }
      };
      socket.on('data', onData);
    });
  };
}

/** Pin the dial to the verified IP; keep hostname for SNI + cert checks. */
function pinnedConnector(ip, connectTimeoutMs) {
  return (options, callback) => {
    const port = Number(options.port) || (options.protocol === 'https:' ? 443 : 80);
    let settled = false;
    const done = (err, socket) => {
      if (settled) return;
      settled = true;
      if (err) callback(err, null);
      else callback(null, socket ?? new net.Socket());
    };
    const socket = options.protocol === 'https:'
      ? tls.connect({ host: ip, port, servername: options.hostname, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] })
      : net.connect({ host: ip, port });
    socket.setTimeout(connectTimeoutMs);
    socket.once('timeout', () => {
      socket.destroy();
      done(new FetchFailureError('FETCH_CONNECT_TIMEOUT', `连接超时：${options.hostname} (${ip})`));
    });
    socket.once('error', (err) => done(new FetchFailureError('FETCH_NETWORK', `连接失败：${err.message}`)));
    socket.once('connect', () => {
      socket.setTimeout(0);
      done(null, socket);
    });
  };
}

function decodeStream(body, encoding) {
  switch (encoding.toLowerCase()) {
    case 'gzip': return body.pipe(zlib.createGunzip());
    case 'deflate': return body.pipe(zlib.createInflate());
    case 'br': return body.pipe(zlib.createBrotliDecompress());
    default: return body;
  }
}

async function readBodyWithLimit(body, encoding, maxBodyBytes) {
  const stream = decodeStream(body, encoding);
  const chunks = [];
  let total = 0;
  let exceeded = false;
  try {
    for await (const chunk of stream) {
      const buf = Buffer.from(chunk);
      total += buf.length;
      if (total > maxBodyBytes) {
        exceeded = true;
        break;
      }
      chunks.push(buf);
    }
  } catch (e) {
    throw new FetchFailureError('FETCH_NETWORK', `响应体读取失败：${e.message}`);
  }
  if (exceeded) {
    stream.destroy();
    throw new FetchFailureError('FETCH_BODY_LIMIT', `响应体超过上限（解压后 > ${maxBodyBytes} 字节），已中断`);
  }
  return Buffer.concat(chunks);
}

/**
 * Factory. Production uses the strict defaults; tests inject resolver /
 * ipPolicy / onDial / portGate to simulate networks.
 */
export function createGuardedFetch(deps = {}) {
  const resolver = deps.resolver ?? defaultDnsResolver;
  const ipPolicy = deps.ipPolicy ?? isPublicIp;
  const portGate = deps.portGate ?? strictPortGate;
  const onDial = deps.onDial;
  // systemProxy stays undefined in production (read the real system proxy per
  // hop); tests inject a fake to pin the proxied path.
  const userAgent = deps.userAgent ?? (() => 'Droplets-DSH');
  return {
    async fetch(raw, opts = {}) {
      const maxRedirects = opts.maxRedirects ?? 6;
      const connectTimeoutMs = opts.connectTimeoutMs ?? 20_000;
      const totalTimeoutMs = opts.totalTimeoutMs ?? 60_000;
      const maxBodyBytes = opts.maxBodyBytes ?? 50 * 1024 * 1024;

      let timedOut = false;
      const controller = new AbortController();
      let activeAgent = null;
      const hardAbort = (reason) => {
        if (reason !== undefined) controller.abort(reason);
        else controller.abort();
        void activeAgent?.destroy().catch(() => undefined);
      };
      if (opts.signal?.aborted) hardAbort(opts.signal.reason);
      else opts.signal?.addEventListener('abort', () => hardAbort(opts.signal?.reason), { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        hardAbort();
      }, totalTimeoutMs);

      let current = raw;
      let currentMethod = opts.method ?? 'GET';
      let currentBody;
      let userHeaders = { ...opts.headers };
      try {
        for (let hop = 0; ; hop += 1) {
          // Per-hop full security re-assertion (redirects re-run everything).
          const asserted = await assertPublicHttpUrl(current, resolver, ipPolicy, portGate);
          const ip = asserted.ips[0];
          if (ip) onDial?.(ip);

          let agent;
          if (asserted.proxied) {
            const proxyUrl = deps.systemProxy === undefined ? await getSystemProxyUrl() : await deps.systemProxy();
            if (!proxyUrl) {
              if (ip === undefined) {
                throw new FetchFailureError('FETCH_FAKEIP_NO_PROXY', '本地 DNS 返回 fake-IP(代理模式)但未找到可用的 http(s) 系统代理');
              }
              agent = new Agent({ connect: pinnedConnector(ip, connectTimeoutMs) });
            } else {
              agent = new Agent({ connect: tunnelConnector(proxyUrl, connectTimeoutMs) });
            }
          } else {
            agent = new Agent({ connect: pinnedConnector(ip, connectTimeoutMs) });
          }
          activeAgent = agent;
          let response;
          try {
            response = await undiciRequest(asserted.url, {
              method: currentMethod,
              body: currentBody,
              dispatcher: agent,
              headers: {
                'accept-encoding': 'gzip, deflate, br',
                'user-agent': userAgent(),
                accept: opts.accept ?? '*/*',
                ...userHeaders,
              },
              signal: controller.signal,
            });
          } catch (e) {
            if (timedOut) {
              throw new FetchFailureError('FETCH_TIMEOUT', `总超时（${totalTimeoutMs}ms）：${asserted.url.hostname}`);
            }
            if (e instanceof SecurityRejectionError || e instanceof FetchFailureError) throw e;
            const code = e?.code ?? '';
            if (/UNABLE_TO_VERIFY|CERT|TLS|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|CONNECT_TIMEOUT|ECONNABORTED/.test(`${code} ${e.message}`)) {
              throw new FetchFailureError('FETCH_NETWORK', `请求失败：${code} ${e.message}`);
            }
            throw e;
          }

          const status = response.statusCode;
          const location = response.headers['location'];

          if (REDIRECT_CODES.has(status) && typeof location === 'string') {
            await response.body.dump().catch(() => {});
            await agent.close().catch(() => {});
            activeAgent = null;
            if (hop >= maxRedirects) {
              throw new FetchFailureError('FETCH_TOO_MANY_REDIRECTS', `重定向超过 ${maxRedirects} 跳上限`);
            }
            const next = new URL(location, asserted.url);
            const crossOrigin = next.origin !== asserted.url.origin;
            if (crossOrigin) {
              if (!REDIRECT_DOWNGRADES.has(status)) {
                throw new SecurityRejectionError(`跨域重定向不允许重发请求正文（${status}）：${asserted.url.origin} → ${next.origin}`);
              }
              userHeaders = keepSafeHeaders(userHeaders);
            }
            if (REDIRECT_DOWNGRADES.has(status)) {
              currentMethod = 'GET';
              currentBody = undefined;
            }
            current = next.toString();
            continue;
          }

          try {
            const encRaw = response.headers['content-encoding'];
            const encoding = (Array.isArray(encRaw) ? encRaw[0] ?? '' : encRaw ?? '').trim();
            const body = await readBodyWithLimit(response.body, encoding, maxBodyBytes);
            const headers = {};
            for (const [k, v] of Object.entries(response.headers)) {
              headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
            }
            return { status, headers, body, finalUrl: asserted.url.toString() };
          } finally {
            await agent.close().catch(() => {});
          }
        }
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Shared strict instance used by feeds and the inbox. */
export const guardedFetch = createGuardedFetch();
