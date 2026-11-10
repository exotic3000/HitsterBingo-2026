# Messszenario: Performance & Robustheit der Gameshow

Ziel: vor einer Veranstaltung belastbar wissen, **wie viele Teilnehmende der
Server verkraftet**, **wie sich ein schlechtes Hallen-WLAN anfühlt** und
**ob Spielstände Netzwechsel, Abbrüche und Abstürze überleben** — gemessen,
nicht geschätzt.

```bash
node loadtest/run.js <szenario> [--option=wert …]
```

Jeder Lauf startet einen eigenen `node server.js` auf Port 3400 (Proxy 3401,
3410+) mit Testpasswort und eigener Snapshot-Datei — der laufende
Produktivserver und seine `.env` werden nie berührt. Ergebnisse landen als
JSON in `loadtest/results/` (git-ignoriert), der Exit-Code ist 0 bei PASS.

## Was simuliert wird

Pro Spielrunde (Raum): 1 Moderation, 1 Beamer, 1 Übersicht, bis zu 10 Teams
(`MAX_TEAMS`) und optional `--lurkers` Handys, die nur die Team-Seite offen
haben (QR gescannt, nicht beigetreten — sie bekommen trotzdem jeden
Spielstand). Alle Geräte verbinden sich gleichzeitig (QR-Code-Ansturm),
dann treten alle Teams gleichzeitig bei. Danach spielen alle Räume
parallel echte Runden über die echten Socket-Events:

`start_spin` → `set_song` → Teams antworten (`submit_answer`) →
`reveal_solution` → Teams haken ab (`mark_correct`) → `next_round`.

Die simulierten Geräte melden sich nach einem Abbruch genauso wieder an wie
die echten Seiten (`shared.js`/`team.js`: Rolle neu senden, Team mit
`teamId` + `teamSecret` fortsetzen).

## Messgrößen

| Messgröße | Bedeutung | Wie gemessen |
|---|---|---|
| `fanout_ms` (+ `_spin/_song/_reveal/_next`) | Verzögerung, bis **jedes** Gerät im Raum eine Moderationsaktion anzeigt | Aktion senden → Zustand mit passendem `gameState`/`spinToken` kommt an |
| `fanout_complete_ms` | bis das **langsamste** Gerät des Raums nachgezogen hat | Maximum pro Aktion |
| `answer_ms` | Team tippt Antwort → Moderation sieht sie | `answers[teamId]` im Moderationszustand |
| `mark_ms` | Team hakt Feld ab → eigene Karte zeigt es | Bingo-Zelle wechselt `checked` |
| `join_ack_ms`, `connect_ms` | Beitritt/Verbindungsaufbau beim Ansturm | Ack- bzw. `connect`-Zeit |
| `reconnect_ms` | Abbruch → wieder angemeldet (Team fortgesetzt) | `disconnect` → erfolgreiches `join`-Ack |
| `tick_jitter_ms` | Abweichung der Timer-Ticks von 1000 ms = **Event-Loop-Verzögerung des Servers** | eigene Übersicht-Verbindung direkt am Server, ohne Proxy |
| `server_cpu_pct`, `server_rss_mb` | CPU (% eines Kerns) und Speicher des Serverprozesses | `/proc/<pid>` jede Sekunde |
| `client_loop_lag_ms` | Überlast des **Lastgenerators** selbst | wenn hoch, sind alle Latenzen zu hoch gemessen → Clients auf 2. Rechner |
| `state_bytes`, `proxy_bytesToClient` | Datenmenge, die die Geräte herunterladen müssen | Summe der `game_state`-Payloads |

**Robustheitszähler — müssen 0 sein:** `join_failed`, `connect_timeouts`,
`fanout_timeouts` (Gerät hat einen Zustand nie bekommen), `answer_lost`,
`mark_lost`, `teams_lost` (Team verschwunden, obwohl das Handy verbunden ist),
`reconnect_failed`, `state_divergence` (Gerät zeigt am Ende etwas anderes als
die Moderation), `crash_teams_lost`.

## Grenzwerte (PASS/FAIL)

| | ungestörtes Netz | gestörtes Netz |
|---|---|---|
| `fanout_ms` p95 | ≤ 250 ms | ≤ 2500 ms |
| `answer_ms` p95 | ≤ 250 ms | ≤ 2500 ms |
| `mark_ms` p95 | ≤ 250 ms | ≤ 2500 ms |
| `join_ack_ms` p95 | ≤ 500 ms | ≤ 4000 ms |
| `tick_jitter_ms` p99 | ≤ 100 ms | ≤ 100 ms |
| `server_cpu_pct` p95 | ≤ 70 % | ≤ 70 % |

Begründung: 250 ms nimmt am Tisch niemand als Verzögerung wahr; ab etwa 2,5 s
ist ein Team beim 60-s-Timer merklich benachteiligt bzw. die Moderation
„hängt“. 70 % CPU lässt Reserve für Spitzen (Node ist single-threaded —
100 % heißt: alles wird gleichzeitig langsamer). Die Grenzen stehen in
`BUDGETS` in `run.js` und lassen sich dort anpassen.

## Szenarien

| Szenario | Risikofaktor | Voreinstellung |
|---|---|---|
| `baseline` | Referenzwert, ein Raum, sauberes Netz | 1 Raum, 10 Teams, 3 Runden |
| `scale` | viele Teilnehmende / viele parallele Gruppen | Stufen 1,5,10,25,50 Räume, je 5 Zuschauer-Handys |
| `burst` | alle Teams antworten in derselben Sekunde (Timer-Ende) | 20 Räume, Antwortfenster 50 ms |
| `badnet` | überlastetes Hallen-WLAN | 300 ms Latenz + bis 400 ms Jitter, 64 kbit/s je Gerät, 30 Abbrüche/min |
| `polling` | WLAN/Proxy blockiert WebSockets → Long-Polling | 150 ms + 100 ms Jitter, nur `polling` |
| `halfopen` | Handy wechselt WLAN ↔ Mobilfunk; der Server sieht den alten Socket erst nach dem Ping-Timeout (~45 s) als tot | 5 Teams, Karenzzeit per `TEAM_DISCONNECT_GRACE_MS` auf 5 s verkürzt |
| `crash` | Server-Absturz (`kill -9`) mitten im Spiel, Neustart | 5 Räume; `--crashDelay=0` (direkt nach den letzten Aktionen) und `--crashDelay=31000` (nach einem Snapshot) |

Jede Option ist überschreibbar, z. B. Masse und schlechtes Netz kombiniert:

```bash
node loadtest/run.js scale --steps=10,25 --latency=200 --jitter=300 --kbps=128 --resetsPerMin=20
```

Optionen: `rooms`, `steps`, `teams`, `lurkers`, `rounds`, `latency`, `jitter`
(ms), `kbps` (je Gerät und Richtung), `resetsPerMin`, `transport`
(`websocket`/`polling`), `answerWindow`, `spinMs`, `playMs`, `timeoutMs`,
`halfOpenTeams`, `grace`, `crash`, `crashDelay`.

## Durchführung vor einer Veranstaltung

1. `baseline` → muss PASS sein, sonst ist etwas grundsätzlich kaputt.
2. `scale` bis zur erwarteten Teilnehmerzahl × 2 (Sicherheitsfaktor). Die
   Stufe, ab der `fanout_ms` p95 oder `server_cpu_pct` p95 reißt, ist die
   **Kapazitätsgrenze**.
3. `badnet`, `polling`, `burst` → Verhalten bei schlechten Bedingungen.
4. `halfopen` und `crash` (beide `crashDelay`-Varianten) → Datenverlust.
5. Ergebnis-JSONs aufheben und nach Code-Änderungen erneut vergleichen.

## Grenzen der Aussagekraft

- Der Lastgenerator läuft auf demselben Rechner wie der Server und teilt sich
  die CPU mit ihm. Meldet `client_loop_lag_ms` WARN, die Clients auf einem
  zweiten Rechner starten.
- Der Proxy stellt Latenz, Bandbreite und Verbindungsabbrüche nach, aber
  keinen Paketverlust auf IP-Ebene. Den gibt es zusätzlich mit
  `sudo tc qdisc add dev lo root netem delay 200ms 100ms loss 5%`
  (aufheben: `sudo tc qdisc del dev lo root`).
- Cloudflare-Tunnel, Spotify und echte Browser (Rendern, Sound) sind nicht
  Teil der Messung — ein Probelauf mit echten Handys über
  `bingo.hitsterquizshow.de` bleibt als Abschluss sinnvoll.
