package com.arunsasi.cma.auth

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.security.MessageDigest

/**
 * Local secure state in EncryptedSharedPreferences: the signed-in user + token
 * (for auto sign-in), the owner's study password, and the owner PIN that gates
 * the owner stats area. Nothing here captures anyone else's data.
 */
class SessionManager private constructor(private val prefs: SharedPreferences) {

    // ---- current session / auto sign-in -------------------------------
    var username: String?
        get() = prefs.getString(K_USER, null)
        set(v) = prefs.edit().putString(K_USER, v).apply()

    var token: String?
        get() = prefs.getString(K_TOKEN, null)
        set(v) = prefs.edit().putString(K_TOKEN, v).apply()

    val isSignedIn: Boolean get() = !username.isNullOrEmpty() && !token.isNullOrEmpty()

    fun signIn(user: String, token: String) {
        prefs.edit().putString(K_USER, user).putString(K_TOKEN, token).apply()
    }

    fun signOut() {
        prefs.edit().remove(K_USER).remove(K_TOKEN).apply()
    }

    // ---- local study credential (used only when no backend) -----------
    val isStudyConfigured: Boolean get() = prefs.contains(K_STUDY_PW)

    fun setStudyPassword(pw: String) {
        prefs.edit().putString(K_STUDY_PW, sha256(pw)).apply()
    }

    fun checkStudyPassword(pw: String): Boolean =
        isStudyConfigured && prefs.getString(K_STUDY_PW, null) == sha256(pw)

    // ---- owner PIN (gates the owner's own stats area) -----------------
    val isOwnerPinConfigured: Boolean get() = prefs.contains(K_OWNER_PIN)

    fun setOwnerPin(pin: String) {
        prefs.edit().putString(K_OWNER_PIN, sha256(pin)).apply()
    }

    fun checkOwnerPin(pin: String): Boolean =
        isOwnerPinConfigured && prefs.getString(K_OWNER_PIN, null) == sha256(pin)

    private fun sha256(s: String): String =
        MessageDigest.getInstance("SHA-256").digest(s.toByteArray())
            .joinToString("") { "%02x".format(it) }

    companion object {
        private const val K_USER = "user"
        private const val K_TOKEN = "token"
        private const val K_STUDY_PW = "study_pw"
        private const val K_OWNER_PIN = "owner_pin"

        @Volatile private var INSTANCE: SessionManager? = null

        fun get(context: Context): SessionManager =
            INSTANCE ?: synchronized(this) { INSTANCE ?: build(context).also { INSTANCE = it } }

        private fun build(context: Context): SessionManager {
            val key = MasterKey.Builder(context.applicationContext)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
            val prefs = EncryptedSharedPreferences.create(
                context.applicationContext, "cma_secure", key,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            )
            return SessionManager(prefs)
        }
    }
}
