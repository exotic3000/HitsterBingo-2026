# Hitster Bingo — Space Edition

Wirkliches Front- und Backend der Hitster Bingo TC Gameshow 2026.

## Start

```bash
npm install
cp .env.example .env   # einmalig, dann Passwort und Spotify-Zugangsdaten eintragen
node server.js
```

Der Server läuft standardmäßig auf Port 3000. Passwörter und Zugangsdaten stehen nie im Code (das Repository ist öffentlich), sondern in der `.env`-Datei neben `server.js`, die nicht ins Git-Repository kommt — oder in echten Umgebungsvariablen, die Vorrang haben. Ohne `SITE_PASSWORD` erzeugt der Server bei jedem Start ein zufälliges Passwort und zeigt es in der Konsole. Ohne `SPOTIFY_CLIENT_ID` und `SPOTIFY_CLIENT_SECRET` können Songs nur manuell eingetragen werden, und der automatische Moderator (siehe unten) steht nicht zur Verfügung.

## Betrieb auf dem Server

Produktiv läuft der Server auf einem Fedora-Rechner als **Benutzer-Dienst** (`systemd --user`) und ist über einen Cloudflare-Tunnel (`localhost:3001`) unter `https://bingo.hitsterquizshow.de` erreichbar. Ein System-Dienst funktioniert dort nicht, weil SELinux System-Diensten den Zugriff auf Ordner unter `/home` verbietet. Einrichtung und Befehle stehen in `deploy/hitster-bingo.service`; das Wichtigste:

```bash
git pull && systemctl --user restart hitster-bingo   # neuen Stand live nehmen
journalctl --user -u hitster-bingo -n 50 --no-pager  # Log ansehen
```

## Ansichten

| Ansicht | URL | Zweck |
|---|---|---|
| Startseite | `/` | Übersicht aller Ansichten |
| Beamer | `/display.html` | Drehrad, Timer & Lösung für die Leinwand |
| Moderation | `/moderator.html` | Spielsteuerung, Antworten & Bingokarten |
| Team | `/team.html` | Team erstellen, Antworten eingeben, eigene Bingokarte |
| QR-Code | `/qr.html` | Beitritts-Code zum Scannen, separat anzeigbar |
| Übersicht | `/overview.html` | Alle Bingokarten, Rangliste & Runde auf einen Blick |

Jede Ansicht bekommt vom Server nur die Daten, die sie anzeigt, und nur, wenn sich dafür etwas geändert hat. Team-Handys sehen ihre eigene Bingokarte und Antwort, aber keine fremden; der Beamer erfährt nur, *ob* ein Team geantwortet hat.

Alle Ansichten außer `/team.html` und `/join.html` sind mit dem Site-Passwort geschützt (`SITE_PASSWORD`, siehe `.env`). Das gilt auch für die Live-Verbindung: Nur angemeldete Geräte dürfen als Moderation, Beamer oder Übersicht auftreten und das Spiel steuern; ein Team-Handy kann nur für das eigene Team antworten und abhaken. Ohne festen `SESSION_SECRET` müssen sich Moderation, Beamer und Übersicht nach jedem Server-Neustart neu anmelden — sie leiten dann selbst zur Login-Seite weiter.

## Normaler Spielablauf (mit Moderation)

1. Teams treten über `/team.html` bzw. den QR-Code bei.
2. Auf `/moderator.html` **Drehen** klicken — das Rad auf dem Beamer wählt eine Kategorie.
3. Song auswählen (Spotify-Suche, zufälliger Song aus einer Playlist, oder manuell eingeben) und starten — der 60-Sekunden-Timer läuft los, sobald der Song auf dem Beamer zu hören ist (spätestens nach 6 Sekunden).
4. Teams tragen ihre Antwort ein und haken nach der Auflösung selbst die passende Zelle auf ihrer eigenen Bingokarte ab (dafür braucht es kein zweites Gerät).
5. **Lösung zeigen**, dann **Nächste Runde** — und von vorn.

Tastenkürzel auf der Moderationsseite: `D` Drehen, `K` Kategorie neu drehen, `S` Song starten, `Z` Zufälliger Song, `L` Lösung zeigen, `N` Nächste Runde, `R` Reset.

## Spotify-Wiedergabe über den Beamer

Die Musik läuft über den Spotify-Player in `/display.html`. Er startet von selbst, sobald die Runde mit Spotify verbunden ist (auch wenn der Beamer schon vorher offen war), und meldet sich beim Server als Abspielgerät an. Der Server startet und pausiert die Songs dann direkt bei Spotify.

- Voraussetzungen: Spotify Premium, Chrome oder Edge auf dem Beamer-Rechner, und einmal auf den Beamer klicken (Browser spielen ohne Klick keinen Ton ab).
- Pro Runde spielt nur ein Beamer-Tab. Ein neu geöffneter Beamer-Tab übernimmt; der alte bietet per Klick an, die Wiedergabe zurückzuholen.
- Die Moderation zeigt in der Spotify-Leiste, ob der Beamer-Player bereit ist, und darunter die letzte Fehlermeldung. Der Beamer zeigt Probleme unten links an.

## Automatischer Moderator

Wer selbst mitspielen statt moderieren möchte, kann den **automatischen Moderator** einschalten: Er übernimmt Drehen, Songauswahl, Timer, Auflösung und den Wechsel zur nächsten Runde komplett selbstständig, in Dauerschleife — man muss die Moderationsseite dafür nicht mehr bedienen.

**So aktivieren:**

1. Spotify muss verbunden sein (Button oben auf `/moderator.html`) — der automatische Moderator wählt Songs zufällig aus einer hinterlegten Playlist und braucht dafür Zugriff auf Spotify.
2. Auf `/moderator.html` im Kasten „🤖 Automatischer Moderator" die gewünschte Playlist auswählen und den Schalter umlegen.
3. Fertig — der Beamer läuft von selbst durch die Runden. Die manuelle Steuerung wird ausgeblendet, solange der Automatikmodus aktiv ist (Reset bleibt verfügbar).
4. Der Host kann jetzt selbst über `/team.html` als Team beitreten und mitspielen.

Ablauf einer automatischen Runde: Drehen → kurze Pause (Rad landet, Mystery-Auflösung falls nötig) → zufälliger Song wird geladen & gestartet → 60 Sekunden Antwortzeit → Lösung wird automatisch angezeigt → ca. 20 Sekunden Zeit zum Selbst-Abhaken der Bingokarten → nächste Runde.

Der Automatikmodus lässt sich jederzeit über denselben Schalter wieder ausschalten und übernimmt dann wieder normale manuelle Steuerung. Falls die Spotify-Verbindung während des Automatikmodus abbricht oder mehrfach kein Song aus der Playlist geladen werden kann, schaltet er sich selbst ab und zeigt eine Meldung an.

## Konfiguration

Einstellungen kommen aus der `.env`-Datei (Vorlage: `.env.example`) oder aus Umgebungsvariablen:

- `SITE_PASSWORD` — Passwort für die geschützten Ansichten (ohne Eintrag: zufällig pro Start, steht in der Konsole)
- `SESSION_SECRET` — fester Schlüssel für den Login-Cookie (ohne Eintrag werden beim Neustart alle ausgeloggt)
- `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` — Spotify-App-Zugangsdaten, ohne sie keine Spotify-Funktionen
- `SPOTIFY_REDIRECT_URI` — muss exakt im Spotify-Dashboard hinterlegt sein
- `PORT` — Server-Port (Standard 3000)
- `PLAYLIST_CACHE_TTL_MS` — wie lange eine geladene Playlist zwischengespeichert wird (Standard 1800000 = 30 Minuten)
- `PLAYBACK_CONFIRM_TIMEOUT_MS` — wie lange der Timer nach dem Songstart höchstens auf die Rückmeldung „Song läuft“ vom Beamer wartet (Standard 6000)

Playlists für den zufälligen Songwähler (manuell wie automatisch) werden in der Moderationsansicht im Kasten „Playlists“ verwaltet; `SPOTIFY_PLAYLISTS` in `server.js` liefert nur die Startwerte. Der Server lädt jede Playlist einmal komplett und hält sie 30 Minuten vor — ein Zufallssong braucht dann keine Anfrage an Spotify. Änderungen an einer Playlist in Spotify erscheinen deshalb spätestens nach 30 Minuten (oder sofort nach einem Server-Neustart).
