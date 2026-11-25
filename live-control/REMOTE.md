# Hosting the Mars Live bridge on PHP

Mars Live needs one thing reachable from both computers: `bridge.php` on a PHP host. There is no Node process, no WebSocket port, and no database. This guide covers ordinary hosting and different Wi-Fi networks.

## What the host must provide

| Requirement | Notes |
| --- | --- |
| PHP 7.4+ | `json` and `hash` are core extensions and are always present. |
| A writable `data/` directory | Next to `bridge.php`. The bridge creates session files here. |
| HTTPS | Strongly recommended. Frames pass through the bridge in plain form. |

Typical shared hosting (cPanel, DirectAdmin, Plesk) already meets all three.

## Upload

Copy these files, keeping the folder structure:

```
mars-live/
├── bridge.php
├── .htaccess
└── data/
    ├── .htaccess
    └── .gitkeep
```

Then make `data/` writable by PHP:

```bash
chmod 775 data
# If PHP runs as a different user than the owner:
# chown -R www-data:www-data data   (Debian/Ubuntu, adjust to your host)
```

On shared hosting, use the file manager's permission dialog and set `data/` to `755` or `775`. If the bridge cannot write, it answers with `{"ok":false,"error":"storage",...}` instead of failing silently.

## Verify

Open the bridge directly in a browser:

```
https://your-domain.com/mars-live/bridge.php
```

A healthy bridge prints:

```json
{"ok":true,"bridge":"php","sessions":0}
```

Then open the same address with `?action=health` to confirm routing works.

If you see a blank page, enable `display_errors` temporarily or check the PHP error log. The most common causes are an unwritable `data/` folder or a host running PHP older than 7.4.

## Configure the extension

In both browsers — the host's and the controller's:

1. Click the pinned **Mars Live** icon.
2. Open **Connection settings**.
3. Paste the full `bridge.php` address, including `https://` and the filename.
4. Click **Save**. Chrome asks for permission to reach that host once.

The address is stored per browser. The host can click **Copy invite details** and send one message containing the bridge address and the PIN.

## Local testing

```bash
cd live-control/bridge
php -S 127.0.0.1:8080
```

The bridge is then at `http://127.0.0.1:8080/bridge.php`, which is the extension's default address. This is only for testing on one machine — a different computer cannot reach `127.0.0.1`.

## Session files and cleanup

The bridge writes `data/session_<PIN>.json` and a matching `.lock` file. Each write is serialized with `flock` and committed by atomic rename, so concurrent polls cannot corrupt a session.

- Sessions expire after **30 minutes** and are removed on the next request.
- A host or controller that stops polling for **5 seconds** is treated as offline.
- Only the **latest** frame per session is kept; nothing is archived.
- `data/.htaccess` denies direct web access to the folder on Apache. On nginx, deny it explicitly:

  ```nginx
  location ~* /mars-live/data/ {
      deny all;
      return 403;
  }
  ```

## nginx note

The included `.htaccess` files only apply to Apache. On nginx, add the `data/` deny rule above, and optionally:

```nginx
location ~ \.php$ {
    include fastcgi_params;
    fastcgi_param HTTP_PROXY "";
    fastcgi_pass unix:/run/php/php8.2-fpm.sock;
}
add_header X-Content-Type-Options nosniff;
```

## Security notes

- Frames pass through the bridge **unencrypted at the application layer**. Use HTTPS so the transport is encrypted, and host the bridge on infrastructure you control.
- The six-digit PIN is a short-lived pairing secret. Anyone who learns it can join as a **viewer**, but cannot send input until the host clicks **Allow control**.
- Tokens are 256-bit random values, stored only as SHA-256 hashes and compared in constant time.
- Sessions auto-expire. Nothing persists after `end` or after the TTL passes.
