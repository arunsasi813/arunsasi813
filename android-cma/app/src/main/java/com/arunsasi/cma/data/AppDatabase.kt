package com.arunsasi.cma.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import com.arunsasi.cma.data.dao.ReviewDao
import com.arunsasi.cma.data.dao.ScoreDao
import com.arunsasi.cma.data.entity.ReviewMark
import com.arunsasi.cma.data.entity.ScoreEvent

@Database(
    entities = [ReviewMark::class, ScoreEvent::class],
    version = 2,
    exportSchema = false
)
abstract class AppDatabase : RoomDatabase() {
    abstract fun reviews(): ReviewDao
    abstract fun scores(): ScoreDao

    companion object {
        @Volatile private var INSTANCE: AppDatabase? = null

        fun get(context: Context): AppDatabase =
            INSTANCE ?: synchronized(this) {
                INSTANCE ?: Room.databaseBuilder(
                    context.applicationContext,
                    AppDatabase::class.java,
                    "cma.db"
                )
                    // Only local study stats; dropping them on a schema change is
                    // acceptable and avoids a crash for anyone on the v1 schema.
                    .fallbackToDestructiveMigration()
                    .build().also { INSTANCE = it }
            }
    }
}
