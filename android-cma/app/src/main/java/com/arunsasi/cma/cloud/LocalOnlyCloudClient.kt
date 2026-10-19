package com.arunsasi.cma.cloud

import android.content.Context
import com.arunsasi.cma.auth.SessionManager
import com.arunsasi.cma.data.entity.ReviewMark
import com.arunsasi.cma.data.entity.ScoreEvent
import java.util.UUID

/**
 * No external server: the on-device DB holds the user's study data. Auth is a
 * local study credential the owner sets on first sign-in (see SessionManager).
 */
class LocalOnlyCloudClient(private val context: Context) : CloudClient {

    override fun authenticate(username: String, password: String): AuthResult {
        val sm = SessionManager.get(context)
        if (!sm.isStudyConfigured) {
            if (password.length < 4) return AuthResult(null, "Choose a password of 4+ characters")
            sm.setStudyPassword(password)
            return AuthResult(UUID.randomUUID().toString())
        }
        return if (sm.checkStudyPassword(password)) AuthResult(UUID.randomUUID().toString())
        else AuthResult(null, "Wrong password")
    }

    override fun pushReviews(rows: List<ReviewMark>) = true
    override fun pushScores(rows: List<ScoreEvent>) = true
}
