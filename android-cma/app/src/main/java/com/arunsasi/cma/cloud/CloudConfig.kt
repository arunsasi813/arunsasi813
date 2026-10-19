package com.arunsasi.cma.cloud

import android.content.Context

/**
 * Backend connection settings. Fill [baseUrl] (and whatever auth your server
 * needs) once the backend is chosen; leave blank to run fully local.
 */
data class CloudConfig(
    val baseUrl: String?,
    val apiKey: String?
) {
    companion object {
        fun load(context: Context): CloudConfig {
            val p = context.getSharedPreferences("cloud_cfg", Context.MODE_PRIVATE)
            return CloudConfig(
                baseUrl = p.getString("base_url", null),
                apiKey = p.getString("api_key", null)
            )
        }

        fun save(context: Context, baseUrl: String?, apiKey: String?) {
            context.getSharedPreferences("cloud_cfg", Context.MODE_PRIVATE)
                .edit().putString("base_url", baseUrl).putString("api_key", apiKey).apply()
        }
    }
}
