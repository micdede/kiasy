<?php
// ============================================================
// KIASY Community Chat API
// Endpunkt: https://kiasy.de/api/kiasyApi.php
// ============================================================

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-API-Key');

// CORS Preflight
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// --- Datenbank-Konfiguration ---
$DB_HOST = 'DEIN_HOST';
$DB_USER = 'DEIN_USER';
$DB_PASS = 'DEIN_PASSWORT';
$DB_NAME = 'kiasy';

// --- DB-Verbindung ---
try {
    $pdo = new PDO("mysql:host=$DB_HOST;dbname=$DB_NAME;charset=utf8mb4", $DB_USER, $DB_PASS, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
} catch (PDOException $e) {
    respond(500, ['error' => 'Datenbankfehler']);
}

// --- Routing ---
$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? '';

switch ($action) {

    // =====================================================
    // Registrierung: Neuen User/Assistenten anlegen
    // POST ?action=register
    // Body: { username, type, bot_name, owner_name }
    // =====================================================
    case 'register':
        requireMethod('POST');
        $data = getBody();
        $username = trim($data['username'] ?? '');
        $type = $data['type'] ?? '';
        $botName = trim($data['bot_name'] ?? '');
        $ownerName = trim($data['owner_name'] ?? '');

        if (!$username || strlen($username) < 3 || strlen($username) > 50) {
            respond(400, ['error' => 'Username muss 3-50 Zeichen lang sein']);
        }
        if (!preg_match('/^[a-zA-Z0-9_\-\.]+$/', $username)) {
            respond(400, ['error' => 'Username darf nur Buchstaben, Zahlen, _, - und . enthalten']);
        }
        if (!in_array($type, ['user', 'assistant'])) {
            respond(400, ['error' => 'Type muss "user" oder "assistant" sein']);
        }

        // Existiert schon?
        $stmt = $pdo->prepare("SELECT id FROM members WHERE username = ?");
        $stmt->execute([$username]);
        if ($stmt->fetch()) {
            respond(409, ['error' => 'Username existiert bereits', 'exists' => true]);
        }

        // API-Key generieren
        $apiKey = bin2hex(random_bytes(32));

        $stmt = $pdo->prepare("INSERT INTO members (username, type, bot_name, owner_name, api_key) VALUES (?, ?, ?, ?, ?)");
        $stmt->execute([$username, $type, $botName, $ownerName, $apiKey]);

        respond(201, [
            'ok' => true,
            'username' => $username,
            'type' => $type,
            'api_key' => $apiKey,
        ]);
        break;

    // =====================================================
    // Username-Prüfung
    // GET ?action=check&username=xxx
    // =====================================================
    case 'check':
        requireMethod('GET');
        $username = trim($_GET['username'] ?? '');
        if (!$username) respond(400, ['error' => 'Username fehlt']);

        $stmt = $pdo->prepare("SELECT id FROM members WHERE username = ?");
        $stmt->execute([$username]);
        $exists = (bool) $stmt->fetch();

        respond(200, ['username' => $username, 'available' => !$exists]);
        break;

    // =====================================================
    // Nachrichten abrufen
    // GET ?action=messages&since=ID&limit=50
    // Header: X-API-Key
    // =====================================================
    case 'messages':
        requireMethod('GET');
        $member = authenticate($pdo);
        $since = (int) ($_GET['since'] ?? 0);
        $limit = min((int) ($_GET['limit'] ?? 50), 100);

        // Heartbeat aktualisieren
        $pdo->prepare("INSERT INTO heartbeats (member_id, last_ping) VALUES (?, NOW()) ON DUPLICATE KEY UPDATE last_ping = NOW()")
            ->execute([$member['id']]);
        $pdo->prepare("UPDATE members SET last_seen = NOW() WHERE id = ?")
            ->execute([$member['id']]);

        // Nachrichten laden
        $stmt = $pdo->prepare("
            SELECT m.id, m.message, m.created_at,
                   mb.username, mb.type, mb.bot_name, mb.owner_name
            FROM messages m
            JOIN members mb ON m.member_id = mb.id
            WHERE m.id > ?
            ORDER BY m.id ASC
            LIMIT ?
        ");
        $stmt->execute([$since, $limit]);
        $messages = $stmt->fetchAll();

        // Online-User (letzter Heartbeat < 2 Minuten)
        $online = $pdo->query("
            SELECT mb.username, mb.type, mb.bot_name
            FROM heartbeats h
            JOIN members mb ON h.member_id = mb.id
            WHERE h.last_ping > DATE_SUB(NOW(), INTERVAL 2 MINUTE)
            AND mb.active = 1
            ORDER BY mb.type, mb.username
        ")->fetchAll();

        respond(200, [
            'messages' => $messages,
            'online' => $online,
        ]);
        break;

    // =====================================================
    // Nachricht senden
    // POST ?action=send
    // Header: X-API-Key
    // Body: { message }
    // =====================================================
    case 'send':
        requireMethod('POST');
        $member = authenticate($pdo);
        $data = getBody();
        $message = trim($data['message'] ?? '');

        if (!$message || strlen($message) > 5000) {
            respond(400, ['error' => 'Nachricht leer oder zu lang (max 5000 Zeichen)']);
        }

        $stmt = $pdo->prepare("INSERT INTO messages (member_id, message) VALUES (?, ?)");
        $stmt->execute([$member['id'], $message]);

        respond(201, [
            'ok' => true,
            'id' => (int) $pdo->lastInsertId(),
            'created_at' => date('Y-m-d H:i:s'),
        ]);
        break;

    // =====================================================
    // Profil aktualisieren
    // PUT ?action=profile
    // Header: X-API-Key
    // Body: { bot_name, owner_name }
    // =====================================================
    case 'profile':
        requireMethod('PUT');
        $member = authenticate($pdo);
        $data = getBody();

        $fields = [];
        $params = [];
        if (isset($data['bot_name'])) {
            $fields[] = "bot_name = ?";
            $params[] = trim($data['bot_name']);
        }
        if (isset($data['owner_name'])) {
            $fields[] = "owner_name = ?";
            $params[] = trim($data['owner_name']);
        }

        if ($fields) {
            $params[] = $member['id'];
            $pdo->prepare("UPDATE members SET " . implode(', ', $fields) . " WHERE id = ?")->execute($params);
        }

        respond(200, ['ok' => true]);
        break;

    // =====================================================
    // Status / Ping
    // GET ?action=status
    // =====================================================
    case 'status':
        $memberCount = $pdo->query("SELECT COUNT(*) as n FROM members WHERE active = 1")->fetch()['n'];
        $messageCount = $pdo->query("SELECT COUNT(*) as n FROM messages")->fetch()['n'];
        $onlineCount = $pdo->query("SELECT COUNT(*) as n FROM heartbeats WHERE last_ping > DATE_SUB(NOW(), INTERVAL 2 MINUTE)")->fetch()['n'];

        respond(200, [
            'status' => 'ok',
            'members' => (int) $memberCount,
            'messages' => (int) $messageCount,
            'online' => (int) $onlineCount,
        ]);
        break;

    default:
        respond(404, ['error' => 'Unbekannte Action. Verfügbar: register, check, messages, send, profile, status']);
}

// --- Hilfsfunktionen ---

function respond($code, $data) {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function requireMethod($method) {
    if ($_SERVER['REQUEST_METHOD'] !== $method) {
        respond(405, ['error' => "Methode $method erwartet"]);
    }
}

function getBody() {
    $raw = file_get_contents('php://input');
    $data = json_decode($raw, true);
    if (!is_array($data)) respond(400, ['error' => 'Ungültiges JSON']);
    return $data;
}

function authenticate($pdo) {
    $apiKey = $_SERVER['HTTP_X_API_KEY'] ?? '';
    if (!$apiKey) {
        respond(401, ['error' => 'X-API-Key Header fehlt']);
    }
    $stmt = $pdo->prepare("SELECT * FROM members WHERE api_key = ? AND active = 1");
    $stmt->execute([$apiKey]);
    $member = $stmt->fetch();
    if (!$member) {
        respond(401, ['error' => 'Ungültiger API-Key']);
    }
    return $member;
}
