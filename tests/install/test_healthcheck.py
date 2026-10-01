"""Exercise the container health probe over real loopback HTTP, without Docker."""
import http.server
import os
from pathlib import Path
import subprocess
import threading
import unittest

ROOT = Path(__file__).resolve().parents[2]


class HealthcheckTests(unittest.TestCase):
    def check(self, login=True, protected=401):
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == '/api/auth/status':
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b'{"hasPasswordLogin":true}' if login else b'{"hasPasswordLogin":false}')
                else:
                    self.send_response(protected)
                    self.end_headers()
            def log_message(self, *args):
                pass
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            return subprocess.run(['node', str(ROOT / 'docker/healthcheck.mjs')],
                                  env=dict(os.environ, PORT=str(server.server_port)),
                                  capture_output=True, text=True, timeout=10)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_authenticated_service_is_healthy(self):
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_disabled_login_is_unhealthy(self):
        self.assertNotEqual(self.check(login=False).returncode, 0)

    def test_unprotected_api_is_unhealthy(self):
        self.assertNotEqual(self.check(protected=200).returncode, 0)


if __name__ == '__main__':
    unittest.main()
