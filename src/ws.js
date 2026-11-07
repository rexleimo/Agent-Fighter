import { createHash } from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WSConnection {
  constructor(socket, url) {
    this.socket = socket;
    this.url = url;
    this.buf = Buffer.alloc(0);
    this.onMessage = null;
    this.onClose = null;
    this.internalClose = null;
    this.closed = false;
    this.meta = {};
    const bye = () => {
      this.closed = true;
      if (this.onClose) this.onClose(this);
      if (this.internalClose) this.internalClose(this);
    };
    socket.on('data', (chunk) => this.feed(chunk));
    socket.on('close', bye);
    socket.on('error', bye);
  }

  feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    let guard = 0;
    while (this.parseFrame() && guard < 2000) guard += 1;
  }

  parseFrame() {
    const b = this.buf;
    if (b.length < 2) return false;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return false;
      len = b.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (b.length < 10) return false;
      len = Number(b.readBigUInt64BE(2));
      off = 10;
    }
    let mask = null;
    if (masked) {
      if (b.length < off + 4) return false;
      mask = b.subarray(off, off + 4);
      off += 4;
    }
    if (b.length < off + len) return false;
    const payload = Buffer.from(b.subarray(off, off + len));
    if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    this.buf = b.subarray(off + len);

    if (opcode === 0x8) { this.close(); return false; }
    if (opcode === 0x9) { this.sendFrame(0xa, payload); return true; }
    if (opcode === 0xa) return true;
    if (opcode === 0x1) {
      try {
        const msg = JSON.parse(payload.toString('utf8'));
        if (this.onMessage) this.onMessage(msg);
      } catch { /* malformed client message is ignored */ }
    }
    return true;
  }

  sendFrame(opcode, payload) {
    if (!this.socket.writable || this.closed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch { /* connection gone */ }
  }

  sendRaw(text) {
    this.sendFrame(0x1, Buffer.from(text, 'utf8'));
  }

  send(obj) {
    this.sendRaw(JSON.stringify(obj));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.sendFrame(0x8, Buffer.alloc(0));
      this.socket.end();
    } catch { /* already gone */ }
  }
}

export function attachWebSocketServer(httpServer, { onConnection, pathPrefix = '/ws' } = {}) {
  const clients = new Set();
  httpServer.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (!url.pathname.startsWith(pathPrefix) || !req.headers['sec-websocket-key']) {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1')
      .update(req.headers['sec-websocket-key'] + WS_GUID)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );
    socket.setNoDelay(true);
    const conn = new WSConnection(socket, url);
    clients.add(conn);
    conn.internalClose = () => clients.delete(conn);
    if (onConnection) onConnection(conn, url);
    if (head && head.length) conn.feed(head);
  });
  return clients;
}
