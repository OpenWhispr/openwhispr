"""Run Foundation transport regressions against local servers with synthetic data."""
import http.server
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time


class RedirectReceiver(http.server.BaseHTTPRequestHandler):
    forwarded = 0

    def do_GET(self):
        type(self).forwarded += 1
        self.send_response(200)
        self.end_headers()

    do_POST = do_GET

    def log_message(self, *args):
        pass


def main():
    module = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix="provider-transport-") as output:
        executable = str(Path(output) / "tests")
        subprocess.run([
            "swiftc", "-swift-version", "5", "-o", executable,
            str(module / "ios/ProviderRequestTransport.swift"),
            str(module / "ios/ProviderJobMetadata.swift"),
            str(module / "ios/ProviderRecoveryStore.swift"),
            str(module / "tests/ProviderRequestTransportTests.swift"),
        ], check=True)
        receiver = http.server.ThreadingHTTPServer(("127.0.0.1", 0), RedirectReceiver)

        class Origin(http.server.BaseHTTPRequestHandler):
            cancelled_requests = 0

            def do_GET(self):
                if self.path == "/must-not-start":
                    type(self).cancelled_requests += 1
                if self.path == "/slow":
                    time.sleep(2)
                    self.send_response(200)
                    self.end_headers()
                elif self.path == "/redirect":
                    self.send_response(307)
                    self.send_header("Location", f"http://127.0.0.1:{receiver.server_port}/sink")
                    self.end_headers()
                elif self.path == "/error":
                    self.send_response(401)
                    self.end_headers()
                    self.wfile.write(b"synthetic-sensitive-provider-error")
                else:
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b'{"text":"ok"}')

            do_POST = do_GET

            def log_message(self, *args):
                pass

        origin = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Origin)
        for server in (receiver, origin):
            threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            subprocess.run([executable], env={
                **os.environ,
                "PROVIDER_TEST_BASE_URL": f"http://127.0.0.1:{origin.server_port}",
            }, timeout=25, check=True)
            assert RedirectReceiver.forwarded == 0, "Redirect forwarded credentials to another origin"
            assert Origin.cancelled_requests == 0, "A request cancelled before registration reached the server"
            print("Second origin received zero redirected requests; pre-start cancellation sent no request.")
        finally:
            origin.shutdown()
            receiver.shutdown()
            origin.server_close()
            receiver.server_close()


if __name__ == "__main__":
    main()
