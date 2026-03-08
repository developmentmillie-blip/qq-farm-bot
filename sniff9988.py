import http.server, urllib.parse, urllib.request, time, socketserver, threading

DEFAULT_USERNAME = 'default'
_seen = {}
_seen_lock = threading.Lock()

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        raw = self.path
        if raw.startswith('http'):
            parsed = urllib.parse.urlparse(raw)
            q = parsed.query
            path_part = parsed.path
        else:
            path_part = raw.split('?')[0]
            q = raw.split('?', 1)[1] if '?' in raw else ''
        p = urllib.parse.parse_qs(q)
        code   = (p.get('code')   or [''])[0]
        uin    = (p.get('uin')    or [''])[0]
        openid = (p.get('openID') or p.get('openid') or [''])[0]
        # 从路径取 username：/chuan -> chuan，/ 或空 -> DEFAULT_USERNAME
        username = path_part.strip('/') or DEFAULT_USERNAME

        with open('/tmp/sniff9988.out', 'a') as f:
            f.write('[sniff] code=' + code[:20] + ' user=' + username + '\n')

        # 同一 code+username 60秒内只转发一次，防止 QQ 重试重复建账号
        key = code + '|' + username
        now = time.time()
        with _seen_lock:
            if key in _seen and now - _seen[key] < 60:
                with open('/tmp/sniff9988.out', 'a') as f:
                    f.write('[sniff] SKIP dup\n')
                self._ws_ok(); return
            _seen[key] = now

        if not code:
            self.send_response(400); self.end_headers()
            self.wfile.write(b'no code'); return

        api = ('http://localhost:8081/api/code-capture'
               '?code=' + urllib.parse.quote(code)
               + '&username=' + urllib.parse.quote(username))
        if uin:
            api += '&uin=' + urllib.parse.quote(uin)
        if openid:
            api += '&openID=' + urllib.parse.quote(openid)

        try:
            resp = urllib.request.urlopen(api, timeout=10)
            body = resp.read().decode()
            with open('/tmp/sniff9988.out', 'a') as f:
                f.write('[sniff] OK: ' + body + '\n')
        except urllib.request.HTTPError as e:
            body = e.read().decode()
            with open('/tmp/sniff9988.out', 'a') as f:
                f.write('[sniff] HTTP ' + str(e.code) + ': ' + body + '\n')
        except Exception as e:
            with open('/tmp/sniff9988.out', 'a') as f:
                f.write('[sniff] ERR: ' + str(e) + '\n')
        self._ws_ok()

    def _ws_ok(self):
        self.send_response(101)
        self.send_header('Upgrade', 'websocket')
        self.send_header('Connection', 'Upgrade')
        self.end_headers()

class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True

ThreadedHTTPServer(('0.0.0.0', 9988), H).serve_forever()
