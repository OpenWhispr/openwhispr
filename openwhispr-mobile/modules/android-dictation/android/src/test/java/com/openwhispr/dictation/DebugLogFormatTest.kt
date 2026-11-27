package com.openwhispr.dictation

import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class DebugLogFormatTest {
  @get:Rule val temporary = TemporaryFolder()

  @Test fun formatsTimeLevelAreaEventAndFields() {
    val line = DebugLogFormat.line(0L, 'I', "mic", "lock.taken",
      linkedMapOf("run" to "d-7k2q", "owner" to "bubble", "rate" to 16000, "peak" to 0.4123, "ok" to true, "skip" to null))
    assertTrue(line, Regex("""^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d{4} I mic    lock\.taken run=d-7k2q owner=bubble rate=16000 peak=0\.41 ok=true$""").matches(line))
  }

  @Test fun stringsUnderUnknownKeysAreReplacedByTheirLength() {
    val transcript = "Meet me at the clinic at nine, my PIN is 4471"
    val line = DebugLogFormat.line(0L, 'I', "dict", "transcribed", linkedMapOf("text" to transcript, "transcript" to transcript))
    assertFalse(line, line.contains("clinic"))
    assertTrue(line, line.contains("text=<${transcript.length} chars>"))
  }

  @Test fun knownStringsAreCutAndKeptToOneLine() {
    val value = DebugLogFormat.value("model", "a\nb" + "x".repeat(200))
    assertFalse(value.contains("\n"))
    assertTrue(value.length <= DebugLogFormat.MAX_STRING + 2)
    assertEquals("\"two words\"", DebugLogFormat.value("reason", "two words"))
    assertTrue(DebugLogFormat.value("error", "e".repeat(500)).length <= DebugLogFormat.MAX_ERROR + 2)
  }

  @Test fun runIdsAreShortAndTyped() {
    val id = DebugLogFormat.runId('m')
    assertTrue(id, Regex("^m-[0-9a-z]{4}$").matches(id))
  }

  @Test fun jsLinesStayOneLine() {
    assertEquals("a b", DebugLogFormat.jsLine("a\r\nb"))
    assertEquals(DebugLogFormat.MAX_JS_LINE, DebugLogFormat.jsLine("x".repeat(5000)).length)
  }

  @Test fun theRingBufferKeepsTheNewestTwoFiles() {
    val files = DebugLogFiles(temporary.newFolder("log"), maxBytes = 100)
    for (i in 1..30) files.append(listOf("line %02d %s".format(i, "x".repeat(10))))
    val out = java.io.ByteArrayOutputStream()
    files.copyTo(out)
    val text = out.toString()
    assertTrue(files.current.length() <= 100)
    assertTrue(files.previous.length() <= 100)
    assertTrue(text, text.contains("line 30"))
    assertFalse(text, text.contains("line 01"))
    // Oldest first: previous, then current.
    val lines = text.trim().lines()
    assertEquals(lines.sorted(), lines)
    files.clear()
    assertFalse(files.hasLog())
  }

  @Test fun theExportPutsBatchedLinesBackInTimeOrder() {
    val files = DebugLogFiles(temporary.newFolder("order"))
    files.append(listOf("2026-11-27T15:38:01.890+0200 I bubble state", "2026-11-27T15:38:01.884+0200 E dict failed"))
    val out = java.io.ByteArrayOutputStream()
    files.copyTo(out)
    assertEquals(listOf("2026-11-27T15:38:01.884+0200 E dict failed", "2026-11-27T15:38:01.890+0200 I bubble state"),
      out.toString().trim().lines())
  }
}
