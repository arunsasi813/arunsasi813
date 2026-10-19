package com.arunsasi.cma.ui

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.arunsasi.cma.auth.SessionManager
import com.arunsasi.cma.cloud.CloudConfig
import com.arunsasi.cma.data.AppDatabase
import com.arunsasi.cma.databinding.ActivityOwnerBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Owner-only. Shows the signed-in user's own study stats (scores + review
 * flags) and lets the owner point the app at a backend. Not exported; it's
 * only reachable after the owner PIN check in MainActivity.
 */
class OwnerActivity : AppCompatActivity() {

    private lateinit var binding: ActivityOwnerBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityOwnerBinding.inflate(layoutInflater)
        setContentView(binding.root)

        val cfg = CloudConfig.load(this)
        binding.baseUrl.setText(cfg.baseUrl ?: "")
        binding.apiKey.setText(cfg.apiKey ?: "")
        binding.saveBackend.setOnClickListener {
            CloudConfig.save(
                this,
                binding.baseUrl.text.toString().trim().ifEmpty { null },
                binding.apiKey.text.toString().trim().ifEmpty { null }
            )
            binding.stats.append("\n\nBackend saved.")
        }

        loadStats()
    }

    private fun loadStats() {
        val owner = SessionManager.get(this).username ?: "me"
        lifecycleScope.launch {
            val text = withContext(Dispatchers.IO) {
                val db = AppDatabase.get(this@OwnerActivity)
                val correct = db.scores().totalCorrect(owner) ?: 0
                val answered = db.scores().totalAnswered(owner) ?: 0
                val acc = if (answered > 0) (correct * 100.0 / answered) else 0.0
                val reviews = db.reviews().active(owner)
                val recent = db.scores().recent(owner, 8)
                buildString {
                    append("Signed in as: $owner\n\n")
                    append("Questions answered: $answered\n")
                    append("Correct: $correct\n")
                    append("Accuracy: ${"%.1f".format(acc)}%\n\n")
                    append("Marked for review: ${reviews.size}\n")
                    reviews.take(12).forEach { append("  • [${it.kind}] ${it.label ?: it.key}\n") }
                    if (recent.isNotEmpty()) {
                        append("\nRecent sections:\n")
                        recent.forEach { append("  • ${it.section ?: "?"}: ${it.correct}/${it.total}\n") }
                    }
                }
            }
            binding.stats.text = text
        }
    }
}
