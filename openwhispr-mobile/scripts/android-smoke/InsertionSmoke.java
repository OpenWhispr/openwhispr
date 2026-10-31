package com.openwhispr.androidtest;

import android.app.Instrumentation;
import android.app.UiAutomation;
import android.content.Intent;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.accessibility.AccessibilityNodeInfo;
import java.lang.reflect.Proxy;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Uses the installed debug app's real service; never grants permissions or changes settings. */
public class InsertionSmoke extends Instrumentation {
  private Object service;
  private Class<?> callbackType;
  private UiAutomation ui;
  @Override public void onCreate(Bundle arguments) { super.onCreate(arguments); start(); }
  @Override public void onStart() {
    Bundle report = new Bundle();
    try {
      ui = getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
      ClassLoader loader = getTargetContext().getClassLoader();
      Class<?> type = loader.loadClass("com.openwhispr.dictation.InsertionService");
      Object companion = type.getField("Companion").get(null);
      callbackType = loader.loadClass("kotlin.jvm.functions.Function1");
      // Instrumentation restarts its target process. Android may require the tester to
      // toggle this already-consented service off/on in Settings to reconnect it.
      for (int i = 0; i < 600 && service == null; i++) {
        service = companion.getClass().getMethod("getInstance").invoke(companion);
        if (service == null) SystemClock.sleep(100);
      }
      check(service != null, "Enable OpenWhispr text insertion through normal Settings first.");

      field("Before after", 7, 7, false);
      check(capture().equals(""), "Cursor should have no selection");
      check(insert("hello "), "Cursor insertion rejected");
      check(text().equals("Before hello after"), "Cursor insertion lost surrounding text");
      passed("cursor insertion preserves surrounding text");

      String groceries = "Apples, bread and milk.";
      int milk = groceries.indexOf("milk");
      field(groceries, milk, milk + 4, false);
      check(capture().equals("milk"), "Selected text was not captured");
      check(insert("oat milk"), "Selection replacement rejected");
      check(text().equals("Apples, bread and oat milk."), "Selection replacement changed other text");
      passed("selection replacement preserves remainder");

      field("", 0, 0, false);
      capture();
      check(insert("Hello."), "Empty-field insertion rejected");
      check(text().equals("Hello."), "Placeholder became message content");
      passed("placeholder is not copied into an empty field");

      field("Original", 8, 8, false);
      capture();
      field("Changed by user", 15, 15, false);
      check(!insert("stale result"), "Changed text accepted stale result");
      check(text().equals("Changed by user"), "Changed text was overwritten");
      passed("changed text is left alone");

      field("Original", 8, 8, false);
      capture();
      launch(new Intent().putExtra("other", true));
      check(!insert("wrong field"), "Focus change accepted stale result");
      passed("focus change rejects insertion");

      field("synthetic-password", 18, 18, true);
      check(capture().equals(""), "Password field exposed a selection");
      check(!insert("must not appear"), "Password field accepted insertion");
      passed("password field is excluded");
      report.putString("stream", "PASS: 6 real cross-process insertion checks\n");
      finish(0, report);
    } catch (Throwable error) {
      report.putString("stream", "FAIL: " + error + "\n");
      finish(1, report);
    }
  }
  private void field(String value, int start, int end, boolean password) {
    launch(new Intent().putExtra("text", value).putExtra("start", start).putExtra("end", end).putExtra("password", password));
  }
  private void launch(Intent intent) {
    intent.setClassName("com.openwhispr.androidtest", "com.openwhispr.androidtest.FixtureActivity");
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    getContext().startActivity(intent);
    SystemClock.sleep(650);
  }
  private String capture() throws Exception {
    AtomicReference<String> result = new AtomicReference<>();
    AtomicReference<Throwable> error = new AtomicReference<>();
    runOnMainSync(() -> {
      try { result.set((String) service.getClass().getMethod("captureTarget").invoke(service)); }
      catch (Throwable failure) { error.set(failure); }
    });
    if (error.get() != null) throw new Exception(error.get());
    return result.get();
  }
  private boolean insert(String value) throws Exception {
    CountDownLatch done = new CountDownLatch(1);
    AtomicReference<Boolean> result = new AtomicReference<>(false);
    AtomicReference<Throwable> error = new AtomicReference<>();
    Object callback = Proxy.newProxyInstance(callbackType.getClassLoader(), new Class<?>[] { callbackType }, (proxy, method, args) -> {
      if (method.getName().equals("invoke")) { result.set((Boolean) args[0]); done.countDown(); }
      return null;
    });
    runOnMainSync(() -> {
      try { service.getClass().getMethod("insert", String.class, callbackType).invoke(service, value, callback); }
      catch (Throwable failure) { error.set(failure); done.countDown(); }
    });
    check(done.await(3, TimeUnit.SECONDS), "Insertion callback timed out");
    if (error.get() != null) throw new Exception(error.get());
    return result.get();
  }
  private String text() {
    AccessibilityNodeInfo root = ui.getRootInActiveWindow();
    check(root != null, "No active window");
    try { return findText(root); } finally { root.recycle(); }
  }
  private String findText(AccessibilityNodeInfo node) {
    if ("primary test field".contentEquals(node.getContentDescription() == null ? "" : node.getContentDescription()))
      return node.getText() == null ? "" : node.getText().toString();
    for (int i = 0; i < node.getChildCount(); i++) {
      AccessibilityNodeInfo child = node.getChild(i);
      if (child == null) continue;
      try { String result = findText(child); if (result != null) return result; }
      finally { child.recycle(); }
    }
    return null;
  }
  private void passed(String name) { Bundle status = new Bundle(); status.putString("stream", "PASS: " + name + "\n"); sendStatus(0, status); }
  private void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
}
