package com.openwhispr.providernetworktest;

import android.app.Instrumentation;
import android.os.Bundle;
import com.openwhispr.dictation.ProviderTransport;
import expo.modules.kotlin.exception.CodedException;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

/** Self-targeted fixture. No product account, files, microphone or UI access. */
public class ProviderNetworkProbe extends Instrumentation {
  private int sequence;

  @Override public void onCreate(Bundle args) { super.onCreate(args); start(); }

  private Map<String, Object> request(ProviderTransport transport, String url) throws CodedException {
    Map<String, Object> options = new HashMap<>();
    options.put("requestId", "fixture-" + (++sequence));
    options.put("method", "GET");
    options.put("url", url);
    return transport.request(options);
  }

  private void reject(ProviderTransport transport, String url) {
    try {
      request(transport, url);
      throw new AssertionError("Expected invalid URL rejection");
    } catch (CodedException error) {
      if (!"PROVIDER_INVALID_URL".equals(error.getCode()))
        throw new AssertionError("Wrong rejection: " + error.getCode());
    }
  }

  @Override public void onStart() {
    Bundle result = new Bundle();
    ProviderTransport transport = new ProviderTransport(getTargetContext());
    AtomicInteger requests = new AtomicInteger();
    try (ServerSocket server = new ServerSocket(0, 8, java.net.InetAddress.getByName("127.0.0.1"))) {
      Thread responder = new Thread(() -> {
        while (!server.isClosed()) {
          try (Socket socket = server.accept()) {
            socket.setSoTimeout(5000);
            BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.US_ASCII));
            String first = reader.readLine();
            boolean cookie = false;
            String line;
            while ((line = reader.readLine()) != null && !line.isEmpty()) {
              if (line.toLowerCase(java.util.Locale.ROOT).startsWith("cookie:")) cookie = true;
            }
            requests.incrementAndGet();
            String body = cookie ? "unexpected-cookie" : "fixture-model";
            boolean redirect = first.contains(" /redirect ");
            String headers = redirect
              ? "HTTP/1.1 302 Found\r\nLocation: http://example.invalid/capture\r\n"
              : "HTTP/1.1 200 OK\r\nSet-Cookie: fixture=not-persisted\r\n";
            socket.getOutputStream().write((headers + "Connection: close\r\nContent-Length: " + body.length() + "\r\n\r\n" + body).getBytes(StandardCharsets.US_ASCII));
          } catch (Exception error) {
            if (!server.isClosed()) throw new RuntimeException(error);
          }
        }
      });
      responder.setDaemon(true);
      responder.start();
      String base = "http://127.0.0.1:" + server.getLocalPort();
      Map<String, Object> models = request(transport, base + "/models");
      if (!Integer.valueOf(200).equals(models.get("status")) || !"fixture-model".equals(models.get("body")))
        throw new AssertionError("Private HTTP discovery did not reach the fixture");
      Map<String, Object> second = request(transport, base + "/models");
      if (!"fixture-model".equals(second.get("body"))) throw new AssertionError("Cookies persisted");
      Map<String, Object> redirect = request(transport, base + "/redirect");
      if (!Integer.valueOf(302).equals(redirect.get("status"))) throw new AssertionError("Redirect followed");
      reject(transport, "http://example.invalid/models");
      reject(transport, "http://172.32.0.1/models");
      reject(transport, "http://100.128.0.1/models");
      reject(transport, "http://fixture:secret@127.0.0.1:" + server.getLocalPort());
      reject(transport, base + "/models#fragment");
      if (requests.get() != 3) throw new AssertionError("Unexpected request count: " + requests.get());
      result.putString("result", "PASS: private HTTP, no cookies, no redirects, public HTTP and malformed URL rejection");
      finish(-1, result);
    } catch (Throwable error) {
      result.putString("result", "FAIL: " + error.getClass().getSimpleName() + ": " + error.getMessage());
      finish(0, result);
    } finally { transport.close(); }
  }
}
