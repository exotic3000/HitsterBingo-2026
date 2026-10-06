/* Each view gets only what it shows, and only when that changed for it:
   no foreign bingo cards or answers on team phones, no answer texts on the
   Beamer, and an answer or ticked cell doesn't wake up every device in the
   room any more. */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  startServer, stopServer, login, createRoom, connectSocket, joinTeam, sleep, waitForEvent,
  uniqueSnapshotPath, removeIfExists,
} = require('./helpers');

const PORT = 3208;
const snapshotFile = uniqueSnapshotPath('state-views');

let server, roomCode;
const views = {};
const sockets = [];

// Connects a socket, records every game_state it receives, optionally joins a role.
async function openView(name, role) {
  const socket = connectSocket(server.base, roomCode);
  sockets.push(socket);
  const view = { socket, states: [] };
  socket.on('game_state', (s) => view.states.push(s));
  await waitForEvent(socket, 'connect');
  if (role) socket.emit('join', { role });
  views[name] = view;
  return view;
}

function last(name) {
  const states = views[name].states;
  return states[states.length - 1];
}

before(async () => {
  removeIfExists(snapshotFile);
  server = await startServer({ port: PORT, snapshotFile });
  const cookie = await login(server.base);
  roomCode = (await createRoom(server.base, cookie)).body.roomCode;

  await openView('mod', 'moderator');
  await openView('display', 'display');
  await openView('overview', 'overview');
  await openView('setup'); // team setup screen, not joined yet

  await openView('alpha');
  await openView('beta');
  views.alpha.teamId = (await joinTeam(views.alpha.socket, { name: 'Alpha', emoji: '🚀' })).teamId;
  views.beta.teamId = (await joinTeam(views.beta.socket, { name: 'Beta', emoji: '🌟' })).teamId;
  await sleep(200);

  views.mod.socket.emit('start_spin');
  views.mod.socket.emit('set_song', { title: 'Song', artist: 'Artist', year: '1999', spotifyUri: null });
  await sleep(200);
  views.alpha.socket.emit('submit_answer', { teamId: views.alpha.teamId, answer: 'Queen' });
  await sleep(200);
});

after(async () => {
  sockets.forEach((s) => s.disconnect());
  await stopServer(server);
  removeIfExists(snapshotFile);
});

test('the moderator sees every card and every answer', () => {
  const s = last('mod');
  assert.ok(s.teams[views.alpha.teamId].bingoCard);
  assert.ok(s.teams[views.beta.teamId].bingoCard);
  assert.equal(s.answers[views.alpha.teamId], 'Queen');
});

test('a team sees its own card and answer, but not another team\'s', () => {
  const alpha = last('alpha');
  assert.ok(alpha.teams[views.alpha.teamId].bingoCard);
  assert.equal(alpha.answers[views.alpha.teamId], 'Queen');

  const beta = last('beta');
  assert.equal(beta.teams[views.alpha.teamId].bingoCard, undefined);
  assert.deepEqual(beta.teams[views.alpha.teamId], { id: views.alpha.teamId, name: 'Alpha', emoji: '🚀' });
  assert.deepEqual(beta.answers, {});
});

test('the team setup screen sees taken names and emojis only', () => {
  const s = last('setup');
  assert.deepEqual(Object.values(s.teams).map((t) => t.name).sort(), ['Alpha', 'Beta']);
  assert.ok(Object.values(s.teams).every((t) => t.bingoCard === undefined));
  assert.deepEqual(s.answers, {});
});

test('the Beamer learns who answered, not what', () => {
  const s = last('display');
  assert.equal(s.answers[views.alpha.teamId], true);
  assert.equal(s.teams[views.alpha.teamId].bingoCard, undefined);
  assert.equal(s.teams[views.alpha.teamId].hasBingo, false);
});

test('the overview gets every card but no answer texts', () => {
  const s = last('overview');
  assert.ok(s.teams[views.beta.teamId].bingoCard);
  assert.deepEqual(s.answers, {});
});

test('an answer only reaches the views it changes', async () => {
  const before = Object.fromEntries(Object.entries(views).map(([k, v]) => [k, v.states.length]));
  views.beta.socket.emit('submit_answer', { teamId: views.beta.teamId, answer: 'ABBA' });
  await sleep(300);
  const got = (k) => views[k].states.length - before[k];

  assert.equal(got('mod'), 1);
  assert.equal(got('beta'), 1);
  assert.equal(got('display'), 1, 'the Beamer shows a new answered dot');
  assert.equal(got('alpha'), 0, 'another team must not be woken up');
  assert.equal(got('overview'), 0);
  assert.equal(got('setup'), 0);
});

test('ticking a cell only reaches the team itself, the moderator and the overview', async () => {
  const before = Object.fromEntries(Object.entries(views).map(([k, v]) => [k, v.states.length]));
  views.alpha.socket.emit('mark_correct', { teamId: views.alpha.teamId, row: 0, col: 0 });
  await sleep(300);
  const got = (k) => views[k].states.length - before[k];

  assert.equal(got('alpha'), 1);
  assert.equal(got('mod'), 1);
  assert.equal(got('overview'), 1);
  assert.equal(got('beta'), 0);
  assert.equal(got('display'), 0, 'no Bingo yet, so nothing changes on the Beamer');
  assert.equal(got('setup'), 0);
  assert.equal(last('alpha').teams[views.alpha.teamId].score, 1);
});

test('round changes still reach everyone', async () => {
  const before = Object.fromEntries(Object.entries(views).map(([k, v]) => [k, v.states.length]));
  views.mod.socket.emit('reveal_solution');
  await sleep(300);
  for (const name of Object.keys(views)) {
    assert.equal(views[name].states.length - before[name], 1, name + ' must see the reveal');
    assert.equal(last(name).gameState, 'revealing');
  }
});
