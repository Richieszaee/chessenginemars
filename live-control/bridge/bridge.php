<?php
declare(strict_types=1);

/**
 * Mars Live PHP bridge
 *
 * Upload this file and the writable data/ directory to ordinary PHP hosting.
 * No database, WebSocket server, Node.js, or controller website is required.
 * Sessions, frames, and queued input expire automatically.
 */

const DATA_DIR = __DIR__ . '/data';
const SESSION_TTL = 1800;
const ACTIVE_WINDOW = 5;
const FRAME_MAX_BYTES = 1600000;
const EVENT_TTL = 120;
const MAX_EVENTS = 200;

ini_set('display_errors', '0');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, max-age=0');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

function respond(array $value, int $status = 200): void {
    http_response_code($status);
    echo json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function fail(string $message, string $code = 'bad-request', int $status = 400): void {
    respond(['ok' => false, 'error' => $code, 'message' => $message], $status);
}

function request_values(): array {
    $raw = file_get_contents('php://input');
    $json = [];
    if (is_string($raw) && $raw !== '') {
        $decoded = json_decode($raw, true);
        if (!is_array($decoded)) fail('Malformed JSON request.', 'bad-json');
        $json = $decoded;
    }
    return array_merge($_GET, $_POST, $json);
}

function valid_code($value): bool {
    return is_string($value) && preg_match('/^[0-9]{6}$/', $value) === 1;
}

function valid_token($value): bool {
    return is_string($value) && preg_match('/^[a-f0-9]{64}$/', $value) === 1;
}

function token_hash(string $token): string {
    return hash('sha256', $token);
}

function ensure_data_dir(): void {
    if (!is_dir(DATA_DIR)) {
        if (!mkdir(DATA_DIR, 0700, true) && !is_dir(DATA_DIR)) {
            fail('The bridge data directory is not writable.', 'storage', 500);
        }
    }
    if (!is_writable(DATA_DIR)) {
        fail('Make the bridge data/ directory writable by PHP.', 'storage', 500);
    }
}

function session_path(string $code): string {
    return DATA_DIR . '/session_' . $code . '.json';
}

function lock_path(string $code): string {
    return session_path($code) . '.lock';
}

function read_session(string $path): ?array {
    if (!is_file($path)) return null;
    $raw = file_get_contents($path);
    if (!is_string($raw) || $raw === '') return null;
    $value = json_decode($raw, true);
    return is_array($value) ? $value : null;
}

function write_session(string $path, array $session): void {
    $json = json_encode($session, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if (!is_string($json)) fail('Could not encode the session.', 'storage', 500);
    $temporary = $path . '.' . bin2hex(random_bytes(6)) . '.tmp';
    if (file_put_contents($temporary, $json, LOCK_EX) === false || !rename($temporary, $path)) {
        @unlink($temporary);
        fail('Could not save the session.', 'storage', 500);
    }
}

/** Serialize each session change, then replace its JSON file atomically. */
function update_session(string $code, callable $callback): array {
    ensure_data_dir();
    $path = session_path($code);
    $lock = fopen(lock_path($code), 'c');
    if (!$lock) fail('Could not lock the session.', 'storage', 500);
    if (!flock($lock, LOCK_EX)) {
        fclose($lock);
        fail('Could not lock the session.', 'storage', 500);
    }
    $session = read_session($path);
    $response = $callback($session, $path);
    if ($session !== null) write_session($path, $session);
    flock($lock, LOCK_UN);
    fclose($lock);
    return $response;
}

function new_session(string $code, string $hostToken): array {
    $now = time();
    return [
        'code' => $code,
        'host_hash' => token_hash($hostToken),
        'controller_hash' => null,
        'created_at' => $now,
        'host_seen_at' => $now,
        'controller_seen_at' => 0,
        'ended' => false,
        'control_granted' => false,
        'paused' => false,
        'request_pending' => false,
        'target_title' => '',
        'frame_sequence' => 0,
        'frame_data' => '',
        'frame_width' => 0,
        'frame_height' => 0,
        'frame_at' => 0,
        'events' => [],
        'next_event_id' => 1,
        'input_window_at' => $now,
        'input_count' => 0
    ];
}

function host_is_active(array $session): bool {
    return $session['host_seen_at'] >= time() - ACTIVE_WINDOW;
}

function controller_is_active(array $session): bool {
    return is_string($session['controller_hash']) && $session['controller_seen_at'] >= time() - ACTIVE_WINDOW;
}

function prune_events(array &$session): void {
    $cutoff = time() - EVENT_TTL;
    $events = [];
    foreach ($session['events'] as $event) {
        if ($event['created_at'] >= $cutoff) $events[] = $event;
    }
    if (count($events) > MAX_EVENTS) $events = array_slice($events, -MAX_EVENTS);
    $session['events'] = $events;
}

function add_event(array &$session, string $direction, string $type, array $payload = []): void {
    $session['events'][] = [
        'id' => $session['next_event_id']++,
        'direction' => $direction,
        'type' => $type,
        'payload' => $payload,
        'created_at' => time()
    ];
    prune_events($session);
}

function events_for(array $session, string $direction, int $after): array {
    $result = [];
    foreach ($session['events'] as $event) {
        if ($event['direction'] === $direction && $event['id'] > $after) $result[] = $event;
    }
    return $result;
}

function state_for(array $session): array {
    $controllerConnected = controller_is_active($session);
    $controlGranted = $controllerConnected && !$session['ended'] && $session['control_granted'];
    return [
        'hostConnected' => host_is_active($session),
        'controllerConnected' => $controllerConnected,
        'controlGranted' => $controlGranted,
        'paused' => $controlGranted && $session['paused'],
        'requestPending' => $controllerConnected && !$controlGranted && $session['request_pending'],
        'targetTitle' => (string) $session['target_title'],
        'ended' => (bool) $session['ended']
    ];
}

function frame_for(array $session, int $after): ?array {
    if ($session['frame_data'] === '' || $session['frame_sequence'] <= $after) return null;
    return [
        'sequence' => (int) $session['frame_sequence'],
        'width' => (int) $session['frame_width'],
        'height' => (int) $session['frame_height'],
        'data' => 'data:image/jpeg;base64,' . $session['frame_data']
    ];
}

function sanitize_input($value): ?array {
    if (!is_array($value) || !isset($value['action'])) return null;
    $actions = ['move', 'down', 'up', 'wheel', 'key-down', 'key-up'];
    if (!in_array($value['action'], $actions, true)) return null;
    $allowed = [
        'x', 'y', 'button', 'clickCount', 'deltaX', 'deltaY', 'key', 'code',
        'keyCode', 'location', 'text', 'repeat', 'altKey', 'ctrlKey', 'metaKey', 'shiftKey'
    ];
    $clean = ['action' => (string) $value['action']];
    foreach ($allowed as $key) {
        if (!array_key_exists($key, $value)) continue;
        $item = $value[$key];
        if (is_string($item)) {
            $clean[$key] = substr($item, 0, $key === 'text' ? 4 : 50);
        } elseif (is_int($item) || is_float($item)) {
            if (is_finite((float) $item)) $clean[$key] = $item;
        } elseif (is_bool($item)) {
            $clean[$key] = $item;
        }
    }
    return strlen((string) json_encode($clean, JSON_UNESCAPED_SLASHES)) <= 20000 ? $clean : null;
}

function cleanup_sessions(): void {
    foreach (glob(DATA_DIR . '/session_*.json') ?: [] as $path) {
        $session = read_session($path);
        $age = time() - (is_array($session) ? (int) $session['created_at'] : time());
        $ended = is_array($session) && $session['ended'];
        if ($age > SESSION_TTL || ($ended && $age > 120)) {
            @unlink($path);
            @unlink($path . '.lock');
        }
    }
}

$request = request_values();
$action = is_string($request['action'] ?? null) ? $request['action'] : 'health';
ensure_data_dir();
cleanup_sessions();

if ($action === 'health') {
    $count = count(glob(DATA_DIR . '/session_*.json') ?: []);
    respond(['ok' => true, 'bridge' => 'php', 'sessions' => $count]);
}

if (!valid_code($request['code'] ?? null)) {
    fail('A six-digit PIN is required.', 'invalid-code');
}
$code = $request['code'];

switch ($action) {
    case 'register':
        $hostToken = $request['host_token'] ?? null;
        if (!valid_token($hostToken)) fail('Invalid host token.', 'invalid-token', 401);
        $result = update_session($code, function (&$session) use ($code, $hostToken) {
            if ($session !== null && !$session['ended'] && !hash_equals((string) $session['host_hash'], token_hash($hostToken))) {
                fail('This PIN is already in use.', 'code-in-use', 409);
            }
            if ($session === null || $session['ended']) {
                $session = new_session($code, $hostToken);
            } else {
                $session['host_seen_at'] = time();
            }
            return ['ok' => true, 'code' => $code, 'state' => state_for($session)];
        });
        respond($result);

    case 'join':
        $result = update_session($code, function (&$session) use ($code) {
            if ($session === null || $session['ended']) {
                fail('Session not found. Check the PIN and try again.', 'not-found', 404);
            }
            if (!host_is_active($session)) {
                fail('The host is offline. Ask them to reopen Mars Live.', 'host-offline', 409);
            }
            if (controller_is_active($session)) {
                fail('This session already has a controller.', 'already-connected', 409);
            }
            try {
                $controllerToken = bin2hex(random_bytes(32));
            } catch (Throwable $error) {
                fail('Could not create a controller token.', 'storage', 500);
            }
            $session['controller_hash'] = token_hash($controllerToken);
            $session['controller_seen_at'] = time();
            $session['control_granted'] = false;
            $session['paused'] = false;
            $session['request_pending'] = false;
            add_event($session, 'host', 'controller-joined', []);
            return [
                'ok' => true,
                'code' => $code,
                'controller_token' => $controllerToken,
                'state' => state_for($session)
            ];
        });
        respond($result);

    case 'host_poll':
        $hostToken = $request['host_token'] ?? null;
        if (!valid_token($hostToken)) fail('Invalid host token.', 'invalid-token', 401);
        $after = (int) ($request['after'] ?? 0);
        $result = update_session($code, function (&$session) use ($hostToken, $after) {
            if ($session === null || !hash_equals((string) $session['host_hash'], token_hash($hostToken))) {
                fail('Invalid host token.', 'invalid-token', 401);
            }
            $session['host_seen_at'] = time();
            if ($session['ended']) {
                return ['ok' => true, 'state' => state_for($session), 'events' => []];
            }
            if (!controller_is_active($session)) {
                $session['control_granted'] = false;
                $session['paused'] = false;
                $session['request_pending'] = false;
            }
            return [
                'ok' => true,
                'state' => state_for($session),
                'events' => events_for($session, 'host', $after)
            ];
        });
        respond($result);

    case 'controller_poll':
        $controllerToken = $request['controller_token'] ?? null;
        if (!valid_token($controllerToken)) fail('Invalid controller token.', 'invalid-token', 401);
        $after = (int) ($request['after'] ?? 0);
        $afterFrame = (int) ($request['after_frame'] ?? 0);
        $result = update_session($code, function (&$session) use ($controllerToken, $after, $afterFrame) {
            if ($session === null || !is_string($session['controller_hash']) || !hash_equals($session['controller_hash'], token_hash($controllerToken))) {
                fail('Invalid controller token.', 'invalid-token', 401);
            }
            $session['controller_seen_at'] = time();
            return [
                'ok' => true,
                'state' => state_for($session),
                'events' => events_for($session, 'controller', $after),
                'frame' => frame_for($session, $afterFrame)
            ];
        });
        respond($result);

    case 'state':
        $hostToken = $request['host_token'] ?? null;
        if (!valid_token($hostToken)) fail('Invalid host token.', 'invalid-token', 401);
        $incoming = $request['state'] ?? [];
        if (!is_array($incoming)) fail('Invalid host state.');
        $result = update_session($code, function (&$session) use ($hostToken, $incoming) {
            if ($session === null || !hash_equals((string) $session['host_hash'], token_hash($hostToken))) {
                fail('Invalid host token.', 'invalid-token', 401);
            }
            $session['host_seen_at'] = time();
            $session['target_title'] = is_string($incoming['targetTitle'] ?? null) ? substr($incoming['targetTitle'], 0, 180) : '';
            $active = controller_is_active($session) && !$session['ended'];
            $session['control_granted'] = $active && !empty($incoming['controlGranted']);
            $session['paused'] = $session['control_granted'] && !empty($incoming['paused']);
            $session['request_pending'] = $active && !$session['control_granted'] && !empty($incoming['requestPending']);
            return ['ok' => true, 'state' => state_for($session)];
        });
        respond($result);

    case 'control':
        $hostToken = $request['host_token'] ?? null;
        if (!valid_token($hostToken)) fail('Invalid host token.', 'invalid-token', 401);
        $grant = !empty($request['grant']);
        $result = update_session($code, function (&$session) use ($hostToken, $grant) {
            if ($session === null || $session['ended'] || !hash_equals((string) $session['host_hash'], token_hash($hostToken))) {
                fail('Invalid host token.', 'invalid-token', 401);
            }
            $session['host_seen_at'] = time();
            $session['control_granted'] = $grant && controller_is_active($session);
            $session['paused'] = false;
            $session['request_pending'] = false;
            add_event($session, 'controller', 'control-result', ['approved' => $session['control_granted']]);
            return ['ok' => true, 'state' => state_for($session)];
        });
        respond($result);

    case 'request_control':
        $controllerToken = $request['controller_token'] ?? null;
        if (!valid_token($controllerToken)) fail('Invalid controller token.', 'invalid-token', 401);
        $result = update_session($code, function (&$session) use ($controllerToken) {
            if ($session === null || $session['ended'] || !is_string($session['controller_hash']) || !hash_equals($session['controller_hash'], token_hash($controllerToken))) {
                fail('Invalid controller token.', 'invalid-token', 401);
            }
            if (!host_is_active($session)) fail('The host is offline.', 'host-offline', 409);
            $session['controller_seen_at'] = time();
            if (!$session['control_granted']) $session['request_pending'] = true;
            add_event($session, 'host', 'request-control', []);
            return ['ok' => true, 'state' => state_for($session)];
        });
        respond($result);

    case 'input':
        $controllerToken = $request['controller_token'] ?? null;
        if (!valid_token($controllerToken)) fail('Invalid controller token.', 'invalid-token', 401);
        $clean = sanitize_input($request['input'] ?? null);
        if ($clean === null) fail('Invalid input message.');
        $result = update_session($code, function (&$session) use ($controllerToken, $clean) {
            if ($session === null || $session['ended'] || !is_string($session['controller_hash']) || !hash_equals($session['controller_hash'], token_hash($controllerToken))) {
                fail('Invalid controller token.', 'invalid-token', 401);
            }
            if (!host_is_active($session) || !$session['control_granted'] || $session['paused']) {
                fail('Control is locked until the host allows it.', 'control-denied', 403);
            }
            $now = time();
            if ($now - $session['input_window_at'] >= 1) {
                $session['input_window_at'] = $now;
                $session['input_count'] = 0;
            }
            if ($session['input_count'] >= 120) fail('Too much input. Slow down.', 'rate-limited', 429);
            $session['input_count']++;
            $session['controller_seen_at'] = $now;
            add_event($session, 'host', 'input', $clean);
            return ['ok' => true];
        });
        respond($result);

    case 'frame':
        $hostToken = $request['host_token'] ?? null;
        if (!valid_token($hostToken)) fail('Invalid host token.', 'invalid-token', 401);
        $data = $request['data'] ?? null;
        $width = (int) ($request['width'] ?? 0);
        $height = (int) ($request['height'] ?? 0);
        if (!is_string($data) || strpos($data, 'data:image/jpeg;base64,') !== 0 || strlen($data) > FRAME_MAX_BYTES) {
            fail('Invalid frame.', 'invalid-frame', 413);
        }
        $base64 = substr($data, strlen('data:image/jpeg;base64,'));
        if (base64_decode($base64, true) === false || $width < 1 || $height < 1 || $width > 4096 || $height > 4096) {
            fail('Invalid frame data.', 'invalid-frame');
        }
        $sequence = (int) ($request['sequence'] ?? 0);
        $result = update_session($code, function (&$session) use ($hostToken, $base64, $width, $height, $sequence) {
            if ($session === null || $session['ended'] || !hash_equals((string) $session['host_hash'], token_hash($hostToken))) {
                fail('Invalid host token.', 'invalid-token', 401);
            }
            $session['host_seen_at'] = time();
            if (!controller_is_active($session)) return ['ok' => true, 'ignored' => true];
            if ($sequence > $session['frame_sequence']) {
                $session['frame_sequence'] = $sequence;
                $session['frame_data'] = $base64;
                $session['frame_width'] = $width;
                $session['frame_height'] = $height;
                $session['frame_at'] = time();
            }
            return ['ok' => true];
        });
        respond($result);

    case 'leave':
        $controllerToken = $request['controller_token'] ?? null;
        if (!valid_token($controllerToken)) fail('Invalid controller token.', 'invalid-token', 401);
        $result = update_session($code, function (&$session) use ($controllerToken) {
            if ($session === null || !is_string($session['controller_hash']) || !hash_equals($session['controller_hash'], token_hash($controllerToken))) {
                fail('Invalid controller token.', 'invalid-token', 401);
            }
            $session['controller_hash'] = null;
            $session['controller_seen_at'] = 0;
            $session['control_granted'] = false;
            $session['paused'] = false;
            $session['request_pending'] = false;
            add_event($session, 'host', 'controller-left', []);
            return ['ok' => true];
        });
        respond($result);

    case 'end':
        $hostToken = $request['host_token'] ?? null;
        if (!valid_token($hostToken)) fail('Invalid host token.', 'invalid-token', 401);
        $result = update_session($code, function (&$session) use ($hostToken) {
            if ($session === null || !hash_equals((string) $session['host_hash'], token_hash($hostToken))) {
                fail('Invalid host token.', 'invalid-token', 401);
            }
            $session['ended'] = true;
            $session['control_granted'] = false;
            $session['paused'] = false;
            $session['request_pending'] = false;
            $session['frame_data'] = '';
            $session['frame_width'] = 0;
            $session['frame_height'] = 0;
            $session['frame_at'] = 0;
            add_event($session, 'controller', 'session-ended', ['message' => 'The host ended the session.']);
            return ['ok' => true];
        });
        respond($result);

    default:
        fail('Unknown bridge action.', 'unknown-action', 404);
}
