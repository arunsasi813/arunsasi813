package com.arunsasi.cma.web

import android.content.Context
import android.webkit.JavascriptInterface
import com.arunsasi.cma.auth.SessionManager
import com.arunsasi.cma.data.AppDatabase
import com.arunsasi.cma.data.entity.ReviewMark
import com.arunsasi.cma.data.entity.ScoreEvent
import com.arunsasi.cma.sync.SyncManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Exposed to the deck as window.CMA. Records the signed-in user's own answers
 * and review flags into the local DB, then nudges a background sync. It never
 * reads anything outside the WebView.
 */
class JsBridge(private val context: Context) {

    private val scope = CoroutineScope(Dispatchers.IO)
    private val db get() = AppDatabase.get(context)
    private val owner get() = SessionManager.get(context).username ?: "me"

    @JavascriptInterface
    fun recordAnswer(section: String?, correct: Boolean) {
        scope.launch {
            db.scores().insert(
                ScoreEvent(
                    owner = owner,
                    section = section,
                    correct = if (correct) 1 else 0,
                    total = 1,
                    recordedAt = System.currentTimeMillis()
                )
            )
            SyncManager.requestSync(context)
        }
    }

    @JavascriptInterface
    fun toggleReview(key: String, kind: String, label: String?, marked: Boolean) {
        scope.launch {
            db.reviews().upsert(
                ReviewMark(
                    key = key,
                    owner = owner,
                    kind = kind,
                    label = label,
                    markedAt = System.currentTimeMillis(),
                    cleared = !marked,
                    synced = false
                )
            )
            SyncManager.requestSync(context)
        }
    }
}
