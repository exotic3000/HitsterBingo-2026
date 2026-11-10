/* Störsender zwischen Testclients und Server: ein TCP-Proxy, der ein
   schlechtes Veranstaltungs-WLAN nachstellt, ohne Root-Rechte (anders als
   `tc netem`). Pro Verbindung und Richtung:
   - latencyMs / jitterMs: Verzögerung jedes Datenpakets (Reihenfolge bleibt erhalten)
   - kbps: Bandbreite je Verbindung (0 = unbegrenzt)
   Fehler, die der Lasttest gezielt auslöst:
   - reset(conn):    Verbindung hart trennen (Client und Server merken es sofort)
   - halfOpen(conn): nur die Client-Seite schließen, die Server-Seite bleibt
                     stumm offen — wie ein Handy, das vom WLAN ins Mobilnetz
                     wechselt: der Server bemerkt den toten Socket erst nach
                     seinem Ping-Timeout, während das Handy längst neu verbunden ist. */

const net = require('net');

function createNetProxy({ listenPort, targetPort, latencyMs = 0, jitterMs = 0, kbps = 0 }) {
  const conns = new Set();
  const bytesPerMs = kbps > 0 ? (kbps * 1024) / 8 / 1000 : 0;
  const stats = { bytesToClient: 0, bytesToServer: 0, resets: 0, halfOpens: 0 };

  // Schedules chunks on one direction so they keep their order even with jitter.
  function makeLane(dest, counterKey) {
    let nextFreeAt = 0;
    let blackholed = false;
    return {
      push(chunk) {
        if (blackholed) return;
        const now = Date.now();
        const delay = latencyMs + Math.random() * jitterMs;
        const transfer = bytesPerMs ? chunk.length / bytesPerMs : 0;
        nextFreeAt = Math.max(nextFreeAt, now + delay) + transfer;
        setTimeout(() => {
          if (blackholed || dest.destroyed) return;
          stats[counterKey] += chunk.length;
          dest.write(chunk);
        }, nextFreeAt - now);
      },
      blackhole() { blackholed = true; },
    };
  }

  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, '127.0.0.1');
    const conn = { client, upstream, openedAt: Date.now() };
    conns.add(conn);
    const toServer = makeLane(upstream, 'bytesToServer');
    const toClient = makeLane(client, 'bytesToClient');
    conn.lanes = [toServer, toClient];
    client.on('data', (c) => toServer.push(c));
    upstream.on('data', (c) => toClient.push(c));
    const close = () => {
      conns.delete(conn);
      if (!conn.halfOpen) upstream.destroy();
      client.destroy();
    };
    client.on('close', close);
    client.on('error', close);
    upstream.on('close', () => { conns.delete(conn); client.destroy(); });
    upstream.on('error', () => { conns.delete(conn); client.destroy(); });
  });

  return {
    stats,
    connections: () => [...conns],
    listen: () => new Promise((resolve) => server.listen(listenPort, '127.0.0.1', resolve)),
    reset(conn) {
      stats.resets++;
      conn.upstream.destroy();
      conn.client.destroy();
    },
    halfOpen(conn) {
      stats.halfOpens++;
      conn.halfOpen = true;
      conn.lanes.forEach((lane) => lane.blackhole());
      conns.delete(conn);
      conn.client.destroy(); // upstream stays open until the server times it out
    },
    close: () => new Promise((resolve) => {
      for (const c of conns) { c.upstream.destroy(); c.client.destroy(); }
      server.close(() => resolve());
    }),
  };
}

module.exports = { createNetProxy };
