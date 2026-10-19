package com.arunsasi.cma.cloud

import android.content.Context
import com.arunsasi.cma.data.entity.ReviewMark
import com.arunsasi.cma.data.entity.ScoreEvent

/** Result of an auth attempt. token != null means success. */
data class AuthResult(val token: String?, val error: String? = null)

/**
 * The seam between the app and a backend, so the backend is swappable.
 * It carries only the signed-in user's own study data (scores and
 * review flags). LocalOnlyCloudClient is the default.
 */
interface CloudClient {
    fun authenticate(username: String, password: String): AuthResult
    fun pushReviews(rows: List<ReviewMark>): Boolean
    fun pushScores(rows: List<ScoreEvent>): Boolean

    companion object {
        fun get(context: Context): CloudClient {
            val cfg = CloudConfig.load(context)
            return if (cfg.baseUrl.isNullOrBlank()) LocalOnlyCloudClient(context)
            else RestCloudClient(context, cfg)
        }
    }
}
