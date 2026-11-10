/* Teams tick their own card themselves, but only fairly: while the solution
   is shown, only a cell of the round's category, and at most one per round.
   They may undo that one tick, not ticks from earlier rounds. The moderator
   can still tick or untick anything. */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  startServer, stopServer, login, createRoom, connectSocket, joinTeam, sleep, waitForEvent,
  uniqueSnapshotPath, removeIfExists,
} = require('./helpers');

const PORT = 3217;
const snapshotFile = uniqueSnapshotPath('self-mark');

let server, roomCode, mod, team, teamId, modState;
let thisRoundTick; // the team's tick in the current round (set by a test)
const sockets = [];

function open(cookie) {
  const s = connectSocket(server.base, roomCode, cookie);
  sockets.push(s);
  return s;
}

function card() {
  return modState.teams[teamId].bingoCard;
}

function score() {
  return modState.teams[teamId].score;
}

// Cells of the current round's category (matching) or of any other category.
function cells({ matching }) {
  const category = modState.currentCategory.id;
  const found = [];
  card().forEach((row, r) => row.forEach((cell, c) => {
    if ((cell.categoryId === category) === matching) found.push({ row: r, col: c, checked: cell.checked });
  }));
  return found;
}

async function tick(socket, row, col) {
  socket.emit('mark_correct', { teamId, row, col });
  await sleep(250);
}

async function playRound() {
  mod.emit('start_spin');
  await sleep(150);
  mod.emit('set_song', { title: 'Song', artist: 'Artist', year: '1999', spotifyUri: null });
  await sleep(250);
}

async function reveal() {
  mod.emit('reveal_solution');
  await sleep(250);
}

async function nextRound() {
  mod.emit('next_round');
  await sleep(250);
}

before(async () => {
  removeIfExists(snapshotFile);
  server = await startServer({ port: PORT, snapshotFile });
  const cookie = await login(server.base);
  roomCode = (await createRoom(server.base, cookie)).body.roomCode;

  mod = open(cookie);
  mod.on('game_state', (s) => { modState = s; });
  await waitForEvent(mod, 'connect');
  mod.emit('join', { role: 'moderator' });

  team = open();
  await waitForEvent(team, 'connect');
  teamId = (await joinTeam(team, { name: 'Alpha', emoji: '🚀' })).teamId;
  await sleep(200);
});

after(async () => {
  sockets.forEach((s) => s.disconnect());
  await stopServer(server);
  removeIfExists(snapshotFile);
});

test('a team cannot tick while the song is still playing', async () => {
  await playRound();
  const [cell] = cells({ matching: true });
  await tick(team, cell.row, cell.col);
  assert.equal(score(), 0);
});

test('while the solution is shown, a cell of another category is refused', async () => {
  await reveal();
  const [other] = cells({ matching: false });
  await tick(team, other.row, other.col);
  assert.equal(score(), 0);
});

test('a cell of the round\'s category can be ticked, but only one per round', async () => {
  const [first, second] = cells({ matching: true });
  await tick(team, first.row, first.col);
  assert.equal(score(), 1);
  await tick(team, second.row, second.col);
  assert.equal(score(), 1, 'a second tick in the same round is ignored');
});

test('the team can undo its tick of this round and pick another cell', async () => {
  const ticked = cells({ matching: true }).find((c) => c.checked);
  await tick(team, ticked.row, ticked.col);
  assert.equal(score(), 0, 'undone');
  const other = cells({ matching: true }).find((c) => !(c.row === ticked.row && c.col === ticked.col));
  await tick(team, other.row, other.col);
  assert.equal(score(), 1);
});

test('in the next round the team may tick again, but not undo an older tick', async () => {
  const older = cells({ matching: true }).find((c) => c.checked);
  await nextRound();
  await playRound();
  await reveal();

  await tick(team, older.row, older.col);
  assert.equal(card()[older.row][older.col].checked, true, 'older tick stays');

  const fresh = cells({ matching: true }).find((c) => !c.checked);
  await tick(team, fresh.row, fresh.col);
  assert.equal(score(), 2);
  thisRoundTick = fresh;
});

test('the moderator can tick anything, and removing the team\'s tick frees its turn', async () => {
  const other = cells({ matching: false }).find((c) => !c.checked);
  await tick(mod, other.row, other.col);
  assert.equal(score(), 3, 'moderator is not restricted');

  const teamTick = thisRoundTick;
  await tick(mod, teamTick.row, teamTick.col);
  assert.equal(score(), 2, 'moderator removed the team\'s tick');

  const retry = cells({ matching: true })
    .find((c) => !c.checked && !(c.row === teamTick.row && c.col === teamTick.col));
  await tick(team, retry.row, retry.col);
  assert.equal(score(), 3, 'team may tick again after the moderator undid its tick');
});
