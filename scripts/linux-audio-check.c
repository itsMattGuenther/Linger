/* Test-only GTK module. Runs in an unchanged package on an isolated display.
 * Never reads accounts, messages, window titles, or the microphone. */
#include <gtk/gtk.h>
#include <webkit2/webkit2.h>
#include <gst/gst.h>

static WebKitWebView *view;
static gboolean pending;

static void save_result(const char *result) {
    g_file_set_contents(g_getenv("LINGER_AUDIO_RESULT"), result, -1, NULL);
}

static GtkWidget *find_webview(GtkWidget *widget) {
    if (WEBKIT_IS_WEB_VIEW(widget)) return widget;
    if (!GTK_IS_CONTAINER(widget)) return NULL;
    GList *children = gtk_container_get_children(GTK_CONTAINER(widget));
    GtkWidget *found = NULL;
    for (GList *child = children; child && !found; child = child->next)
        found = find_webview(child->data);
    g_list_free(children);
    return found;
}

static void result(GObject *source, GAsyncResult *res, gpointer unused) {
    (void)unused;
    GError *error = NULL;
    JSCValue *value = webkit_web_view_evaluate_javascript_finish(WEBKIT_WEB_VIEW(source), res, &error);
    if (error) {
        save_result("{\"status\":\"failed\",\"error\":\"WebView evaluation failed\"}");
        g_error_free(error);
    } else if (value && jsc_value_is_string(value)) {
        char *json = jsc_value_to_string(value);
        save_result(json);
        g_free(json);
    }
    g_clear_object(&value);
    pending = FALSE;
}

static gboolean poll_result(gpointer unused) {
    (void)unused;
    if (!pending) {
        pending = TRUE;
        webkit_web_view_evaluate_javascript(view,
            "JSON.stringify(window.__lingerAudioResult)", -1, NULL, NULL, NULL, result, NULL);
    }
    return G_SOURCE_CONTINUE;
}

static void injected(GObject *source, GAsyncResult *res, gpointer unused) {
    (void)unused;
    GError *error = NULL;
    JSCValue *value = webkit_web_view_evaluate_javascript_finish(WEBKIT_WEB_VIEW(source), res, &error);
    g_clear_object(&value);
    if (error) {
        save_result("{\"status\":\"failed\",\"error\":\"Could not inject audio probe\"}");
        g_error_free(error);
        return;
    }
    webkit_web_view_evaluate_javascript(view, "document.getElementById('linger-audio-probe').click()",
        -1, NULL, NULL, NULL, NULL, NULL);
    g_timeout_add(100, poll_result, NULL);
}

static gboolean start(gpointer unused) {
    (void)unused;
    GList *windows = gtk_window_list_toplevels();
    for (GList *item = windows; item && !view; item = item->next) {
        GtkWidget *found = find_webview(item->data);
        if (found && gtk_widget_get_mapped(found)) view = WEBKIT_WEB_VIEW(found);
    }
    g_list_free(windows);
    if (!view || webkit_web_view_is_loading(view)) return G_SOURCE_CONTINUE;
    webkit_settings_set_media_playback_requires_user_gesture(webkit_web_view_get_settings(view), FALSE);
    gchar *script = NULL;
    if (!g_file_get_contents(g_getenv("LINGER_AUDIO_SCRIPT"), &script, NULL, NULL)) {
        save_result("{\"status\":\"failed\",\"error\":\"Audio probe script missing\"}");
        return G_SOURCE_REMOVE;
    }
    webkit_web_view_evaluate_javascript(view, script, -1, NULL, NULL, NULL, injected, NULL);
    g_free(script);
    return G_SOURCE_REMOVE;
}

G_MODULE_EXPORT void gtk_module_init(gint *argc, gchar ***argv) {
    (void)argc; (void)argv;
    if (!g_getenv("LINGER_AUDIO_RESULT") || !g_getenv("LINGER_AUDIO_SCRIPT")) return;
    gst_init(NULL, NULL);
    const char *elements[] = {"appsrc", "audioconvert", "audioresample", "queue",
        "interleave", "autoaudiosink", "pulsesink"};
    for (guint i = 0; i < G_N_ELEMENTS(elements); i++) {
        GstElementFactory *factory = gst_element_factory_find(elements[i]);
        if (!factory) {
            gchar *message = g_strdup_printf("{\"status\":\"failed\",\"error\":\"Missing GStreamer element: %s\"}", elements[i]);
            save_result(message);
            g_free(message);
            return;
        }
        gst_object_unref(factory);
    }
    g_timeout_add(1000, start, NULL);
}
