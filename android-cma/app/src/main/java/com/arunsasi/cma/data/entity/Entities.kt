package com.arunsasi.cma.data.entity

import androidx.room.Entity
import androidx.room.PrimaryKey

/** A question/flashcard the user flagged for review (mirrored from the deck). */
@Entity(tableName = "review_mark")
data class ReviewMark(
    @PrimaryKey val key: String,          // e.g. "mcq:fsa:12" or "flash:cf:03"
    val owner: String,
    val kind: String,                     // "mcq" | "flashcard"
    val label: String?,
    val markedAt: Long,
    val cleared: Boolean = false,
    val synced: Boolean = false
)

/** A score/progress event (mirrored from the deck's localStorage). */
@Entity(tableName = "score_event")
data class ScoreEvent(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val owner: String,
    val section: String?,
    val correct: Int,
    val total: Int,
    val recordedAt: Long,
    val synced: Boolean = false
)
