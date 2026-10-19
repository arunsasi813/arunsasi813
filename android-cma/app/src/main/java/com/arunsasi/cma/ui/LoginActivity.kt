package com.arunsasi.cma.ui

import android.content.Intent
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.arunsasi.cma.auth.SessionManager
import com.arunsasi.cma.cloud.CloudClient
import com.arunsasi.cma.databinding.ActivityLoginBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class LoginActivity : AppCompatActivity() {

    private lateinit var binding: ActivityLoginBinding
    private val session by lazy { SessionManager.get(this) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Already signed in (auto sign-in): skip straight to the app.
        if (session.isSignedIn) { goMain(); return }

        binding = ActivityLoginBinding.inflate(layoutInflater)
        setContentView(binding.root)

        // First run with no backend configured: tell the user this first
        // password becomes the study password for this phone.
        if (!session.isStudyConfigured) {
            binding.hint.text = "First sign-in sets the password for this phone."
        }

        binding.signin.setOnClickListener { doSignIn() }
    }

    private fun doSignIn() {
        val user = binding.username.text.toString().trim().ifEmpty { "me" }
        val pass = binding.password.text.toString()
        if (pass.isEmpty()) { binding.message.text = "Enter a password"; return }

        binding.signin.isEnabled = false
        binding.message.text = "Signing in…"
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                CloudClient.get(this@LoginActivity).authenticate(user, pass)
            }
            binding.signin.isEnabled = true
            val token = result.token
            if (token != null) {
                session.signIn(user, token)
                goMain()
            } else {
                binding.message.text = result.error ?: "Sign-in failed"
            }
        }
    }

    private fun goMain() {
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }
}
