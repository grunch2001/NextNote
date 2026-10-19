# NextNote

OneNote-artige Notiz-App für **Windows** und **Android** (optimiert für das Galaxy Tab S10 Lite mit S Pen), die ihre Notizbücher in deiner **Nextcloud** speichert und darüber zwischen allen Geräten synchronisiert.

- Notizbücher → Abschnitte → Seiten (mit Unterseiten), farbige Abschnitte, Drag & Drop
- Freie Seite: Textcontainer überall hinklicken, verschieben, Breite ändern
- Formatierung wie in OneNote: Schriftart/-größe, fett/kursiv/…, Farben, Hervorheben, Listen, Einzüge, Ausrichtung, Überschriften, Zitat, Code, Tabellen, Links, Datum/Uhrzeit
- Tags: Aufgabe (Strg+1), Wichtig (Strg+2), Frage (Strg+3), Merken (Strg+4), Definition (Strg+5), Idee (Strg+6), Kritisch (Strg+7), Übersicht aller offenen Aufgaben in der Suche
- Stifteingabe mit Druckstufen: 4 Stifte, 3 Textmarker, Radierer (ganze Striche oder punktgenau), Lasso (verschieben, skalieren, Farbe ändern, duplizieren), Formen (Linie, Pfeil, Rechteck, Ellipse)
- S Pen: zeichnet immer (auch im Textmodus), kurzes Tippen setzt den Cursor, **Seitentaste = Radierer**, Finger scrollt/zoomt, Handballenerkennung
- Bilder (Datei, Kamera, Einfügen aus der Zwischenablage, Drag & Drop) und **PDF-Ausdrucke** zum Beschriften mit dem Stift
- Seitenhintergrund: Farbe, Linien, Karos, Punkte
- Suche über alle Notizbücher mit Hervorhebung auf der Seite
- Papierkorb (60 Tage), Rückgängig/Wiederholen, Hell/Dunkel-Design
- Offline-fähig: alles wird lokal gespeichert und synchronisiert, sobald eine Verbindung besteht

## Installation

Die fertigen Dateien liegen im Ordner `release/`
(unter Windows erreichbar über `\\wsl.localhost\Ubuntu\home\luiss\GitHubLokalWSL\NextNote\release`).

### Windows

`NextNote-Setup-1.0.0.exe` ausführen. Das Installationsprogramm ist nicht signiert; Windows SmartScreen zeigt deshalb ggf. „Der Computer wurde durch Windows geschützt“ → **Weitere Informationen → Trotzdem ausführen**.
Alternativ ohne Installation: `NextNote-1.0.0-portable.exe`.

### Android (Galaxy Tab S10 Lite)

1. `NextNote-1.0.0.apk` aufs Tablet bringen, z. B. in deine Nextcloud hochladen und in der Nextcloud-App öffnen, oder per USB-Kabel kopieren.
2. Die APK antippen. Beim ersten Mal fragt Android, ob die App (z. B. „Eigene Dateien“ oder „Nextcloud“) **unbekannte Apps installieren** darf → erlauben.
3. Falls Google Play Protect warnt: „Trotzdem installieren“.

Updates installierst du genauso; deine Notizen bleiben erhalten, solange die APK mit demselben Schlüssel signiert ist (siehe unten).

## Erste Schritte

1. NextNote starten → Adresse deiner Nextcloud eingeben (z. B. `https://cloud.example.de`) → **Mit Nextcloud verbinden**.
2. Im Browser bei Nextcloud anmelden und **Zugriff gewähren**. NextNote erhält ein eigenes App-Passwort (sichtbar und widerrufbar in Nextcloud unter *Einstellungen → Sicherheit*).
3. Fertig. Notizbücher landen im Ordner `NextNote/` deiner Nextcloud; auf dem zweiten Gerät genauso anmelden.

Alternativ: Reiter „App-Passwort“ mit Benutzername und einem in Nextcloud erzeugten App-Passwort.

## Bedienung

| Aktion | So geht's |
| --- | --- |
| Text schreiben | Mit Maus/Finger auf eine freie Stelle der Seite tippen und lostippen |
| Container verschieben / Breite ändern | Leiste über dem Text ziehen / rechten Rand ziehen |
| Handschrift | S Pen einfach aufsetzen (Einstellung „Stift zeichnet immer“) oder im Reiter **Zeichnen** einen Stift wählen; nochmal auf den aktiven Stift tippen → Farbe & Stärke |
| Radieren | S-Pen-Seitentaste gedrückt halten, oder Werkzeug **Radierer** (nochmal tippen → Modus/Größe) |
| Auswählen | **Lasso** im Reiter Zeichnen; mit der Maus im Textmodus ein Rechteck aufziehen oder einen Strich anklicken. Auswahl ziehen = verschieben, runder Griff = skalieren |
| Scrollen / Zoomen | Finger ziehen / zwei Finger spreizen; am PC Mausrad und Strg+Mausrad |
| PDF beschriften | **Einfügen → PDF-Ausdruck** (oder PDF auf die Seite ziehen) |
| Seite/Abschnitt verschieben | Ziehen (am Tablet am Griff ⠿) oder Kontextmenü „…“ → *Verschieben nach …* |
| Unterseite | Kontextmenü einer Seite → *Tiefer stufen* oder Tab-Taste in der Seitenliste |

Tastenkürzel (Windows): Strg+N neue Seite · Strg+Alt+Umschalt+N Unterseite · Strg+T neuer Abschnitt · Strg+E/Strg+F Suche · Strg+S jetzt synchronisieren · Strg+Z/Strg+Y rückgängig/wiederholen · Strg+K Link · Strg+. Aufzählung · Strg+/ Nummerierung · Strg+Alt+1–3 Überschriften · Alt+Umschalt+D/T Datum/Uhrzeit · Entf löscht die Auswahl · F11 Vollbild.

## So liegen die Daten in Nextcloud

```
NextNote/
  <Notizbuchname>/
    notebook.json            Name, Farbe, Reihenfolge
    sections/<id>.json       je Abschnitt
    pages/<id>.json          je Seite: Titel, Textcontainer, Striche, Bildverweise
    assets/<id>.png|jpg      Bilder und PDF-Seiten
```

- Jede Seite ist eine eigene Datei. Änderungen an verschiedenen Seiten oder an verschiedenen Elementen derselben Seite (z. B. Stift am Tablet, Text am PC) werden automatisch zusammengeführt.
- Wurde **derselbe Textcontainer** auf zwei Geräten gleichzeitig offline bearbeitet, bleiben beide Fassungen erhalten; die ältere erscheint als markierte „Konfliktkopie“ mit *Behalten*/*Verwerfen*.
- Gelöschte Seiten liegen 60 Tage im NextNote-Papierkorb; endgültig gelöschte Dateien zusätzlich im Papierkorb deiner Nextcloud.
- Einen Notizbuch-Ordner in der Nextcloud-Weboberfläche umzubenennen ist unproblematisch; ihn zu löschen löscht das Notizbuch auf allen Geräten.

## Entwicklung

Voraussetzungen (WSL): Node 24. Für die Builds werden die auf Windows installierten Werkzeuge genutzt (Android Studio inkl. SDK und JBR).

```bash
npm install
npm run dev               # Web-Version im Browser (nur zum Entwickeln)
npm run mock-nextcloud    # lokale Test-Nextcloud auf http://127.0.0.1:8090 (alice / secret)
npm test                  # Unit- und Sync-Tests (u. a. zwei Geräte gegen einen Mock-Server)
npm run typecheck
npm run dist:win          # → release/NextNote-Setup-x.y.z.exe und portable .exe
npm run dist:android      # → release/NextNote-x.y.z.apk (signiert)
npm run icons             # App-Icons aus build-resources/icon.svg erzeugen
```

Aufbau:

- `src/model` – Datenmodell, Merge-Regeln (Last-Writer-Wins pro Element/Feld, Konfliktkopien), Dateiformate
- `src/db` – lokale Datenbank (IndexedDB/Dexie) und alle Änderungsoperationen
- `src/sync` – WebDAV-Client, Nextcloud Login Flow v2, Sync-Engine (ETags, If-Match, Ordner-ETags zum Überspringen unveränderter Notizbücher)
- `src/ink` – Stifteingabe, Gesten (Stift/Finger/Maus, Handballenerkennung, Zoom), Radierer, Lasso
- `src/ui`, `src/editor` – Oberfläche (React), Rich-Text-Editor (TipTap)
- `electron/` – Windows-Hülle (HTTP über den Hauptprozess, Passwort per Windows-DPAPI verschlüsselt)
- `android/` – Capacitor-Projekt mit eigenem OkHttp-Plugin `NativeHttpPlugin` (WebDAV-Methoden wie PROPFIND/MKCOL sind mit dem Standard-HTTP von Capacitor nicht möglich)

### Signierschlüssel für Android sichern

`android/nextnote-release.keystore` und `android/keystore.properties` (Passwort) sind **nicht** im Git und müssen gesichert werden. Ohne sie lassen sich künftige Versionen nicht als Update über die installierte App installieren (man müsste deinstallieren; ungesynchte lokale Änderungen gingen dabei verloren).

### Hinweise

- `npm run dist:android` baut im Ordner `C:\Users\luiss\AppData\Local\NextNoteBuild` (Gradle unter Windows), `npm run dist:win` lädt beim ersten Mal eine portable Windows-Node nach `.tools/`.
- Wird aus einem VS-Code-Terminal gebaut, ist dort `ELECTRON_RUN_AS_NODE=1` gesetzt; die Skripte entfernen die Variable für Windows-Prozesse. Wer `NextNote.exe` von Hand aus diesem Terminal startet, muss das ebenfalls tun.

## Grenzen der Version 1.0

- Keine Handschrifterkennung (Umwandlung in Text) und kein Import von `.one`-Dateien aus OneNote
- Keine Audioaufnahmen und keine Dateianhänge außer Bildern/PDF-Ausdrucken
- Das Windows-Installationsprogramm ist nicht code-signiert
