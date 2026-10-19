package com.arunsasi.cma.data.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import com.arunsasi.cma.data.entity.ReviewMark
import com.arunsasi.cma.data.entity.ScoreEvent

@Dao
interface ReviewDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE) fun upsert(row: ReviewMark)

    @Query("SELECT * FROM review_mark WHERE owner = :owner AND cleared = 0 ORDER BY markedAt DESC")
    fun active(owner: String): List<ReviewMark>

    @Query("SELECT * FROM review_mark WHERE synced = 0 LIMIT :limit")
    fun unsynced(limit: Int): List<ReviewMark>

    @Query("UPDATE review_mark SET synced = 1 WHERE key IN (:keys)")
    fun markSynced(keys: List<String>)
}

@Dao
interface ScoreDao {
    @Insert fun insert(row: ScoreEvent): Long

    @Query("SELECT * FROM score_event WHERE owner = :owner ORDER BY recordedAt DESC LIMIT :limit")
    fun recent(owner: String, limit: Int): List<ScoreEvent>

    @Query("SELECT SUM(correct) FROM score_event WHERE owner = :owner")
    fun totalCorrect(owner: String): Int?

    @Query("SELECT SUM(total) FROM score_event WHERE owner = :owner")
    fun totalAnswered(owner: String): Int?

    @Query("SELECT * FROM score_event WHERE synced = 0 LIMIT :limit")
    fun unsynced(limit: Int): List<ScoreEvent>

    @Query("UPDATE score_event SET synced = 1 WHERE id IN (:ids)")
    fun markSynced(ids: List<Long>)
}
