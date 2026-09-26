"""Run Foundation transport regressions against local servers with synthetic data."""
import http.server
import os
from pathlib import Path
import ssl
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
            same_origin_forwarded = 0

            def do_GET(self):
                if self.path == "/must-not-start":
                    type(self).cancelled_requests += 1
                if self.path == "/same-origin-sink":
                    type(self).same_origin_forwarded += 1
                if self.path == "/trickle":
                    # Each byte arrives inside the idle timeout; only a total limit ends it.
                    self.send_response(200)
                    self.send_header("Content-Length", "10")
                    self.end_headers()
                    for _ in range(10):
                        self.wfile.write(b"x")
                        self.wfile.flush()
                        time.sleep(0.5)
                elif self.path == "/redirect-same":
                    self.send_response(307)
                    self.send_header("Location", "/same-origin-sink")
                    self.end_headers()
                elif self.path == "/slow":
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
        certificate = Path(output) / "self-signed.pem"
        subprocess.run([
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
            "-subj", "/CN=127.0.0.1", "-keyout", str(certificate), "-out", str(certificate),
        ], check=True, capture_output=True)
        untrusted = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Origin)
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(certificate)
        untrusted.socket = tls.wrap_socket(untrusted.socket, server_side=True)
        for server in (receiver, origin, untrusted):
            threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            subprocess.run([executable], env={
                **os.environ,
                "PROVIDER_TEST_BASE_URL": f"http://127.0.0.1:{origin.server_port}",
                "PROVIDER_TEST_TLS_URL": f"https://127.0.0.1:{untrusted.server_port}",
            }, timeout=60, check=True)
            assert RedirectReceiver.forwarded == 0, "Redirect forwarded credentials to another origin"
            assert Origin.same_origin_forwarded == 0, "Redirect was followed within the same origin"
            assert Origin.cancelled_requests == 0, "A request cancelled before registration reached the server"
            print("No redirect was followed; pre-start cancellation sent no request.")
        finally:
            for server in (origin, receiver, untrusted):
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    main()
