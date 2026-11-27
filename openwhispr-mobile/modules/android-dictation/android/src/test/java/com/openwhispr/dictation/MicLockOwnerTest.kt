package com.openwhispr.dictation

import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

class MicLockOwnerTest {
  @get:Rule val temporary = TemporaryFolder()
  private val open = mutableListOf<WavRecorder>()

  private class Input : PcmInput {
    override val bufferSize = 4096
    override val initialized = true
    override var recording = false
    private val reads = LinkedBlockingQueue<ShortArray>()
    override fun start() { recording = true }
    override fun read(buffer: ShortArray): Int {
      val next = reads.poll(5, TimeUnit.SECONDS) ?: return 0
      next.copyInto(buffer); return next.size
    }
    override fun stop() { recording = false; reads.offer(shortArrayOf()) }
    override fun release() {}
  }

  private fun recorder(owner: String, module: Int? = null) =
    WavRecorder(temporary.root, createInput = { Input() }, owner = owner, module = module).also { open += it }

  @After fun close() { open.forEach { it.close() } }

  @Test fun theHolderNamesItsOwnerAndModule() {
    assertNull(WavRecorder.holder)
    val meeting = recorder("meeting")
    meeting.start()
    assertEquals("meeting", WavRecorder.holder?.owner)
    meeting.stop(true)
    assertNull(WavRecorder.holder)
    val inApp = recorder("in_app", module = 3)
    inApp.start()
    assertEquals(3, WavRecorder.holder?.module)
    inApp.stop(true)
  }

  @Test fun aRefusalCarriesTheCurrentHolderAndKeepsTodaysMessage() {
    recorder("meeting").start()
    val error = assertThrows(WavRecorder.MicrophoneBusyException::class.java) { recorder("bubble").start() }
    assertEquals("Finish your current recording first.", error.message)
    assertEquals("meeting", error.holder?.owner)
    // The refused recorder never took the lock, so closing it leaves the meeting's in place.
    open.last().close()
    assertEquals("meeting", WavRecorder.holder?.owner)
  }

  @Test fun closingTheHolderFreesTheLock() {
    val first = recorder("practice")
    first.start()
    first.close()
    assertNull(WavRecorder.holder)
    recorder("bubble").start()
    assertEquals("bubble", WavRecorder.holder?.owner)
  }
}
