# KIASY Benutzerhandbuch

## KI-Assistent System - Funktionen und Bedienung

Version 2.1 | Stand: Marz 2026

---

## Inhaltsverzeichnis

1. Erste Schritte
2. Chat-Grundlagen
3. Gedachtnis
4. Erinnerungen
5. Aufgaben-Delegation
6. Wissensbasis
7. E-Mail
8. Kalender
9. Websuche und Wetter
10. Sprachnachrichten
11. Bildgenerierung
12. Smart Home
13. Workflows
14. Web-Dashboard
15. Einstellungen
16. Tipps und Tricks

---

## 1. Erste Schritte

### Bot in Telegram finden

1. Offne Telegram
2. Suche nach dem Benutzernamen deines Bots (z.B. @mein_bot)
3. Sende /start
4. Der Bot stellt sich vor und stellt dir ein paar Fragen

### Telegram-Befehle

    /start   — Bot starten / Onboarding (beim ersten Mal)
    /hilfe   — Alle Fahigkeiten anzeigen
    /status  — Modell, Tools, Verlauf
    /reset   — Konversation zurucksetzen

Ansonsten schreibst du einfach in naturlicher Sprache.
Der Bot versteht was du meinst.

---

## 2. Chat-Grundlagen

Der Bot versteht naturliche Sprache. Du musst keine speziellen
Befehle oder Formate verwenden.

Beispiele:

    "Wie spat ist es?"
    "Was ist die Hauptstadt von Frankreich?"
    "Erklare mir was Docker ist"
    "Schreib mir eine Python-Funktion die Primzahlen findet"

### Konversations-Verlauf

Der Bot merkt sich das aktuelle Gesprach. Du kannst auf
vorherige Nachrichten Bezug nehmen:

    Du: "Suche nach den besten Pizza-Rezepten"
    Bot: [zeigt Ergebnisse]
    Du: "Zeig mir das dritte genauer"

Mit /reset wird der Verlauf geloscht und ein neues
Gesprach gestartet.

### Chat-Suche

Der gesamte Chat-Verlauf wird gespeichert. Du kannst
fruhere Gesprache durchsuchen:

    "Haben wir uber Docker gesprochen?"
    "Was habe ich letzte Woche uber das Projekt gesagt?"

---

## 3. Gedachtnis

Der Bot hat ein dauerhaftes Gedachtnis in drei Kategorien:

- **Fakten** — Informationen uber dich und deine Praferenzen
- **Todos** — Aufgaben und To-Dos
- **Notizen** — Freie Notizen

### Etwas merken

    "Merke dir: Meine Lieblingsfarbe ist blau"
    "Merke dir: Server-Passwort ist XYZ123"
    "Speichere als Todo: Steuererklarung machen"

### Abrufen

    "Was weisst du uber mich?"
    "Zeig mir meine Todos"
    "Was hast du dir gemerkt?"

### Loschen

    "Vergiss das mit der Lieblingsfarbe"
    "Losche das Todo Steuererklarung"

Das Gedachtnis uberlebt Neustarts und bleibt dauerhaft
gespeichert.

---

## 4. Erinnerungen

Der Bot kann dich zu bestimmten Zeitpunkten erinnern.

### Einfache Erinnerung

    "Erinnere mich morgen um 8 Uhr ans Meeting"
    "Erinnere mich in 30 Minuten den Ofen auszuschalten"
    "Erinnere mich am 15. April an die Steuererklarung"

### Wiederkehrende Erinnerungen

    "Erinnere mich jeden Tag um 9 Uhr an den Standup"
    "Erinnere mich wochentlich an den Bericht"

### Aufgaben-Erinnerungen

Du kannst dem Bot auch eine Aufgabe geben, die er zum
Erinnerungszeitpunkt automatisch ausfuhrt:

    "Prufe taglich um 9 Uhr alle Batteriesensoren unter 25%
     und sag mir welche schwach sind"

Der Bot fuhrt dann die Aufgabe aus und sendet dir das
Ergebnis.

### Verwalten

    "Welche Erinnerungen habe ich?"
    "Losche die Erinnerung zum Standup"

Erinnerungen konnen auch im Dashboard unter /reminders
verwaltet werden.

---

## 5. Aufgaben-Delegation

Delegiere Aufgaben an Kollegen, Mitarbeiter oder Familie.
Der Bot sendet die Aufgaben per E-Mail und fasst
automatisch nach.

VORAUSSETZUNG: E-Mail muss konfiguriert sein (IMAP/SMTP
oder Kerio Connect).

### Aufgaben delegieren

    "Schick Oliver (oliver@firma.de) diese Aufgaben:
     - Server-Backup prufen
     - SSL-Zertifikate erneuern
     Deadline Freitag, alle 2 Tage nachfassen"

Was passiert:
1. Oliver bekommt eine formatierte E-Mail mit den Aufgaben
2. Die Delegation wird im System gespeichert
3. Alle 2 Tage fasst der Bot automatisch nach (per Mail)
4. Du wirst per Telegram uber den Stand informiert

### Status abfragen

    "Was schuldet mir Oliver noch?"
    "Welche Aufgaben sind offen?"
    "Zeig mir alle Delegationen"

### Aufgaben als erledigt markieren

    "Oliver hat das Backup erledigt"
    "Die SSL-Zertifikate sind erneuert"

Wenn alle Aufgaben einer Delegation erledigt sind, wird
sie automatisch abgeschlossen.

### Stornieren

    "Storniere die Delegation an Oliver"

### Dashboard

Unter /delegations im Web-Dashboard siehst du:
- Statistik: Offene/Erledigte Delegationen, Aufgaben, Personen
- Aufgabenliste mit klickbaren Checkboxen
- Filter: Offen / Alle / Erledigt
- Stornieren-Button

Die Checkboxen haben drei Zustande:
  Leer    = offen
  Orange  = in Arbeit
  Grun    = erledigt

### Per Mail delegieren

Du kannst Aufgaben auch per Mail an den Bot senden.
Schreibe einfach eine Mail an die Bot-Adresse mit der
Anweisung:

    Betreff: Aufgaben fur Oliver
    Text: Bitte schick Oliver (oliver@firma.de) folgende
    Aufgaben: Server-Backup prufen, SSL erneuern.
    Alle 3 Tage nachfassen.

Der Bot erkennt die Anweisung und erstellt die Delegation
mit Follow-up automatisch.

---

## 6. Wissensbasis

Die Wissensbasis sind lokale Markdown-Notizen mit
Volltextsuche. Perfekt fur Dokumentation, Anleitungen,
Referenzen.

### Notiz erstellen

    "Erstelle eine Notiz: Docker Cheat Sheet
     docker ps - Container auflisten
     docker logs - Logs anzeigen
     docker exec -it bash - Shell offnen"

### Suchen

    "Suche in der Wissensbasis nach Docker"
    "Gibt es eine Notiz zu Passworten?"

### Lesen

    "Lies die Notiz Docker Cheat Sheet"

### Aktualisieren

    "Erganze die Docker-Notiz um: docker compose up -d"

### Dashboard

Unter /notes im Web-Dashboard gibt es einen vollstandigen
Editor mit Markdown-Vorschau, Tags und Seitenleiste.

---

## 7. E-Mail

Mails lesen und senden direkt uber den Bot.
Funktioniert mit Gmail, Outlook, Yahoo und jedem
IMAP/SMTP-fahigen Anbieter.

VORAUSSETZUNG: E-Mail muss in den Einstellungen
konfiguriert sein.

### Mails lesen

    "Zeig mir meine neuen Mails"
    "Habe ich ungelesene Mails?"
    "Lies die Mail von Oliver"

### Mails senden (nur wenn EMAIL_MODE=readwrite)

    "Schick Oliver eine Mail: Treffen morgen um 10?"

Senden funktioniert nur an Adressen die in der Whitelist
oder den erlaubten Domains stehen.

### Als gelesen markieren (nur wenn EMAIL_MARK_READ=true)

    "Markiere die Mail als gelesen"

### Berechtigungen

Die Berechtigungen werden in den Einstellungen gesteuert:
- Nur lesen (Standard)
- Lesen + Senden
- Als gelesen markieren

Senden ist nur an explizit erlaubte Domains/Adressen
moglich. Loschen ist nicht implementiert.

---

## 8. Kalender

Termine verwalten uber CalDAV. Funktioniert mit Google
Calendar, iCloud, Nextcloud, Radicale.

VORAUSSETZUNG: Kalender muss in den Einstellungen
konfiguriert sein.

### Termine anzeigen

    "Welche Termine habe ich diese Woche?"
    "Was steht morgen an?"
    "Zeig mir die nachsten 14 Tage"

### Termine erstellen (nur wenn CALDAV_MODE=readwrite)

    "Erstelle einen Termin: Meeting mit Oliver,
     morgen 10:00 bis 11:00 Uhr"

### Termine loschen (nur wenn CALDAV_MODE=readwrite)

    "Losche den Termin mit Oliver"

---

## 9. Websuche und Wetter

### Websuche

    "Suche im Web nach den besten Linux-Distros 2026"
    "Was ist gerade in den Nachrichten?"
    "Suche nach Node.js Best Practices"

Der Bot nutzt DuckDuckGo und kann auch Webseiten direkt
lesen:

    "Lies diese Webseite: https://example.com/artikel"

### Wetter

    "Wie wird das Wetter morgen?"
    "Wetter in Hamburg"
    "5-Tage-Vorhersage fur Berlin"

Die Standard-Stadt wird aus deiner Konfiguration genommen.
Du kannst aber jederzeit eine andere Stadt angeben.

---

## 10. Sprachnachrichten

VORAUSSETZUNG: Sprachnachrichten mussen bei der Installation
aktiviert worden sein (Whisper + Edge-TTS).

### Sprachnachricht senden

Sende einfach eine Sprachnachricht in Telegram. Der Bot:
1. Transkribiert deine Sprache (Whisper)
2. Verarbeitet den Text wie eine normale Nachricht
3. Antwortet als Sprachnachricht zuruck (Edge-TTS)

---

## 11. Bildgenerierung

VORAUSSETZUNG: OpenAI API-Key muss konfiguriert sein.

    "Generiere ein Bild von einem Sonnenuntergang am Meer"
    "Male mir eine Katze die auf einem Einhorn reitet"
    "Erstelle ein Logo fur meine Firma in Blautonen"

Der Bot nutzt DALL-E 3 und sendet das Bild direkt in den
Chat.

---

## 12. Smart Home (Home Assistant)

VORAUSSETZUNG: Home Assistant muss konfiguriert sein.

### Gerate steuern

    "Schalte das Licht im Wohnzimmer ein"
    "Mach das Licht aus"
    "Heizung im Bad auf 22 Grad"

### Status abfragen

    "Wie warm ist es im Wohnzimmer?"
    "Welche Lichter sind an?"
    "Zeig mir alle Sensoren"

### Verlauf

    "Temperaturverlauf im Wohnzimmer der letzten 24 Stunden"

---

## 13. Workflows

Mehrstufige Aufgaben die der Bot selbststandig abarbeitet.

    "Erstelle einen Workflow: Prufe ob der Server erreichbar
     ist. Wenn nicht, warte 5 Minuten und prufe nochmal.
     Wenn immer noch nicht, sende mir eine Warnung."

Workflows konnen im Dashboard unter /workflows verwaltet
werden.

---

## 14. Web-Dashboard

Das Dashboard erreichst du unter:

    https://DEIN-SERVER:3333

### Seiten-Ubersicht

Monitor (/)
  Live-Events in Echtzeit. Zeigt alle Aktionen,
  Fehler und System-Meldungen.

Chat (/chat)
  Web-Chat als Alternative zu Telegram. Kann als
  PWA installiert werden (App-Symbol im Browser).

System (/system)
  CPU, RAM, Disk, Temperaturen, Systembereinigung.

Einstellungen (/settings)
  Profilbild, Bot-Name, Theme, alle Konfiguration.
  Nach Anderungen "Neustart" klicken.

Wissensbasis (/notes)
  Markdown-Editor mit Live-Vorschau und Tag-System.

Erinnerungen (/reminders)
  Alle Erinnerungen mit Status, Zeiten und Intervallen.

Delegationen (/delegations)
  Delegierte Aufgaben mit Statistik, Filtern und
  klickbaren Checkboxen.

Terminal (/terminal)
  Web-Terminal mit Quick Actions:
  - Bot neustarten
  - KIASY Update
  - Service-Logs anzeigen
  - System neustarten/herunterfahren

Tools (/tools)
  Tools aktivieren/deaktivieren, eigene erstellen.

Workflows (/workflows)
  Aktive und abgeschlossene Workflows.

Roadmap (/roadmap)
  Projekt-ToDo-Board mit Status und Prioritaten.

Theme-Editor (/theme-editor)
  Themes erstellen und anpassen. Eingebaute Themes
  konnen als Custom-Kopie bearbeitet werden.
  Eingebaute Themes: classic, tron, joy.

Smart Home (/ha-editor)
  Home Assistant Gerateliste bearbeiten.

---

## 15. Einstellungen

Einstellungen konnen auf zwei Wegen geandert werden:

### Im Dashboard (/settings)

- Profil — Profilbild hochladen (wird auch als Telegram-Foto gesetzt)
- Personalisierung — Bot-Name, dein Name, Stadt, Sprache, Zeitzone
- Erscheinungsbild — Theme wahlen
- Monitor — Benutzername und Passwort
- KI-Modell — Provider, Modell, API-Keys
- Sprache — TTS-Stimme, Whisper-Modell
- E-Mail — IMAP/SMTP Zugangsdaten und Berechtigungen
- Kalender — CalDAV Zugangsdaten und Berechtigungen
- Telegram — Bot-Token, Whitelist
- Home Assistant — URL und Token
- Kerio Connect — Mailserver-Einstellungen
- Wissensbasis — Git-Backup

Nach dem Speichern den Neustart-Button klicken.

### Per Datei

    nano ~/kiasy/.env
    sudo systemctl restart kiasy

---

## 16. Tipps und Tricks

### Selbst-Erweiterung

Der Bot kann sich selbst neue Fahigkeiten beibringen:

    "Baue dir ein Tool das den aktuellen Bitcoin-Kurs
     abruft"

Er erstellt dann automatisch eine neue Tool-Datei und
ladt sie beim nachsten Nachrichteneingang.

### Shell-Befehle

Der Bot kann Befehle auf dem Server ausfuhren:

    "Wie viel Speicher ist noch frei?"
    "Zeig mir die letzten 10 Zeilen der Logdatei"
    "Installiere htop"

### Dateien

    "Lies die Datei /home/user/config.json"
    "Erstelle eine Datei mit folgendem Inhalt..."
    "Welche Dateien sind im Downloads-Ordner?"

### Zusammenfassungen

    "Gib mir eine Zusammenfassung aller offenen Aufgaben"
    "Was habe ich heute alles gemacht?"
    "Fasse die letzten 5 Mails zusammen"

### Mehrere Anfragen

Du kannst dem Bot auch mehrere Dinge auf einmal sagen:

    "Wie wird das Wetter morgen? Und erinnere mich um 8
     an den Regenschirm falls es regnet."

### Updates

Im Terminal (/terminal) gibt es den Button "KIASY Update"
oder per Kommandozeile:

    cd ~/kiasy
    bash scripts/update.sh

---

KIASY - KI-Assistent System
https://github.com/micdede/kiasy
