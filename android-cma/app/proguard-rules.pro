# Keep the JS bridge methods reachable from the WebView.
-keepclassmembers class com.arunsasi.cma.web.JsBridge {
    @android.webkit.JavascriptInterface <methods>;
}
