// Adapted from https://github.com/stephancill/ios-keyboard-dictation (WebAudioCapture.swift).
// MIT License. Copyright (c) 2026 Stephan Cilliers.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this
// software and associated documentation files (the "Software"), to deal in the Software
// without restriction, including without limitation the rights to use, copy, modify, merge,
// publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons
// to whom the Software is furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
// PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
// FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
// DEALINGS IN THE SOFTWARE.

import UIKit
import WebKit

/// Captures the microphone from inside the keyboard by running `getUserMedia` in a hidden
/// `WKWebView`: a keyboard extension is refused native recording, but WebKit records in its own
/// processes. Emits 16 kHz mono Int16 PCM chunks. Used from the main thread only.
@MainActor
final class WebAudioCapture: NSObject {
  static let sampleRate: Double = 16_000
  /// WebKit's call processing (echo cancellation, noise suppression, automatic gain) and the
  /// play-and-record web audio session. Off ("mode D"): it matches the raw audio the app records
  /// and DirectGain makes up the level. Flip to compare against mode A on a device.
  static let voiceProcessing = false

  var onStarted: (() -> Void)?
  var onAudio: ((Data, Float) -> Void)?
  var onEnded: ((String) -> Void)?

  private var webView: WKWebView?
  private var isReady = false
  private var isCapturing = false
  private var startWhenReady = false
  private var heartbeat: Timer?

  /// The web view must live in the keyboard's view hierarchy for WebKit to capture. It is made
  /// on the first attach, so a keyboard that never dictates this way never loads WebKit.
  func attach(to view: UIView) {
    let webView = self.webView ?? makeWebView()
    if webView.superview !== view {
      webView.removeFromSuperview()
      view.addSubview(webView)
      view.sendSubviewToBack(webView)
    }
  }

  func start() {
    guard !isCapturing else { return }
    guard webView != nil else {
      onEnded?("failed: not attached")
      return
    }
    isCapturing = true
    guard isReady else {
      startWhenReady = true
      return
    }
    beginCapture()
  }

  func stop() {
    startWhenReady = false
    guard isCapturing else { return }
    webView?.evaluateJavaScript("stopCapture(); 0", completionHandler: nil)
    finish(reason: "stopped")
  }

  private func makeWebView() -> WKWebView {
    let handler = WeakMessageHandler()
    let configuration = WKWebViewConfiguration()
    configuration.allowsInlineMediaPlayback = true
    configuration.mediaTypesRequiringUserActionForPlayback = []
    configuration.websiteDataStore = .nonPersistent()
    configuration.userContentController.add(handler, name: "capture")
    let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 1, height: 1), configuration: configuration)
    handler.target = self
    webView.uiDelegate = self
    webView.navigationDelegate = self
    // In the window and (barely) visible: WebKit throttles a web view it considers hidden.
    webView.alpha = 0.01
    webView.isUserInteractionEnabled = false
    webView.accessibilityElementsHidden = true
    self.webView = webView
    loadPage(webView)
    return webView
  }

  // getUserMedia needs a secure context; the https base URL is never fetched.
  private func loadPage(_ webView: WKWebView) {
    isReady = false
    webView.loadHTMLString(Self.page, baseURL: URL(string: "https://keyboard-dictation.invalid/"))
  }

  private func beginCapture() {
    startWhenReady = false
    heartbeat = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      // Scheduled on the main run loop, so this already runs on the main actor.
      MainActor.assumeIsolated {
        self?.webView?.evaluateJavaScript("captureHeartbeat()", completionHandler: nil)
      }
    }
    let processing = Self.voiceProcessing ? "true" : "false"
    webView?.evaluateJavaScript("startCapture({ processing: \(processing) }); 0") { [weak self] _, error in
      guard let error else { return }
      MainActor.assumeIsolated { self?.finish(reason: "failed: \(error.localizedDescription)") }
    }
  }

  private func finish(reason: String) {
    heartbeat?.invalidate()
    heartbeat = nil
    startWhenReady = false
    guard isCapturing else { return }
    isCapturing = false
    onEnded?(reason)
  }

  fileprivate func handle(_ body: Any) {
    guard let message = body as? [String: Any], let type = message["type"] as? String else { return }
    switch type {
    case "ready":
      isReady = true
      if startWhenReady && isCapturing { beginCapture() }
    case "started":
      onStarted?()
    case "audio":
      guard isCapturing, let base64 = message["data"] as? String, let data = Data(base64Encoded: base64) else {
        return
      }
      let rms = (message["rms"] as? NSNumber)?.floatValue ?? 0
      onAudio?(data, rms)
    case "interrupted", "failed":
      finish(reason: "\(type): \(message["reason"] as? String ?? "unknown")")
    default:
      break
    }
  }

  private static let page = """
    <!doctype html><html><body><script>
    const targetRate = \(Int(sampleRate));
    const post = message => window.webkit.messageHandlers.capture.postMessage(message);
    const encode = samples => {
      const bytes = new Uint8Array(samples.buffer, 0, samples.length * 2);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(binary);
    };
    let lastHeartbeat = performance.now();
    window.captureHeartbeat = () => { lastHeartbeat = performance.now(); };
    let stopCapture = () => {};
    window.stopCapture = () => stopCapture();
    window.startCapture = async (options = {}) => {
      const processing = options.processing === true;
      let stopping = false, stream, context, source, processor, sink, watchdog;
      const audioSession = navigator.audioSession;
      const previousType = audioSession?.type ?? 'auto';
      const cleanup = () => {
        if (stopping) return;
        stopping = true;
        clearInterval(watchdog);
        if (processor) { processor.onaudioprocess = null; processor.disconnect(); }
        source?.disconnect();
        sink?.disconnect();
        stream?.getTracks().forEach(track => track.stop());
        context?.close().catch(() => {});
        if (processing) { try { if (audioSession) audioSession.type = previousType; } catch (_) {} }
      };
      const interrupted = reason => { if (!stopping) { cleanup(); post({ type: 'interrupted', reason }); } };
      stopCapture = cleanup;
      try {
        if (processing) { try { if (audioSession) audioSession.type = 'play-and-record'; } catch (_) {} }
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: processing, noiseSuppression: processing, autoGainControl: processing },
        });
        if (stopping) { stream.getTracks().forEach(track => track.stop()); return; }
        const track = stream.getAudioTracks()[0];
        track.onended = () => interrupted('track-ended');
        // Created only now: an AudioContext can take audio focus or change the Bluetooth route.
        context = new AudioContext({ latencyHint: 'interactive' });
        await context.resume();
        processor = context.createScriptProcessor(1024, 1, 1);
        sink = context.createGain();
        sink.gain.value = 0;
        processor.connect(sink);
        sink.connect(context.destination);
        source = context.createMediaStreamSource(stream);
        source.connect(processor);
        context.onstatechange = () => { if (context.state !== 'running') interrupted('context-' + context.state); };
        lastHeartbeat = performance.now();
        // A dead-man's switch: if the keyboard stops calling in (dismissed, suspended,
        // crashed), the page stops the microphone itself.
        watchdog = setInterval(() => { if (performance.now() - lastHeartbeat > 3000) interrupted('native-heartbeat-expired'); }, 500);
        const step = context.sampleRate / targetRate;
        let position = 0, sum = 0, count = 0;
        processor.onaudioprocess = event => {
          const input = event.inputBuffer.getChannelData(0);
          const output = new Int16Array(Math.ceil(input.length / step) + 1);
          let written = 0, energy = 0;
          for (const sample of input) {
            energy += sample * sample; sum += sample; count += 1; position += 1;
            if (position >= step) {
              position -= step;
              output[written++] = Math.max(-1, Math.min(1, sum / count)) * 32767;
              sum = 0; count = 0;
            }
          }
          if (written > 0) post({ type: 'audio', data: encode(output.subarray(0, written)), rms: Math.sqrt(energy / input.length) });
        };
        post({ type: 'started', sampleRate: context.sampleRate });
      } catch (error) {
        if (stopping) return;
        cleanup();
        post({ type: 'failed', reason: error.name + ': ' + error.message });
      }
    };
    post({ type: 'ready' });
    </script></body></html>
    """
}

extension WebAudioCapture: @preconcurrency DirectCapture {}

extension WebAudioCapture: WKUIDelegate, WKNavigationDelegate {
  // The app's own microphone permission still applies; this only skips WebKit's per-origin prompt.
  func webView(
    _ webView: WKWebView,
    requestMediaCapturePermissionFor origin: WKSecurityOrigin,
    initiatedByFrame frame: WKFrameInfo,
    type: WKMediaCaptureType,
    decisionHandler: @escaping (WKPermissionDecision) -> Void
  ) {
    decisionHandler(type == .microphone ? .grant : .deny)
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    finish(reason: "failed: web content process terminated")
    loadPage(webView)
  }
}

/// Breaks the retain cycle between `WKUserContentController` and its handler.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
  weak var target: WebAudioCapture?

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    MainActor.assumeIsolated { target?.handle(message.body) }
  }
}
