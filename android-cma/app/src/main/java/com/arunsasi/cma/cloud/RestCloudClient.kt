package com.arunsasi.cma.cloud

import android.content.Context
import com.arunsasi.cma.data.entity.ReviewMark
import com.arunsasi.cma.data.entity.ScoreEvent
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Talks to a JSON HTTP backend for the signed-in user's own study data.
 * Default contract (tune to the chosen backend):
 *   POST {base}/auth/login     {username,password} -> {token}
 *   POST {base}/ingest/reviews [ {...} ]
 *   POST {base}/ingest/scores  [ {...} ]
 */
class RestCloudClient(
    private val context: Context,
    private val cfg: CloudConfig
) : CloudClient {

    private val http = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private val json = "application/json; charset=utf-8".toMediaType()
    private val base = cfg.baseUrl!!.trimEnd('/')

    private fun auth(b: Request.Builder) { cfg.apiKey?.let { b.header("Authorization", "Bearer $it") } }

    override fun authenticate(username: String, password: String): AuthResult {
        return try {
            val body = JSONObject().put("username", username).put("password", password)
                .toString().toRequestBody(json)
            val req = Request.Builder().url("$base/auth/login").post(body).also { auth(it) }.build()
            http.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return AuthResult(null, "Sign-in failed (${resp.code})")
                val token = JSONObject(resp.body?.string().orEmpty()).optString("token", "")
                if (token.isBlank()) AuthResult(null, "No token returned") else AuthResult(token)
            }
        } catch (e: Exception) { AuthResult(null, "Network error: ${e.message}") }
    }

    private fun postArray(path: String, arr: JSONArray): Boolean = try {
        val req = Request.Builder().url("$base$path").post(arr.toString().toRequestBody(json))
            .also { auth(it) }.build()
        http.newCall(req).execute().use { it.isSuccessful }
    } catch (e: Exception) { false }

    override fun pushReviews(rows: List<ReviewMark>) =
        postArray("/ingest/reviews", JSONArray().apply {
            rows.forEach { put(JSONObject()
                .put("owner", it.owner).put("key", it.key).put("kind", it.kind)
                .put("label", it.label).put("markedAt", it.markedAt).put("cleared", it.cleared)) }
        })

    override fun pushScores(rows: List<ScoreEvent>) =
        postArray("/ingest/scores", JSONArray().apply {
            rows.forEach { put(JSONObject()
                .put("owner", it.owner).put("section", it.section).put("correct", it.correct)
                .put("total", it.total).put("recordedAt", it.recordedAt)) }
        })
}
