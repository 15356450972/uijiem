const http = require('http');
const https = require('https');
const tls = require('tls');

const DEFAULT_PROXY = {
  localHost: '127.0.0.1',
  localPort: 7890,
  remoteHost: 'us.ipwo.net',
  remotePort: 7878,
  user: 'mengjun66_custom_zone_GLOBAL',
  pass: 'mengjun66'
};

function createTunnel(targetHost, targetPort, proxy, callback) {
  const rp = proxy || DEFAULT_PROXY;
  const auth = Buffer.from(`${rp.user}:${rp.pass}`).toString('base64');
  const tunnelTimeout = rp.tunnelTimeout || 20000;

  let settled = false;
  let socket1Ref = null;
  let tlsSocketRef = null;

  const done = (err, socket) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (err) {
      try { if (tlsSocketRef) tlsSocketRef.destroy(); } catch (e) {}
      try { if (socket1Ref) socket1Ref.destroy(); } catch (e) {}
      try { connectReq.destroy(); } catch (e) {}
      callback(err);
    } else {
      callback(null, socket);
    }
  };

  const timer = setTimeout(() => done(new Error(`Tunnel timeout after ${tunnelTimeout}ms`)), tunnelTimeout);

  const connectReq = http.request({
    host: rp.localHost,
    port: rp.localPort,
    method: 'CONNECT',
    path: `${rp.remoteHost}:${rp.remotePort}`,
    timeout: tunnelTimeout
  });

  connectReq.on('connect', (res1, socket1) => {
    socket1Ref = socket1;
    if (res1.statusCode !== 200) {
      done(new Error(`Step1 CONNECT failed: ${res1.statusCode}`));
      return;
    }

    socket1.write(
      `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
      `Host: ${targetHost}:${targetPort}\r\n` +
      `Proxy-Authorization: Basic ${auth}\r\n\r\n`
    );

    let buf = '';
    const onData = (d) => {
      buf += d.toString('binary');
      if (buf.includes('\r\n\r\n')) {
        socket1.removeListener('data', onData);
        const statusLine = buf.split('\r\n')[0];
        if (!statusLine.includes(' 200 ')) {
          done(new Error(`Step2 CONNECT failed: ${statusLine}`));
          return;
        }
        const tlsSocket = tls.connect(
          { socket: socket1, servername: targetHost },
          () => done(null, tlsSocket)
        );
        tlsSocketRef = tlsSocket;
        tlsSocket.on('error', (e) => done(new Error(`TLS error: ${e.message}`)));
      }
    };
    socket1.on('data', onData);
    socket1.on('error', (e) => done(new Error(`Tunnel socket error: ${e.message}`)));
  });

  connectReq.on('error', (e) => done(new Error(`Step1 error: ${e.message}`)));
  connectReq.on('timeout', () => done(new Error('Step1 CONNECT timeout')));
  connectReq.end();
}

class RotatingProxyAgent extends https.Agent {
  constructor(opts = {}) {
    super({ keepAlive: true, maxSockets: opts.maxSockets || 1, ...opts });
    this.proxy = opts.proxy || DEFAULT_PROXY;
  }

  createConnection(options, callback) {
    const targetHost = options.host || options.hostname;
    const targetPort = options.port || 443;
    createTunnel(targetHost, targetPort, this.proxy, callback);
  }
}

function createProxyAgent(opts = {}) {
  return new RotatingProxyAgent(opts);
}

module.exports = { createProxyAgent, createTunnel, RotatingProxyAgent, DEFAULT_PROXY };
