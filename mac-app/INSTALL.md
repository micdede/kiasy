# JARVIS Mac-App – Installation

Native macOS-Menüleisten-App für JARVIS. Text- und Sprachdialog mit dem JARVIS-Server, optional über VPN.

## Voraussetzungen

- **macOS 13 (Ventura) oder neuer**
- **Xcode Command Line Tools** – einmalig installieren mit:
  ```bash
  xcode-select --install
  ```
- **Git** – kommt mit den Command Line Tools
- **Zugang zum JARVIS-Server** – URL, Benutzername, Passwort von Michael
- Wenn der Server nicht im selben WLAN ist: **VPN aktiv**

## 1. Quellcode holen

```bash
mkdir -p ~/Jarvis
cd ~/Jarvis
git clone git@github.com:micdede/kiasy.git .
cd mac-app
```

(Falls kein SSH-Key auf GitHub: `https://github.com/micdede/kiasy.git` statt `git@…`. Repo ist privat – Michael muss dich vorher einladen.)

## 2. Bauen

```bash
chmod +x build.sh
./build.sh
```

Beim ersten Mal lädt Swift Package Manager Abhängigkeiten und kompiliert. Das dauert ein paar Minuten. Am Ende liegt das fertige Bundle unter `build/Jarvis.app`.

Optional ins Programme-Verzeichnis kopieren:
```bash
cp -r build/Jarvis.app /Applications/
```

## 3. Erster Start

```bash
open build/Jarvis.app          # oder aus /Applications starten
```

Das **Gehirn-Icon** erscheint in der Menüleiste oben rechts. Klick drauf → Settings-Dialog öffnet sich automatisch beim ersten Start.

### Verbindungsdaten eintragen

| Feld         | Beispiel                           |
|--------------|------------------------------------|
| Server-URL   | `https://192.168.178.50:3333`      |
| Benutzername | (von Michael)                      |
| Passwort     | (von Michael)                      |

→ unten auf **"Verbindung testen"** klicken. Wenn der Verlauf lädt, passt es.

### macOS-Berechtigungen

Beim ersten Mikrofon-Klick und beim ersten Dialog fragt macOS nach:

- **Mikrofon** – für Sprachaufnahme
- **Spracherkennung** – für lokale Apple-STT (Dialog-Modus)

Beide auf **Erlauben** klicken. Falls verpasst: Systemeinstellungen → Datenschutz & Sicherheit → Mikrofon / Spracherkennung → Jarvis aktivieren.

Für Hotkeys (Schritt 5) kommt eventuell noch:
- **Eingabeüberwachung** – nur wenn die App nach dem Hotkey fragt

## 4. Sprachausgabe konfigurieren

In Settings unter **Sprachverarbeitung**:

- **Apple-Spracherkennung** (Empfehlung: an) – on-device, sofort, ohne Cloud
- **Apple-Sprachausgabe** (an oder aus, Geschmack):
  - **An** = Apple-Stimme. Stimmen-Picker zeigt installierte Voices. Premium/Siri-Voices via Systemeinstellungen → Bedienungshilfen → Vorlesen → Systemstimmen runterladen.
  - **Aus** = Server-TTS via Piper (auf Michaels Unraid). Klingt natürlicher, +200-500ms Latenz. Voice-Picker zeigt verfügbare Piper-Stimmen. Empfehlung: `de_DE-thorsten-medium`.
- **Sprechtempo** – Slider 0.7×–1.5×

## 5. Bedienung

### Maus
- Klick auf Gehirn-Icon → Fenster auf/zu
- **Mikrofon-Knopf** unten links → Sprachnachricht aufnehmen, nochmal klicken zum Senden
- **Ohr-Knopf** oben → Dialog-Modus (Voice-zu-Voice, automatisch reagierend)
- **Lautsprecher-Knopf** an Nachrichten → einzeln vorlesen
- **Zahnrad** → Settings

### Tastatur (konfigurierbar in Settings → Hotkeys)
| Default | Aktion                      |
|---------|-----------------------------|
| F13     | Fenster öffnen/schließen    |
| F14     | Dialog starten/stoppen      |

Beide Hotkeys global, funktionieren auch wenn die App nicht im Vordergrund ist (Eingabeüberwachung muss erlaubt sein).

### Dialog-Modus
Im Dialog redest du frei – nach kurzer Sprechpause schickt die App das Audio automatisch ab und JARVIS antwortet hörbar. Direkt danach hört er wieder zu. Beenden: nochmal Dialog-Hotkey oder Ohr-Knopf, oder einfach nicht mehr sprechen (1-2s Stille beendet den Modus).

## 6. Updates

```bash
cd ~/Jarvis
git pull
killall Jarvis 2>/dev/null
cd mac-app
./build.sh
open build/Jarvis.app
```

Settings, Hotkeys und Stimmen-Auswahl bleiben erhalten (in UserDefaults).

## Troubleshooting

| Problem                                          | Lösung                                                                                         |
|--------------------------------------------------|------------------------------------------------------------------------------------------------|
| `permission denied: ./build.sh`                  | `chmod +x build.sh`                                                                            |
| Zertifikat-Fehler beim Verbindungstest           | Self-signed Cert wird automatisch akzeptiert – wenn nicht, Server-URL prüfen (https + Port)    |
| Kein Sound beim Dialog                           | Apple-Sprachausgabe an/aus toggeln; Piper-Voice in Settings prüfen                             |
| Mikrofon nimmt nichts auf                        | Systemeinstellungen → Mikrofon → Jarvis erlauben; ggf. anderes Mikro wählen (Systemeinstellungen → Ton → Eingabe) |
| Hotkey reagiert nur bei offenem Fenster          | Systemeinstellungen → Datenschutz → Eingabeüberwachung → Jarvis aktivieren                     |
| Build-Fehler `swift not found`                   | Xcode Command Line Tools installieren (siehe Voraussetzungen)                                  |
| App-Icon erscheint nicht in der Menüleiste       | Menüleiste voll – andere Icons mit Cmd-Drag verschieben oder Bartender/Hidden Bar aufräumen    |

## Deinstallation

```bash
killall Jarvis 2>/dev/null
rm -rf /Applications/Jarvis.app ~/Jarvis
defaults delete de.wrsk.jarvis-mac
security delete-generic-password -s de.wrsk.jarvis-mac    # Passwort aus Keychain
```
