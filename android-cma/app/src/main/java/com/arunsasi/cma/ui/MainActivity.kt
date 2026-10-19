package com.arunsasi.cma.ui

import android.annotation.SuppressLint
import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.text.InputType
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import com.arunsasi.cma.auth.SessionManager
import com.arunsasi.cma.databinding.ActivityMainBinding
import com.arunsasi.cma.sync.SyncManager
import com.arunsasi.cma.web.JsBridge

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private val session by lazy { SessionManager.get(this) }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (!session.isSignedIn) {
            startActivity(Intent(this, LoginActivity::class.java))
            finish()
            return
        }

        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        val web = binding.webview
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true          // persists the deck's own progress
            allowFileAccess = true
            cacheMode = android.webkit.WebSettings.LOAD_DEFAULT
        }
        web.addJavascriptInterface(JsBridge(applicationContext), "CMA")
        web.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String?) {
                injectBridge(view)
            }
        }
        web.loadUrl("file:///android_asset/deck/index.html")

        binding.gear.setOnClickListener { onGear() }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) web.goBack()
                // When pinned, swallow back so a borrower can't leave the quiz.
                else if (!isPinned()) { isEnabled = false; onBackPressedDispatcher.onBackPressed() }
            }
        })

        SyncManager.requestSync(applicationContext)
    }

    private fun injectBridge(view: WebView) {
        val js = runCatching {
            assets.open("web/deckbridge.js").bufferedReader().use { it.readText() }
        }.getOrNull() ?: return
        view.evaluateJavascript(js, null)
    }

    // ---- owner gate ----------------------------------------------------
    private fun onGear() {
        if (!session.isOwnerPinConfigured) promptSetPin() else promptEnterPin()
    }

    private fun promptSetPin() {
        val input = pinField()
        AlertDialog.Builder(this)
            .setTitle("Set an owner PIN")
            .setMessage("This PIN protects the owner area. The person you lend the phone to won't know it.")
            .setView(input)
            .setPositiveButton("Save") { _, _ ->
                val pin = input.text.toString()
                if (pin.length >= 4) { session.setOwnerPin(pin); showOwnerMenu() }
                else toast("Use at least 4 digits")
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun promptEnterPin() {
        val input = pinField()
        AlertDialog.Builder(this)
            .setTitle("Owner PIN")
            .setView(input)
            .setPositiveButton("Unlock") { _, _ ->
                if (session.checkOwnerPin(input.text.toString())) showOwnerMenu()
                else toast("Wrong PIN")
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun showOwnerMenu() {
        val pinned = isPinned()
        val items = mutableListOf("Owner stats", if (pinned) "Unlock phone" else "Lock phone to quiz", "Sign out")
        AlertDialog.Builder(this)
            .setTitle("Owner")
            .setItems(items.toTypedArray()) { _, which ->
                when (which) {
                    0 -> startActivity(Intent(this, OwnerActivity::class.java))
                    1 -> if (pinned) stopPinning() else startPinning()
                    2 -> { session.signOut(); startActivity(Intent(this, LoginActivity::class.java)); finish() }
                }
            }
            .show()
    }

    // ---- screen pinning (lock to the quiz before lending) --------------
    private fun isPinned(): Boolean {
        val am = getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        return am.lockTaskModeState != ActivityManager.LOCK_TASK_MODE_NONE
    }

    private fun startPinning() {
        runCatching { startLockTask() }
            .onSuccess { toast("Locked to the quiz. Confirm the system prompt. To unlock later: Owner → Unlock.") }
            .onFailure { toast("Could not lock. Enable Settings → Security → Screen pinning.") }
    }

    private fun stopPinning() {
        runCatching { stopLockTask() }.onFailure { toast("Could not unlock") }
    }

    private fun pinField(): EditText = EditText(this).apply {
        inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
        val pad = (20 * resources.displayMetrics.density).toInt()
        setPadding(pad, pad, pad, pad)
    }

    private fun toast(m: String) =
        android.widget.Toast.makeText(this, m, android.widget.Toast.LENGTH_LONG).show()
}
