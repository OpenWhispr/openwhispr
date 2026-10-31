package com.openwhispr.dictation

import android.content.Context
import android.net.Uri
import expo.modules.kotlin.exception.CodedException
import okhttp3.Call
import okhttp3.CookieJar
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLPeerUnverifiedException

/** Ephemeral BYOK transport: no redirects, cookies, disk cache or credential logging. */
class ProviderTransport(private val context: Context) {
  private val calls = ConcurrentHashMap<String, Call>()
  private val cancelled = ConcurrentHashMap.newKeySet<String>()
  private val client = OkHttpClient.Builder()
    .followRedirects(false).followSslRedirects(false)
    .cookieJar(CookieJar.NO_COOKIES).cache(null)
    .connectTimeout(30, TimeUnit.SECONDS).readTimeout(300, TimeUnit.SECONDS)
    .writeTimeout(300, TimeUnit.SECONDS).callTimeout(600, TimeUnit.SECONDS)
    .build()

  fun cancel(id: String) {
    cancelled.add(id)
    calls[id]?.cancel()
  }
  fun close() { calls.values.forEach { it.cancel() }; calls.clear(); cancelled.clear() }
  private fun fail(code: String, message: String): Nothing = throw CodedException(code, message, null)
  private fun privateHost(host: String): Boolean {
    if (host == "localhost" || host == "::1" || host.endsWith(".local") || host.endsWith(".ts.net")) return true
    val parts = host.split('.').map { it.toIntOrNull() ?: return false }
    if (parts.size != 4 || parts.any { it !in 0..255 }) return false
    return parts[0] == 10 || parts[0] == 127 || (parts[0] == 192 && parts[1] == 168) ||
      (parts[0] == 172 && parts[1] in 16..31) || (parts[0] == 100 && parts[1] in 64..127)
  }
  fun request(options: Map<String, Any?>): Map<String, Any> {
    val id = options["requestId"] as? String ?: fail("PROVIDER_INVALID_REQUEST", "Missing request identity.")
    if (cancelled.remove(id)) fail("PROVIDER_CANCELLED", "Provider request cancelled.")
    val url = (options["url"] as? String)?.toHttpUrlOrNull()
      ?: fail("PROVIDER_INVALID_URL", "Invalid provider address.")
    if (url.username.isNotEmpty() || url.password.isNotEmpty() || url.fragment != null ||
      (url.scheme != "https" && !(url.scheme == "http" && privateHost(url.host))))
      fail("PROVIDER_INVALID_URL", "Use HTTPS or a private-network HTTP endpoint.")
    val method = options["method"] as? String ?: "POST"
    if (method != "GET" && method != "POST") fail("PROVIDER_INVALID_REQUEST", "Unsupported request method.")
    val builder = Request.Builder().url(url).header("Cache-Control", "no-store")
    (options["headers"] as? Map<*, *>)?.forEach { (key, value) ->
      if (key is String && value is String) {
        if (key.any { it.code < 33 || it.code > 126 } || value.any { it == '\r' || it == '\n' || it.code == 0 })
          fail("PROVIDER_INVALID_REQUEST", "Invalid provider header.")
        builder.header(key, value)
      }
    }
    val body = if (options["fileUri"] is String) {
      val file = File(Uri.parse(options["fileUri"] as String).path ?: "").canonicalFile
      if (!listOf(context.filesDir, context.cacheDir).any { file.path.startsWith(it.canonicalPath + "/") } || !file.isFile)
        fail("PROVIDER_AUDIO_UNAVAILABLE", "The audio file is unavailable.")
      if (file.length() > 25 * 1024 * 1024) fail("PROVIDER_AUDIO_TOO_LARGE", "The audio exceeds the 25 MB provider limit.")
      val multipart = MultipartBody.Builder().setType(MultipartBody.FORM)
      (options["parameters"] as? Map<*, *>)?.forEach { (key, value) ->
        if (key is String && value is String) multipart.addFormDataPart(key, value)
      }
      multipart.addFormDataPart(options["fileFieldName"] as? String ?: "file",
        options["fileName"] as? String ?: "recording.wav",
        file.asRequestBody((options["fileMimeType"] as? String ?: "audio/wav").toMediaType()))
      multipart.build()
    } else (options["body"] as? String ?: "").toRequestBody("application/json; charset=utf-8".toMediaType())
    val call = client.newCall(builder.method(method, if (method == "GET") null else body).build())
    if (calls.putIfAbsent(id, call) != null) fail("PROVIDER_INVALID_REQUEST", "Request is already running.")
    try {
      if (cancelled.remove(id)) call.cancel()
      call.execute().use { response ->
        val source = response.body?.source()
        val limit = 8L * 1024 * 1024
        if (source?.request(limit + 1) == true) fail("PROVIDER_INVALID_RESPONSE", "Provider response is too large.")
        return mapOf("status" to response.code, "body" to (source?.readUtf8() ?: ""),
          "url" to response.request.url.toString(), "headers" to response.headers.toMap())
      }
    } catch (error: Exception) {
      if (error is CodedException) throw error
      if (call.isCanceled()) fail("PROVIDER_CANCELLED", "Provider request cancelled.")
      if (error is SSLHandshakeException || error is SSLPeerUnverifiedException)
        fail("PROVIDER_CERTIFICATE_UNTRUSTED", "Couldn’t connect securely to this server.")
      fail("PROVIDER_NETWORK_ERROR", "Unable to reach the provider. Check your connection and try again.")
    } finally { calls.remove(id, call); cancelled.remove(id) }
  }
}
