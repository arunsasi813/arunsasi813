package com.arunsasi.cma.sync

import android.content.Context
import com.arunsasi.cma.cloud.CloudClient
import com.arunsasi.cma.data.AppDatabase
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex

/**
 * Pushes the signed-in user's own unsynced scores and review flags to the
 * configured CloudClient. Best-effort: if offline or local-only, rows simply
 * stay in the on-device DB. Debounced so rapid bridge writes coalesce.
 */
object SyncManager {
    private val scope = CoroutineScope(Dispatchers.IO)
    private val lock = Mutex()

    fun requestSync(context: Context) {
        scope.launch {
            if (!lock.tryLock()) return@launch
            try {
                val db = AppDatabase.get(context)
                val cloud = CloudClient.get(context)

                val scores = db.scores().unsynced(200)
                if (scores.isNotEmpty() && cloud.pushScores(scores)) {
                    db.scores().markSynced(scores.map { it.id })
                }

                val reviews = db.reviews().unsynced(200)
                if (reviews.isNotEmpty() && cloud.pushReviews(reviews)) {
                    db.reviews().markSynced(reviews.map { it.key })
                }
            } catch (_: Exception) {
                // best-effort; retried on the next write / app start
            } finally {
                lock.unlock()
            }
        }
    }
}
