/* Ein simuliertes Gerät (Team-Handy, Moderation, Beamer, Übersicht oder ein
   Handy, das nur die Team-Seite offen hat, ohne beizutreten). Verhält sich
   beim Wiederverbinden wie die echten Seiten (shared.js / team.js): nach
   jedem `connect` wird die Rolle neu angemeldet, ein Team setzt sich mit
   teamId + teamSecret fort. */

const { io } = require('socket.io-client');

const STAFF_ROLES = new Set(['moderator', 'display', 'overview']);

class SimClient {
  constructor({ url, room, role, cookie, teamName, emoji, recorder, transport }) {
    this.url = url;
    this.room = room;
    this.role = role; // 'moderator' | 'display' | 'overview' | 'team' | 'lurker'
    this.cookie = cookie;
    this.teamName = teamName;
    this.emoji = emoji;
    this.rec = recorder;
    this.transport = transport;
    this.state = null;
    this.teamId = null;
    this.teamSecret = null;
    this.waiters = new Set();
    this.disconnectedAt = null;
    this.lastTickAt = null;
    this.measureTicks = false;
  }

  connect() {
    const transports = this.transport === 'polling' ? ['polling'] : ['websocket'];
    const startedAt = Date.now();
    this.socket = io(this.url, {
      transports,
      query: { room: this.room },
      reconnectionDelay: 500,
      reconnectionDelayMax: 3000,
      timeout: 20000,
      ...(this.cookie && STAFF_ROLES.has(this.role) ? { extraHeaders: { Cookie: this.cookie } } : {}),
    });
    this.socket.on('game_state', (s) => this.onState(s));
    this.socket.on('timer_tick', () => this.onTick());
    this.socket.on('connect_error', () => this.rec.inc('connect_errors'));
    this.socket.on('kicked', () => this.rec.inc('kicked'));
    this.socket.on('disconnect', () => {
      if (this.closing) return;
      this.disconnectedAt = Date.now();
      this.lastTickAt = null;
      this.rec.inc('disconnects');
    });
    this.socket.on('connect', () => this.onConnect());
    return new Promise((resolve) => {
      this.socket.once('connect', () => {
        this.rec.add('connect_ms', Date.now() - startedAt);
        resolve();
      });
    });
  }

  // Re-announces the role after a reconnect, like the real pages do.
  async onConnect() {
    if (this.disconnectedAt === null) return; // first connect: join() is called explicitly
    const res = await this.join();
    const ok = res && res.ok !== false;
    this.rec.inc(ok ? 'reconnect_resumed' : 'reconnect_failed');
    if (ok) this.rec.add('reconnect_ms', Date.now() - this.disconnectedAt);
    this.disconnectedAt = null;
  }

  join() {
    if (this.role === 'lurker') return Promise.resolve({ ok: true });
    const payload = this.role === 'team'
      ? (this.teamId
        ? { role: 'team', teamId: this.teamId, teamSecret: this.teamSecret }
        : { role: 'team', name: this.teamName, emoji: this.emoji })
      : { role: this.role };
    return this.emitWithAck('join', payload).then((res) => {
      if (res && res.ok && res.teamId) {
        this.teamId = res.teamId;
        if (res.teamSecret) this.teamSecret = res.teamSecret;
      }
      return res;
    });
  }

  emitWithAck(event, payload, timeoutMs = 15000) {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), timeoutMs);
      this.socket.emit(event, payload, (res) => { clearTimeout(t); resolve(res); });
    });
  }

  onState(s) {
    this.state = s;
    if (s.gameState !== 'playing' || s.paused) this.lastTickAt = null; // no ticks expected between rounds
    this.rec.inc('state_msgs');
    this.rec.inc('state_bytes', Buffer.byteLength(JSON.stringify(s)));
    for (const w of this.waiters) w.check();
  }

  // Timer ticks come once per second from the server; the deviation from
  // 1000 ms is a direct readout of server event-loop lag + network jitter.
  onTick() {
    const now = Date.now();
    if (this.measureTicks && this.lastTickAt) this.rec.add('tick_jitter_ms', Math.abs(now - this.lastTickAt - 1000));
    this.lastTickAt = now;
  }

  // Resolves with ms until predicate(state) holds, or null after timeoutMs.
  waitFor(predicate, timeoutMs) {
    const startedAt = Date.now();
    return new Promise((resolve) => {
      const waiter = {
        check: () => {
          if (this.state && predicate(this.state)) finish(Date.now() - startedAt);
        },
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      const finish = (value) => {
        clearTimeout(timer);
        this.waiters.delete(waiter);
        resolve(value);
      };
      this.waiters.add(waiter);
      waiter.check();
    });
  }

  ownTeam() {
    return this.state && this.teamId ? this.state.teams[this.teamId] : null;
  }

  close() {
    this.closing = true;
    if (this.socket) this.socket.disconnect();
  }
}

module.exports = { SimClient };
