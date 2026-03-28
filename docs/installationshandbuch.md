# KIASY Installationshandbuch

## KI-Assistent System - Schritt-fur-Schritt Installation

Version 2.1 | Stand: Marz 2026

---

## Inhaltsverzeichnis

1. Voraussetzungen
2. System vorbereiten
3. KIASY herunterladen
4. Installation starten
5. Personalisierung
6. KI-Modell wahlen
7. Telegram Bot einrichten
8. Optionale Features
9. Monitor Dashboard
10. Installation abschliessen
11. Erster Start
12. Haufige Fragen

---

## 1. Voraussetzungen

### Hardware
- Computer/Server mit Ubuntu 24.04 (oder hoher)
- Mindestens 2 GB RAM
- Mindestens 10 GB freier Speicher
- Internetzugang

### Accounts (werden wahrend der Installation erklart)
- **Telegram Account** (kostenlos) - zum Chatten mit deinem Bot
- **KI-Provider** - mindestens einer:
  - Ollama (kostenlos, empfohlen fur den Einstieg)
  - Groq (kostenlos, Cloud)
  - Anthropic Claude (bezahlt, beste Qualitat)
  - OpenAI GPT (bezahlt)

### Optional
- Gmail/Outlook Account (fur E-Mail Integration)
- CalDAV-Kalender (Google Calendar, iCloud, Nextcloud)
- Home Assistant (fur Smart Home)

---

## 2. System vorbereiten

Offne ein Terminal auf deinem Ubuntu-System. Das geht mit der
Tastenkombination Strg+Alt+T oder uber das Anwendungsmenu.

Stelle sicher, dass dein System aktuell ist:

    sudo apt update && sudo apt upgrade -y

---

## 3. KIASY herunterladen

Fuhre diese beiden Befehle im Terminal aus:

    git clone https://github.com/micdede/kiasy.git
    cd kiasy

Falls git nicht installiert ist:

    sudo apt install -y git
    git clone https://github.com/micdede/kiasy.git
    cd kiasy

---

## 4. Installation starten

Starte das interaktive Installations-Script:

    bash scripts/install.sh

Du siehst jetzt das KIASY-Logo und wirst Schritt fur Schritt
durch die Konfiguration gefuhrt.

TIPP: Bei allen Fragen kannst du mit Enter den Standardwert
in eckigen Klammern [Standard] ubernehmen.

---

## 5. Personalisierung

### 5.1 Bot-Name

    Wie soll dein Bot heissen? [KIASY]:

Gib deinem Assistenten einen Namen. Das kann alles sein:
JARVIS, FRITZ, LUNA, ALFRED, JOY, ...
Dieser Name erscheint uberall: im Chat, im Dashboard, bei
Erinnerungen.

Beispiel: JARVIS (Enter)

### 5.2 Dein Name

    Wie heisst du (Vorname)? [ubuntu]:

Dein Vorname. Der Bot spricht dich damit an.

Beispiel: Michael (Enter)

### 5.3 Stadt

    In welcher Stadt wohnst du? (fur Wetter, lokale Infos) [Berlin]:

Wird fur Wetterabfragen und lokale Informationen verwendet.
Nicht deine Adresse - nur die Stadt.

Beispiel: Hamburg (Enter)

### 5.4 Zeitzone

    Zeitzone? [Europe/Berlin]:

Wird automatisch erkannt. In Deutschland einfach mit Enter
bestatigen.

WICHTIG: Das Format muss "Europe/Berlin" sein,
NICHT "Europa/Berlin".

### 5.5 Sprache

    In welcher Sprache soll der Bot antworten?
    [1] Deutsch
    [2] English

Wahle mit 1 oder 2. Standard: Deutsch.

---

## 6. KI-Modell wahlen

    Welchen LLM-Provider mochtest du nutzen?
    [1] Anthropic (Claude)
    [2] Ollama (lokal/selbst gehostet)
    [3] Groq (kostenlos, schnell)
    [4] OpenAI (GPT)

### Option 1: Anthropic Claude (bezahlt, beste Qualitat)

1. Erstelle einen Account: https://console.anthropic.com
2. Erstelle einen API-Key: https://console.anthropic.com/settings/keys
3. Gib den Key ein wenn gefragt (beginnt mit sk-ant-...)

### Option 2: Ollama (empfohlen fur den Einstieg)

Ollama ist kostenlos und bietet sowohl lokale als auch
Cloud-Modelle.

1. Installiere Ollama: https://ollama.com/download

       curl -fsSL https://ollama.com/install.sh | sh

2. Lade ein Modell:

       ollama pull minimax-m2.7:cloud

3. Im Installer:
   - Base-URL: http://localhost:11434/v1 (Enter)
   - Modell: minimax-m2.7:cloud (Enter)

Empfohlene Modelle:

    Cloud (kostenlos, schnell):
      minimax-m2.7:cloud  - sehr gut fur Deutsch
      qwen3:32b           - stark, multilingual

    Lokal (braucht GPU/RAM):
      llama3.1:8b   - 8 GB RAM, Basis-Qualitat
      llama3.1:70b  - 48 GB RAM, sehr gut

### Option 3: Groq (kostenlos, Cloud)

1. Erstelle einen Account: https://console.groq.com
2. Erstelle einen API-Key: https://console.groq.com/keys
3. Gib den Key ein (beginnt mit gsk_...)

### Option 4: OpenAI GPT (bezahlt)

1. Erstelle einen Account: https://platform.openai.com
2. Erstelle einen API-Key: https://platform.openai.com/api-keys
3. Gib den Key ein (beginnt mit sk-...)

---

## 7. Telegram Bot einrichten

### 7.1 Bot erstellen

1. Offne Telegram auf deinem Handy oder am Computer
2. Suche nach @BotFather und starte einen Chat
3. Sende: /newbot
4. Wahle einen Namen fur deinen Bot (z.B. "Mein Assistent")
5. Wahle einen Username (muss auf "bot" enden, z.B. "mein_assistent_bot")
6. BotFather gibt dir einen Token - kopiere diesen

Der Token sieht so aus: 123456789:ABCdefGHIjklMNOpqrsTUVwxyz

### 7.2 Token eingeben

    Bot-Token: [Token hier einfugen]

### 7.3 Zugriff einschranken (empfohlen)

    Erlaubte User-IDs (kommagetrennt):

So findest du deine User-ID:
1. Offne Telegram
2. Suche nach @userinfobot
3. Starte den Chat - er zeigt dir deine ID

Gib deine ID ein damit nur du den Bot nutzen kannst.
Mehrere IDs mit Komma trennen: 123456789,987654321

HINWEIS: Wenn du das Feld leer lasst, kann JEDER mit
deinem Bot sprechen. Das ist nicht empfohlen!

---

## 8. Optionale Features

Jetzt werden optionale Features abgefragt. Aktiviere nur was
du brauchst. Alles kann spater in den Einstellungen
nachkonfiguriert werden.

### 8.1 Sprachnachrichten

    Sprachnachrichten aktivieren? [j/N]:

Ermoglicht das Senden und Empfangen von Sprachnachrichten.
- Kostenlos, wird lokal installiert
- Braucht ca. 500 MB Speicher
- Whisper (Sprache-zu-Text) + Edge-TTS (Text-zu-Sprache)

Bei "j":
- Whisper-Modell: "base" ist ein guter Kompromiss
- TTS-Stimme: "de-DE-KillianNeural" klingt naturlich

### 8.2 E-Mail (IMAP/SMTP)

    E-Mail Integration? [j/N]:

Dein Bot kann E-Mails lesen und senden. Funktioniert mit
Gmail, Outlook, Yahoo und jedem IMAP-fahigen Anbieter.

WICHTIG fur Gmail:
Du brauchst ein App-Passwort (nicht dein normales Passwort):
https://myaccount.google.com/apppasswords

Bei "j":
- IMAP-Host eingeben (z.B. imap.gmail.com)
- E-Mail-Adresse eingeben
- App-Passwort eingeben

Berechtigungen:
- Mails senden erlauben? [j/N] - Standard: Nein (nur lesen)
- Als gelesen markieren? [j/N] - Standard: Nein
- Erlaubte Empfanger-Domains (nur wenn Senden aktiv)

### 8.3 Kalender (CalDAV)

    Kalender Integration? [j/N]:

Dein Bot kann Termine verwalten. Funktioniert mit Google
Calendar, iCloud, Nextcloud, etc.

CalDAV-URLs nach Anbieter:
- Google:    https://www.googleapis.com/caldav/v2/USER/events
- iCloud:    https://caldav.icloud.com
- Nextcloud: https://cloud.example.com/remote.php/dav

Berechtigungen:
- Termine erstellen/loschen erlauben? [j/N]

### 8.4 Home Assistant

    Home Assistant Integration? [j/N]:

Nur relevant wenn du Home Assistant fur Smart Home nutzt.

Token erstellen:
1. Home Assistant offnen
2. Profil (unten links) anklicken
3. "Langlebige Zugriffstokens" -> Token erstellen
4. Token kopieren und eingeben

### 8.5 Kerio Connect

    Kerio Connect Integration? [j/N]:

Nur relevant wenn du einen Kerio Connect Mailserver betreibst.
Die meisten Nutzer wahlen hier "N".

### 8.6 DALL-E Bildgenerierung

    DALL-E Bildgenerierung? [j/N]:

Dein Bot kann Bilder generieren (z.B. "Male mir einen
Sonnenuntergang"). Braucht einen OpenAI API-Key.

### 8.7 Wissensbasis Git-Backup

    Git-Backup aktivieren? [j/N]:

Sichert die Notizen der Wissensbasis in ein Git-Repository.
Die Wissensbasis funktioniert auch ohne Git (lokal).

---

## 9. Monitor Dashboard

    Monitor aktivieren? [J/n]:

Das Web-Dashboard bietet:
- Live-Monitor mit Events
- Web-Chat (auch als App installierbar)
- Terminal mit Quick Actions
- Wissensbasis-Editor
- Erinnerungen verwalten
- System-Ubersicht mit Temperaturen
- Theme-Editor

Empfehlung: Ja (Standard)

- Port: 3333 (Standard)
- Benutzername: admin (Standard)
- Passwort: Wahle ein sicheres Passwort!

---

## 10. Installation abschliessen

### Zusammenfassung

Das Script zeigt dir jetzt eine Ubersicht aller Einstellungen:

    Zusammenfassung:
      Bot-Name:      JARVIS
      Besitzer:      Michael (Hamburg)
      Sprache:       Deutsch
      Zeitzone:      Europe/Berlin
      LLM-Provider:  ollama
      Telegram:      Token gesetzt
      ...

Prufe alles und bestatige:

    Installation starten? [J/n]:

### Automatische Installation

Das Script installiert jetzt automatisch:

    [1/7] System-Pakete (curl, git, ffmpeg, etc.)
    [2/7] Node.js v24
    [3/7] NPM Packages
    [4/7] Python venv (falls Sprache aktiviert)
    [5/7] Verzeichnisse + SSL-Zertifikate
    [6/7] Konfiguration (.env)
    [7/7] Systemd Service

Das dauert je nach Internetverbindung 2-5 Minuten.

---

## 11. Erster Start

### Bot starten

    sudo systemctl start kiasy

### Logs anschauen

    journalctl -u kiasy -f

Du solltest sehen:

    Starte [BOT-NAME] (Telegram)...
    [BOT-NAME] ist bereit! (@dein_bot_username)
    Modell: minimax-m2.7:cloud
    Monitor: https://0.0.0.0:3333

### Ersten Chat starten

1. Offne Telegram
2. Suche nach deinem Bot (@dein_bot_username)
3. Sende /start
4. Dein Bot stellt sich vor und lernt dich kennen!

### Dashboard offnen

1. Offne im Browser: https://DEINE-SERVER-IP:3333
2. Die SSL-Warnung ist normal (selbstsigniertes Zertifikat)
   -> "Erweitert" -> "Trotzdem fortfahren"
3. Melde dich mit deinem Benutzername/Passwort an

### Bot beim Systemstart automatisch starten

Das ist bereits eingerichtet! Der Bot startet automatisch
wenn der Computer hochfahrt. Prufen:

    systemctl is-enabled kiasy

Sollte "enabled" ausgeben.

---

## 12. Haufige Fragen

### Bot antwortet nicht

    # Lauft der Service?
    systemctl status kiasy

    # Logs anschauen
    journalctl -u kiasy -f

Haufige Ursachen:
- Telegram-Token falsch: Bei @BotFather prufen
- User-ID nicht in der Whitelist
- LLM-Provider nicht erreichbar (API-Key, URL prufen)

### Dashboard nicht erreichbar

- URL muss mit HTTPS beginnen: https://IP:3333
- Port offen? sudo ufw allow 3333
- Browser-Warnung ist normal (selbstsigniertes Zertifikat)

### Timezone-Fehler

Das Format muss IANA sein:
- Richtig:  Europe/Berlin
- FALSCH:   Europa/Berlin

### Sprachnachrichten funktionieren nicht

    # Whisper installiert?
    venv/bin/whisper --help

    # ffmpeg installiert?
    ffmpeg -version

Beim ersten Mal ladt Whisper das Modell herunter (kann dauern).

### Einstellungen nachtraglich andern

Zwei Moglichkeiten:
1. Im Dashboard unter /settings (empfohlen)
2. Direkt in der Datei: nano ~/kiasy/.env

Nach Anderungen: Neustart neben uber den Monitor oder:

    sudo systemctl restart kiasy

### Updates installieren

Im Dashboard: Terminal -> "KIASY Update" Button

Oder per Kommandozeile:

    cd ~/kiasy
    bash scripts/update.sh

---

KIASY - KI-Assistent System
https://github.com/micdede/kiasy
