<p align="center">
  <img src="build-resources/icon.png" width="88" alt="NextNote-Logo">
</p>

<h1 align="center">NextNote</h1>

<p align="center">
  <b>Notizbücher wie in OneNote, gespeichert in deiner eigenen Nextcloud.</b><br>
  Für Windows und Android, gebaut für Tablets mit Stift (z. B. Galaxy Tab mit S Pen).
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/Lizenz-AGPL--3.0-7A3FB8" alt="Lizenz: AGPL-3.0"></a>
  <img src="https://img.shields.io/badge/Plattformen-Windows%20%7C%20Android-7A3FB8" alt="Plattformen: Windows und Android">
  <img src="https://img.shields.io/badge/Sync-Nextcloud%20(WebDAV)-0082C9" alt="Sync über Nextcloud">
</p>

<p align="center">
  <img src="docs/screenshots/hero.png" alt="NextNote unter Windows: Notizbücher links, Seitenliste, eine Mathe-Seite mit Text, Tags und handgezeichnetem Funktionsgraphen" width="900">
</p>

> **English:** NextNote is a OneNote-style note-taking app for Windows and Android with pen input. Notebooks are stored as plain JSON files in your own Nextcloud and synced between devices. The user interface is currently German only.

## Warum NextNote?

- **Deine Daten, dein Server.** Die Notizen liegen als lesbare Dateien in einem Ordner deiner Nextcloud. Ein Microsoft-Konto oder eine fremde Cloud brauchst du nicht.
- **Freie Seite wie in OneNote.** Text, Handschrift, Bilder und PDFs stehen dort auf der Seite, wo du sie hinsetzt.
- **Stift ist kein Nachgedanke.** Druckstufen, Handballenerkennung, die S-Pen-Seitentaste als Radierer und Lasso-Auswahl.
- **Offline zuerst.** Alles wird lokal gespeichert und synchronisiert, sobald eine Verbindung besteht. Gleichzeitige Änderungen auf mehreren Geräten werden pro Element zusammengeführt.

## Funktionen

**Organisation**
- Notizbücher → farbige Abschnitte → Seiten mit bis zu zwei Ebenen Unterseiten
- Verschieben per Drag & Drop oder Kontextmenü, auch zwischen Notizbüchern
- Suche über alle Notizbücher mit Hervorhebung auf der Seite
- Übersicht aller Tags und offenen Aufgaben über alle Notizbücher hinweg
- Papierkorb (60 Tage), Rückgängig/Wiederholen
- Seitenleisten lassen sich einklappen, damit die Seite den ganzen Bildschirm bekommt
- **Import aus OneNote** (Windows): ganze Notizbücher mit Text, Tabellen, Tags, Bildern und Handschrift übernehmen

**Seiten und Text**
- Textcontainer überall auf die Seite klicken, verschieben, Breite ändern
- Formatierung wie in OneNote: Schriftart und -größe, fett/kursiv/unterstrichen, Farben, Hervorheben, Listen, Einzüge, Ausrichtung, Überschriften, Zitat, Code, Tabellen, Links, Datum und Uhrzeit
- Tags: Aufgabe, Wichtig, Frage, Merken für später, Definition, Idee, Kritisch (Strg+1 bis Strg+7)
- Bilder aus Datei, Kamera, Zwischenablage oder per Drag & Drop
- **PDF-Ausdrucke**: Jede PDF-Seite wird als Bild eingefügt und lässt sich mit dem Stift beschriften
- Seitenhintergrund: Farbe, Linien, Karos oder Punkte
- Hell- und Dunkelmodus

**PDFs beschriften**
- Ein Abschnitt kann ein **Ordner deiner Nextcloud** sein (*Abschnitt hinzufügen → PDF-Ordner aus Nextcloud …*). Statt Seiten zeigt er die PDFs dieses Ordners, Unterordner aufklappbar wie Unterseiten
- Eine PDF öffnet sich mit ihren Seiten untereinander; Stift, Textmarker, Radierer, Lasso, Formen, Text und Bilder funktionieren wie auf jeder Seite
- Gespeichert wird **in die PDF selbst**, im gewählten Ordner, nicht im NextNote-Ordner. Die Anmerkungen sind normale PDF-Anmerkungen: Nextcloud, Acrobat, Samsung Notes und andere PDF-Programme zeigen sie an, der Inhalt der PDF bleibt unverändert
- Alle PDFs des Ordners liegen auch offline auf dem Gerät. Hochgeladen wird, wenn du die PDF schließt, nach 30 Sekunden ohne Eingabe, wenn die App in den Hintergrund geht oder mit Strg+S
- Haben zwei Geräte dieselbe PDF gleichzeitig beschriftet, werden die Anmerkungen zusammengeführt

**Stift**
- 4 Stifte und 3 Textmarker mit frei wählbarer Farbe und Stärke
- Radierer für ganze Striche oder punktgenau
- Lasso: verschieben, skalieren, Farbe ändern, duplizieren, kopieren
- Formen: Linie, Pfeil, Rechteck, Ellipse und drei Koordinatensysteme
- S Pen: zeichnet immer, auch im Textmodus; kurzes Tippen setzt den Cursor; **Seitentaste = Radierer**; der Finger scrollt und zoomt

**Synchronisierung**
- Anmeldung über den Nextcloud Login Flow: NextNote bekommt ein eigenes App-Passwort, das du in Nextcloud jederzeit widerrufen kannst
- Jede Seite ist eine eigene Datei. Änderungen an verschiedenen Elementen derselben Seite (z. B. Stift am Tablet, Text am PC) werden automatisch zusammengeführt
- Wurde derselbe Textcontainer auf zwei Geräten offline geändert, bleiben beide Fassungen erhalten (Konfliktkopie mit *Behalten*/*Verwerfen*)

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/tablet-pen.png" alt="Tablet-Ansicht mit eingeklappter Notizbuchleiste und geöffnetem Stift-Menü mit Stärken und Farben"></td>
    <td width="50%"><img src="docs/screenshots/tags.png" alt="Tag- und Aufgabenübersicht über alle Notizbücher neben einer Seite mit Tabelle"></td>
  </tr>
  <tr>
    <td align="center">Am Tablet: Stift-Menü mit Stärken, Farben und eigener Farbe</td>
    <td align="center">Alle offenen Aufgaben und Tags auf einen Blick</td>
  </tr>
  <tr>
    <td colspan="2"><img src="docs/screenshots/dark.png" alt="Dunkelmodus mit Tags, Aufgabenliste, Tabelle und Stiftanmerkung"></td>
  </tr>
  <tr>
    <td colspan="2" align="center">Dunkelmodus</td>
  </tr>
</table>

## Installation

Fertige Dateien gibt es unter [**Releases**](https://github.com/grunch2001/NextNote/releases).

### Windows

`NextNote-Setup-<version>.exe` ausführen. Ohne Installation geht es mit `NextNote-<version>-portable.exe`.

Das Installationsprogramm ist nicht code-signiert. Windows SmartScreen meldet deshalb eventuell „Der Computer wurde durch Windows geschützt“. Weiter geht es über **Weitere Informationen → Trotzdem ausführen**.

### Android

1. `NextNote-<version>.apk` auf das Gerät laden (z. B. über die Nextcloud-App oder per USB).
2. Die APK antippen. Beim ersten Mal fragt Android, ob die App, mit der du sie öffnest, **unbekannte Apps installieren** darf. Das musst du erlauben.
3. Falls Google Play Protect warnt: „Trotzdem installieren“.

Updates installierst du genauso; deine Notizen bleiben dabei erhalten.

Voraussetzung: Android 7.0 oder neuer. Optimiert und getestet ist die App auf einem Samsung Galaxy Tab S10 Lite mit S Pen.

## Erste Schritte

1. NextNote starten und die Adresse deiner Nextcloud eingeben (z. B. `https://cloud.example.de`) → **Mit Nextcloud verbinden**.
2. Im Browser bei Nextcloud anmelden und **Zugriff gewähren**.
3. Fertig. Auf jedem weiteren Gerät meldest du dich genauso an.

Alternativ kannst du im Reiter **App-Passwort** Benutzernamen und ein in Nextcloud erzeugtes App-Passwort eingeben. Wer erst einmal ausprobieren will, startet ohne Nextcloud und verbindet sich später in den Einstellungen.

## Von OneNote umziehen

Die Windows-App übernimmt Notizbücher, die in OneDrive liegen, über die offizielle OneNote-Schnittstelle von Microsoft (Microsoft Graph): **Datei → Importieren → Aus OneNote importieren …** oder der entsprechende Knopf auf dem Startbildschirm. Die Notizbücher werden als neue NextNote-Notizbücher angelegt und danach wie gewohnt mit Nextcloud synchronisiert, auch aufs Tablet. Dein OneNote bleibt unverändert.

Dafür braucht NextNote einmalig eine eigene **App-Registrierung bei Microsoft**. Sie ist kostenlos und dauert ein paar Minuten:

1. **Eigenes Verzeichnis anlegen** (nur bei einem persönlichen Microsoft-Konto wie outlook.com oder hotmail.com): Solche Konten haben bei Microsoft kein Verzeichnis (Mandant), und ohne Verzeichnis lässt sich keine App registrieren. Auf [azure.microsoft.com/free](https://azure.microsoft.com/free) mit demselben Konto **Kostenlos starten** durchlaufen. Dabei entsteht ein „Standardverzeichnis“, in dem du Administrator bist. Telefonnummer und Kreditkarte dienen nur der Identitätsprüfung; ohne Upgrade wird nichts berechnet. Mit einem Uni- oder Arbeitskonto entfällt dieser Schritt, sofern die Organisation App-Registrierungen erlaubt.
2. Auf [portal.azure.com](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade) anmelden. Falls nötig über dein Profil oben rechts → **Verzeichnis wechseln** das neue Standardverzeichnis wählen. Dann **App-Registrierungen** → **Neue Registrierung**.
3. Name beliebig (z. B. „NextNote“). Bei **Unterstützte Kontotypen** die Option mit „… und persönliche Microsoft-Konten“ wählen.
4. Bei **Umleitungs-URI** die Plattform „Öffentlicher Client/nativ (mobil und Desktop)“ wählen und `http://localhost` eintragen → **Registrieren**.
5. Die **Anwendungs-ID (Client)** von der Übersichtsseite kopieren und im Import-Dialog einfügen.

Meldet das Portal „User account … from identity provider 'live.com' does not exist in tenant 'Microsoft Services'“ (AADSTS16000/AADSTS50020), fehlt Schritt 1 oder das neue Verzeichnis ist nicht ausgewählt. „Ohne Zugriffstoken fortfahren“ hilft dann nicht weiter.

API-Berechtigungen musst du nicht eintragen: Bei der Anmeldung im Browser fragt Microsoft, ob NextNote deine Notizbücher lesen darf (`Notes.Read`).

**Was übernommen wird:** Abschnitte (Abschnittsgruppen als „Gruppe › Abschnitt“), Seiten mit Unterseiten, Erstelldatum und Titel, Textblöcke an ihrer Position mit Formatierung, Listen, Tabellen und Links, die Tags Aufgabe, Wichtig, Frage, Merken für später, Definition, Idee und Kritisch, Bilder und PDF-Ausdrucke sowie Handschrift mit Farbe, Stärke, Druckstufen und Textmarkern.

**Was fehlt:** Dateianhänge (auf der Seite steht ein Hinweis mit dem Dateinamen), Audio, eingebettete Videos (werden zum Link), Seitenfarbe und -linien; Formeln kommen höchstens als einfacher Text an. Die Reihenfolge der Abschnitte gibt Microsoft nicht heraus; sie werden nach Erstelldatum sortiert und lassen sich per Ziehen umordnen. Microsoft drosselt die Abfragen, deshalb dauern große Notizbücher eine Weile. Ein Abbruch ist jederzeit möglich; bereits importierte Seiten bleiben erhalten.

## Bedienung

| Aktion | So geht's |
| --- | --- |
| Text schreiben | Auf eine freie Stelle der Seite tippen und lostippen |
| Container verschieben / Breite ändern | Leiste über dem Text ziehen / rechten Rand ziehen |
| Handschrift | S Pen aufsetzen (Einstellung „Stift zeichnet immer“) oder im Reiter **Zeichnen** einen Stift wählen. Nochmal auf den aktiven Stift tippen öffnet Farbe und Stärke |
| Radieren | S-Pen-Seitentaste gedrückt halten oder Werkzeug **Radierer** (nochmal tippen → Modus und Größe) |
| Auswählen | **Lasso** im Reiter Zeichnen, oder mit der Maus ein Rechteck aufziehen. Auswahl ziehen = verschieben, runder Griff = skalieren |
| Scrollen / Zoomen | Finger ziehen / zwei Finger spreizen; am PC Mausrad und Strg+Mausrad |
| Kopieren & Einfügen | Auswahl → **Kopieren** in der Leiste über der Auswahl. Einfügen am Tablet: lange auf eine freie Stelle drücken → **Einfügen**; am PC Rechtsklick oder Strg+V. Text und Bilder aus anderen Apps funktionieren auch |
| PDF beschriften | **Einfügen → PDF-Ausdruck** oder PDF auf die Seite ziehen |
| PDFs aus einem Nextcloud-Ordner | *Abschnitt hinzufügen → PDF-Ordner aus Nextcloud …*, Ordner wählen. **+** in der Seitenleiste lädt eine PDF vom Gerät in den Ordner; Umbenennen und Löschen über das Kontextmenü „…“ |
| Seite/Abschnitt verschieben | Ziehen (am Tablet am Griff ⠿) oder Kontextmenü „…“ → *Verschieben nach …* |
| Unterseite | Kontextmenü einer Seite → *Tiefer stufen* oder Tab-Taste in der Seitenliste |

**Tastenkürzel (Windows):** Strg+N neue Seite · Strg+Alt+Umschalt+N Unterseite · Strg+T neuer Abschnitt · Strg+E/Strg+F Suche · Strg+S jetzt synchronisieren · Strg+Z/Strg+Y rückgängig/wiederholen · Strg+K Link · Strg+. Aufzählung · Strg+/ Nummerierung · Strg+Alt+1–3 Überschriften · Alt+Umschalt+D/T Datum/Uhrzeit · Entf löscht die Auswahl · F11 Vollbild

## So liegen die Daten in Nextcloud

```
NextNote/
  <Notizbuchname>/
    notebook.json            Name, Farbe, Reihenfolge
    sections/<id>.json       je Abschnitt
    pages/<id>.json          je Seite: Titel, Textcontainer, Striche, Bildverweise
    assets/<id>.png|jpg      Bilder und PDF-Seiten
```

- PDF-Abschnitte speichern unter `sections/` nur Name, Farbe und den Pfad ihres Nextcloud-Ordners. Die PDFs bleiben in diesem Ordner; NextNote schreibt seine Anmerkungen als PDF-Anmerkungen hinein (dazu, unsichtbar, die Originaldaten wie Druckstufen und formatierten Text, damit sie in NextNote bearbeitbar bleiben).
- Gelöschte Seiten liegen 60 Tage im NextNote-Papierkorb. Endgültig gelöschte Dateien landen zusätzlich im Papierkorb deiner Nextcloud.
- Einen Notizbuch-Ordner in der Nextcloud-Weboberfläche umzubenennen ist unproblematisch. Ihn zu löschen löscht das Notizbuch auf allen Geräten.

## Datenschutz und Sicherheit

- NextNote verbindet sich ausschließlich mit der Nextcloud, die du einträgst. Es gibt keine Telemetrie, keine Werbung und keine Drittanbieter-Dienste. Einzige Ausnahme ist der OneNote-Import, wenn du ihn startest: Dann meldet sich NextNote bei Microsoft an und liest deine Notizbücher. Der Zugriffsschlüssel dafür bleibt nur im Arbeitsspeicher, bis du den Import-Dialog schließt, und wird nur an Microsoft-Adressen geschickt.
- Statt deines Nextcloud-Passworts speichert NextNote ein eigenes App-Passwort. Du siehst es in Nextcloud unter *Einstellungen → Sicherheit* und kannst es dort widerrufen. Beim Abmelden in NextNote wird es automatisch widerrufen.
- Unter **Windows** ist das App-Passwort mit der Windows-Datenschutz-API (DPAPI) verschlüsselt, unter **Android** mit einem Schlüssel aus dem Android-Keystore, der das Gerät nicht verlassen kann.
- Unter Android schließt NextNote seine Daten von Android-Backups und von der Übertragung auf ein neues Gerät aus. Auf einem neuen Gerät meldest du dich einfach neu an, und deine Notizbücher kommen aus der Nextcloud. Synchronisiere vor einem Gerätewechsel, damit keine Änderung verloren geht.
- Verwende eine Nextcloud mit `https://`. Bei `http://` warnt NextNote, weil Passwort und Notizen dann unverschlüsselt übertragen würden.

## Entwicklung

NextNote ist eine Web-App (React, TypeScript, TipTap, Dexie/IndexedDB), die unter Windows in Electron und unter Android in Capacitor läuft.

Voraussetzung: **Node.js 24**.

```bash
npm install
npm run dev               # Web-Version im Browser (nur zum Entwickeln)
npm run mock-nextcloud    # lokale Test-Nextcloud auf http://127.0.0.1:8090 (Benutzer alice, Passwort secret)
npm test                  # Unit- und Sync-Tests, u. a. zwei Geräte gegen einen Mock-Server
npm run typecheck
npm run icons             # App-Icons aus build-resources/icon.svg erzeugen
```

### Aufbau

| Ordner | Inhalt |
| --- | --- |
| `src/model` | Datenmodell, Merge-Regeln (Last-Writer-Wins pro Element und Feld, Konfliktkopien), Dateiformate |
| `src/db` | Lokale Datenbank (IndexedDB über Dexie) und alle Änderungsoperationen |
| `src/sync` | WebDAV-Client, Nextcloud Login Flow v2, Sync-Engine (ETags, If-Match, Ordner-ETags, um unveränderte Notizbücher zu überspringen) |
| `src/pdf` | PDF-Ordner: Seitenlayout und Umrechnung in PDF-Koordinaten (auch gedrehte Seiten), Lesen und Schreiben der Anmerkungen mit `@cantoo/pdf-lib`, Abgleich mit dem Nextcloud-Ordner |
| `src/ink` | Stifteingabe, Gesten (Stift/Finger/Maus, Handballenerkennung, Zoom), Radierer, Lasso |
| `src/ui`, `src/editor` | Oberfläche (React) und Rich-Text-Editor (TipTap) |
| `src/import/onenote` | OneNote-Import: Microsoft-Anmeldung (OAuth mit PKCE), Graph-Client mit Drosselungs-Handling, Umwandlung des Seiten-HTML in Textcontainer und Bilder, InkML-Leser für die Handschrift |
| `electron/` | Windows-Hülle: HTTP über den Hauptprozess, App-Passwort per DPAPI verschlüsselt, Microsoft-Anmeldung im Systembrowser mit Rückleitung auf `localhost` |
| `android/` | Capacitor-Projekt mit drei eigenen Plugins: `NativeHttpPlugin` (OkHttp, weil WebDAV-Methoden wie PROPFIND und MKCOL mit dem Standard-HTTP von Capacitor nicht gehen), `NativeClipboardPlugin` (Zwischenablage inkl. Bildern) und `NativeSecureStoragePlugin` (App-Passwort, mit dem Android-Keystore verschlüsselt) |
| `tools/` | Build-Skripte, Mock-Nextcloud und Mock-Microsoft-Graph für die Tests, Icon-Erzeugung, End-to-End-Test der Windows-App |

### Windows-Version bauen

```bash
npm run dist:win          # → release/NextNote-Setup-x.y.z.exe und release/NextNote-x.y.z-portable.exe
```

Das Skript läuft unter Linux oder WSL. Beim ersten Mal lädt es eine portable Windows-Node nach `.tools/` (mit Prüfsumme), weil der NSIS-Schritt sonst Wine bräuchte. Wird aus einem VS-Code-Terminal gebaut, ist dort `ELECTRON_RUN_AS_NODE=1` gesetzt; das Skript entfernt die Variable für Windows-Prozesse.

### Android-Version bauen

Mit Android Studio oder dem Android SDK auf jedem Betriebssystem:

```bash
npm run android:sync      # Web-App bauen und nach android/ kopieren
cd android && ./gradlew assembleRelease
```

Unter WSL baut `npm run dist:android` die APK mit dem Android Studio, das unter Windows installiert ist (SDK am Standardort, Windows-Benutzer wird automatisch erkannt oder per `WIN_USER=...` gesetzt), und legt sie als `release/NextNote-x.y.z.apk` ab.

**Signieren:** Liegen `android/keystore.properties` und der dort genannte Keystore vor, wird die APK damit signiert:

```properties
storeFile=nextnote-release.keystore
storePassword=…
keyAlias=…
keyPassword=…
```

Beide Dateien sind per `.gitignore` vom Repository ausgeschlossen. Bewahre sie sicher auf: Ohne denselben Schlüssel lassen sich spätere Versionen nicht als Update über eine installierte App installieren.

## Grenzen der Version 1.2

- Keine Handschrifterkennung (Umwandlung in Text)
- OneNote-Import nur unter Windows und nur für Notizbücher in OneDrive; `.one`-Dateien lassen sich nicht direkt öffnen
- Keine Audioaufnahmen und keine Dateianhänge außer Bildern und PDF-Ausdrucken
- PDFs aus Nextcloud-Ordnern: Text in PDFs wird von der Suche nicht gefunden. Getippter Text erscheint in anderen PDF-Programmen in einer Standardschrift und vereinfacht (z. B. Tabellen); in NextNote bleibt er unverändert. Anmerkungen anderer Programme werden angezeigt, lassen sich in NextNote aber nicht bearbeiten. PDFs, die zum Öffnen ein Passwort brauchen, werden nicht unterstützt; PDFs, die nur gegen Änderungen geschützt sind, werden beim Speichern ohne diesen Schutz gespeichert
- Oberfläche nur auf Deutsch
- Das Windows-Installationsprogramm ist nicht code-signiert

## Lizenz

NextNote steht unter der [GNU Affero General Public License v3.0](LICENSE) (oder einer späteren Version). Du darfst die App frei nutzen, verändern und weitergeben. Wer eine veränderte Version weitergibt oder als Dienst anbietet, muss deren Quellcode ebenfalls unter der AGPL veröffentlichen.

NextNote ist ein unabhängiges Projekt und steht in keiner Verbindung zu Microsoft oder der Nextcloud GmbH. OneNote ist eine Marke der Microsoft Corporation, Nextcloud eine Marke der Nextcloud GmbH.
