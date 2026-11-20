package com.openwhispr.googleauth

import android.accounts.Account
import android.accounts.AccountManager
import android.app.Activity
import android.os.CancellationSignal
import androidx.credentials.CredentialManager
import androidx.credentials.CredentialManagerCallback
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.AuthorizationResult
import com.google.android.gms.auth.api.identity.ClearTokenRequest
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.common.api.Scope
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val REQUEST_CODE = 0x6C41
private const val PICK_ACCOUNT_CODE = 0x6C42

/**
 * Google OAuth on Android through Play services' AuthorizationClient. Google no longer accepts
 * custom-scheme redirects for Android clients, so the consent sheet is native; Google matches the
 * app's package and signing certificate against the project's Android OAuth client.
 */
class GoogleAuthorizationModule : Module() {
  private var pending: Promise? = null
  private var pendingPick: Promise? = null

  override fun definition() = ModuleDefinition {
    Name("GoogleAuthorization")

    // interactive = false never shows UI: a grant the user has to give rejects CONSENT_REQUIRED.
    AsyncFunction("authorize") { scopes: List<String>, account: String?, interactive: Boolean, promise: Promise ->
      val activity = appContext.currentActivity
        ?: return@AsyncFunction promise.reject("FAILED", "No activity to show Google's sheet", null)
      val builder = AuthorizationRequest.builder().setRequestedScopes(scopes.map { Scope(it) })
      if (!account.isNullOrBlank()) builder.setAccount(Account(account, "com.google"))
      Identity.getAuthorizationClient(activity)
        .authorize(builder.build())
        .addOnSuccessListener { result ->
          val intent = result.pendingIntent
          if (!result.hasResolution() || intent == null) {
            promise.resolve(toMap(result))
          } else if (!interactive) {
            promise.reject("CONSENT_REQUIRED", "Google needs the user to grant access again", null)
          } else if (pending != null) {
            promise.reject("FAILED", "Google authorization is already in progress", null)
          } else {
            pending = promise
            try {
              activity.startIntentSenderForResult(intent.intentSender, REQUEST_CODE, null, 0, 0, 0, null)
            } catch (error: Exception) {
              pending = null
              promise.reject("FAILED", error.message ?: "Could not open Google's sheet", error)
            }
          }
        }
        .addOnFailureListener { error -> promise.reject(codeFor(error), error.message ?: "Google authorization failed", error) }
    }.runOnQueue(Queues.MAIN)

    // Android's account picker. Without it AuthorizationClient silently reuses the account it
    // granted last, so a second Google account could never be added. Resolves null on cancel.
    AsyncFunction("chooseAccount") { promise: Promise ->
      val activity = appContext.currentActivity
        ?: return@AsyncFunction promise.reject("FAILED", "No activity to show the account picker", null)
      if (pendingPick != null) return@AsyncFunction promise.reject("FAILED", "Account picker already open", null)
      pendingPick = promise
      try {
        val intent = AccountManager.newChooseAccountIntent(
          null, null, arrayOf("com.google"), null, null, null, null,
        )
        activity.startActivityForResult(intent, PICK_ACCOUNT_CODE)
      } catch (error: Exception) {
        pendingPick = null
        promise.reject("FAILED", error.message ?: "Could not open the account picker", error)
      }
    }.runOnQueue(Queues.MAIN)

    // Signing in to OpenWhispr: Android's "Sign in with Google" sheet (accounts on the phone, or
    // add one). The ID token is issued for `serverClientId`, the API's web client, so the API
    // verifies it as it does a browser sign-in. Rejects CANCELLED when the user backs out.
    AsyncFunction("signIn") { serverClientId: String, nonce: String, promise: Promise ->
      val activity = appContext.currentActivity
        ?: return@AsyncFunction promise.reject("FAILED", "No activity to show Google's sheet", null)
      val option = GetSignInWithGoogleOption.Builder(serverClientId).setNonce(nonce).build()
      val request = GetCredentialRequest.Builder().addCredentialOption(option).build()
      CredentialManager.create(activity).getCredentialAsync(
        activity,
        request,
        CancellationSignal(),
        activity.mainExecutor,
        object : CredentialManagerCallback<GetCredentialResponse, GetCredentialException> {
          override fun onResult(result: GetCredentialResponse) {
            val credential = result.credential
            if (credential is CustomCredential &&
              credential.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL
            ) {
              val google = GoogleIdTokenCredential.createFrom(credential.data)
              promise.resolve(mapOf("idToken" to google.idToken, "email" to google.id))
            } else {
              promise.reject("FAILED", "Google returned an unexpected credential", null)
            }
          }

          override fun onError(e: GetCredentialException) {
            val code = if (e is GetCredentialCancellationException) "CANCELLED" else "FAILED"
            promise.reject(code, e.message ?: e.type, e)
          }
        },
      )
    }.runOnQueue(Queues.MAIN)

    // Drops a token from Play services' cache so a revoked one isn't handed back.
    AsyncFunction("clearToken") { token: String, promise: Promise ->
      val activity = appContext.currentActivity ?: return@AsyncFunction promise.resolve(null)
      Identity.getAuthorizationClient(activity)
        .clearToken(ClearTokenRequest.builder().setToken(token).build())
        .addOnSuccessListener { promise.resolve(null) }
        .addOnFailureListener { promise.resolve(null) }
    }.runOnQueue(Queues.MAIN)

    OnActivityResult { activity, payload ->
      if (payload.requestCode == PICK_ACCOUNT_CODE) {
        val pick = pendingPick ?: return@OnActivityResult
        pendingPick = null
        val name = payload.data?.getStringExtra(AccountManager.KEY_ACCOUNT_NAME)
        pick.resolve(if (payload.resultCode == Activity.RESULT_OK) name else null)
        return@OnActivityResult
      }
      if (payload.requestCode != REQUEST_CODE) return@OnActivityResult
      val promise = pending ?: return@OnActivityResult
      pending = null
      if (payload.resultCode != Activity.RESULT_OK) {
        promise.reject("CANCELLED", "Google authorization was cancelled", null)
        return@OnActivityResult
      }
      try {
        val result = Identity.getAuthorizationClient(activity).getAuthorizationResultFromIntent(payload.data)
        promise.resolve(toMap(result))
      } catch (error: ApiException) {
        promise.reject(codeFor(error), error.message ?: "Google authorization failed", error)
      }
    }
  }

  private fun toMap(result: AuthorizationResult): Map<String, Any?> = mapOf(
    "accessToken" to result.accessToken,
    "grantedScopes" to result.grantedScopes,
  )

  private fun codeFor(error: Exception): String =
    if (error is ApiException && error.statusCode == CommonStatusCodes.CANCELED) "CANCELLED" else "FAILED"
}
