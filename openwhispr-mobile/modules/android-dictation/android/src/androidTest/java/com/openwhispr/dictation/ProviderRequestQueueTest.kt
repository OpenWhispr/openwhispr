package com.openwhispr.dictation

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.BridgeReactContext
import com.facebook.soloader.nativeloader.NativeLoader
import com.facebook.soloader.nativeloader.SystemDelegate
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.ModuleHolder
import expo.modules.kotlin.ModulesProvider
import expo.modules.kotlin.Promise
import expo.modules.kotlin.events.EventName
import expo.modules.kotlin.functions.AsyncFunctionComponent
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.lang.ref.WeakReference
import java.net.InetAddress
import java.net.ServerSocket
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.BeforeClass
import org.junit.Test
import org.junit.runner.RunWith

/** Uses the production module and Expo dispatcher in a separate test app.
 * No production app data, credentials, microphone, or remote server is used. */
@RunWith(AndroidJUnit4::class)
class ProviderRequestQueueTest {
  companion object {
    @BeforeClass @JvmStatic fun initializeNativeLoader() {
      if (!NativeLoader.isInitialized()) NativeLoader.init(SystemDelegate())
    }
  }

  private lateinit var reactContext: ReactApplicationContext
  private lateinit var appContext: AppContext
  private lateinit var provider: ModuleHolder<*>
  private lateinit var probe: ModuleHolder<*>

  @Before fun setUp() {
    reactContext = BridgeReactContext(InstrumentationRegistry.getInstrumentation().targetContext)
    appContext = AppContext(object : ModulesProvider {
      override fun getModulesMap(): Map<Class<out Module>, String?> = emptyMap()
    }, expo.modules.core.ModuleRegistry(emptyList(), emptyList()), WeakReference(reactContext))
    val module = AndroidDictationModule()
    val queueProbe = QueueProbe()
    appContext.registry.register(module, null)
    appContext.registry.register(queueProbe, null)
    provider = requireNotNull(appContext.registry.getModuleHolder(module))
    probe = requireNotNull(appContext.registry.getModuleHolder(queueProbe))
  }

  @After fun tearDown() {
    if (::provider.isInitialized) provider.post(EventName.MODULE_DESTROY)
    if (::appContext.isInitialized) {
      appContext.modulesQueue.cancel()
      appContext.backgroundCoroutineScope.cancel()
      appContext.mainQueue.cancel()
      appContext.registry.cleanUp()
    }
  }

  @Test fun defaultQueueRemainsAvailableWhileProviderWaitsForHeaders() {
    HeldResponse().use { server ->
      val request = request(server, "headers")
      assertTrue("Provider must reach the local server", server.received.await(5, TimeUnit.SECONDS))
      val digest = dispatch(probe, "digest", arrayOf("abc"))
      assertTrue("A pending provider request must not block other Expo async functions",
        digest.completed.await(2, TimeUnit.SECONDS))
      assertNull(digest.error)
      assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", digest.value)
      assertEquals("Provider should still be pending", 1L, request.completed.count)
      server.release.countDown()
      assertTrue(request.completed.await(5, TimeUnit.SECONDS))
      assertNull(request.error)
      val result = request.value as Map<*, *>
      assertEquals(200, result["status"])
      assertEquals("fixture", result["body"])
    }
  }

  @Test fun defaultQueueAndCancellationRemainAvailableWhileResponseBodyIsPending() {
    HeldResponse(sendHeaders = true).use { server ->
      val request = request(server, "body")
      assertTrue(server.received.await(5, TimeUnit.SECONDS))
      val digest = dispatch(probe, "digest", arrayOf("abc"))
      assertTrue("Reading a provider response must not block credential operations",
        digest.completed.await(2, TimeUnit.SECONDS))
      assertNull(digest.error)
      provider.callSync("cancelProviderRequest", arrayOf("body"))
      assertTrue("Cancellation must settle without a server response", request.completed.await(5, TimeUnit.SECONDS))
      assertTrue(request.error.toString().contains("Provider request cancelled"))
      assertNull(request.value)
    }
  }

  @Test fun cancellationBeforeDispatchPreventsNetworkRequest() {
    HeldResponse().use { server ->
      provider.callSync("cancelProviderRequest", arrayOf("cancelled-first"))
      val request = request(server, "cancelled-first")
      assertTrue(request.completed.await(5, TimeUnit.SECONDS))
      assertTrue(request.error.toString().contains("Provider request cancelled"))
      assertEquals("Cancelled request must never reach the server", 1L, server.received.count)
    }
  }

  @Test fun invalidProviderAddressStillRejectsWithoutNetworkAccess() {
    val request = dispatch(provider, "requestProvider", arrayOf(mapOf(
      "requestId" to "invalid", "url" to "http://example.com/test", "method" to "GET"
    )))
    assertTrue(request.completed.await(5, TimeUnit.SECONDS))
    assertTrue(request.error.toString().contains("Use HTTPS or a private-network HTTP endpoint"))
    assertNull(request.value)
  }

  private fun request(server: HeldResponse, id: String) = dispatch(provider, "requestProvider", arrayOf(mapOf(
    "requestId" to id, "url" to server.url, "method" to "POST", "body" to "{}"
  )))

  private fun dispatch(holder: ModuleHolder<*>, name: String, args: Array<Any?>): Result {
    val result = Result()
    val function = holder.definition.asyncFunctions.getValue(name) as AsyncFunctionComponent
    // ModuleHolder.call alone bypasses queue dispatch. Exercise Expo's real JSI dispatch path
    // with the registered function's queue, then invoke its actual argument conversion/body.
    val dispatch = AsyncFunctionComponent::class.java.getDeclaredMethod(
      "dispatchOnQueue", AppContext::class.java, Function0::class.java
    ).apply { isAccessible = true }
    val body: () -> Unit = {
      try { holder.call(name, args, result) }
      catch (error: Throwable) { result.reject("TEST_CALL", error.message, error) }
    }
    dispatch.invoke(function, appContext, body)
    return result
  }

  private class QueueProbe : Module() {
    override fun definition() = ModuleDefinition {
      Name("ProviderQueueProbe")
      AsyncFunction("digest") { value: String ->
        MessageDigest.getInstance("SHA-256").digest(value.toByteArray())
          .joinToString("") { "%02x".format(it) }
      }
    }
  }

  private class Result : Promise {
    val completed = CountDownLatch(1)
    @Volatile var value: Any? = null
    @Volatile var error: String? = null
    override fun resolve(value: Any?) { this.value = value; completed.countDown() }
    override fun reject(code: String, message: String?, cause: Throwable?) {
      error = "$code: $message"; completed.countDown()
    }
  }

  private class HeldResponse(sendHeaders: Boolean = false) : AutoCloseable {
    private val server = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
    val url = "http://127.0.0.1:${server.localPort}/test"
    val received = CountDownLatch(1)
    val release = CountDownLatch(1)
    private val worker = Thread {
      try {
        server.accept().use { socket ->
          val input = socket.getInputStream().bufferedReader()
          while (!input.readLine().isNullOrEmpty()) { }
          val output = socket.getOutputStream()
          val headers = "HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\n".toByteArray()
          if (sendHeaders) { output.write(headers); output.flush() }
          received.countDown()
          release.await(10, TimeUnit.SECONDS)
          if (!sendHeaders) output.write(headers)
          output.write("fixture".toByteArray()); output.flush()
        }
      } catch (_: java.io.IOException) { /* Cancellation or fixture cleanup closes the socket. */ }
    }.apply { isDaemon = true; start() }
    override fun close() { release.countDown(); server.close(); worker.join(3000) }
  }
}
