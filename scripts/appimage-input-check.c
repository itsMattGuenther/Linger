/* Test-only GTK module loaded into an unchanged package on a private desktop.
 * Only the empty onboarding input is touched. No account, title or microphone.
 * Not linked into or shipped with Linger. */
#include <gtk/gtk.h>
#include <webkit2/webkit2.h>
#include <stdio.h>
#include <string.h>

static WebKitWebView *view;
static int phase;
static const char *sample;

static GtkWidget *webview(GtkWidget *widget) {
    if (WEBKIT_IS_WEB_VIEW(widget)) return widget;
    if (!GTK_IS_CONTAINER(widget)) return NULL;
    GList *children = gtk_container_get_children(GTK_CONTAINER(widget));
    GtkWidget *found = NULL;
    for (GList *child = children; child && !found; child = child->next) found = webview(child->data);
    g_list_free(children);
    return found;
}

static gboolean read_input(gpointer unused);
static gboolean paste(gpointer unused) {
    (void)unused;
    webkit_web_view_execute_editing_command(view, WEBKIT_EDITING_COMMAND_PASTE);
    g_timeout_add(600, read_input, NULL);
    return G_SOURCE_REMOVE;
}

static void begin_input(GObject *source, GAsyncResult *res, gpointer unused) {
    (void)unused;
    JSCValue *value = webkit_web_view_evaluate_javascript_finish(WEBKIT_WEB_VIEW(source), res, NULL);
    if (!value || !jsc_value_to_boolean(value)) { g_clear_object(&value); return; }
    g_object_unref(value);
    int status = 0;
    sample = phase == 0 ? "hello world! Voice 123." : "Café — hello Voice 123.";
    char *typing[] = {"wtype", "-d", "30", (char *)sample, NULL};
    char *copy[] = {"wl-copy", "--", (char *)sample, NULL};
    if (phase == 0) {
        if (!g_spawn_async(NULL, typing, NULL, G_SPAWN_SEARCH_PATH, NULL, NULL, NULL, NULL)) return;
        g_timeout_add(2000, read_input, NULL);
    } else {
        if (!g_spawn_sync(NULL, copy, NULL, G_SPAWN_SEARCH_PATH, NULL, NULL,
            NULL, NULL, &status, NULL) || !g_spawn_check_wait_status(status, NULL)) return;
        g_timeout_add(300, paste, NULL);
    }
}

static void prepare(void) {
    webkit_web_view_evaluate_javascript(view,
        "(()=>{const e=document.querySelector('input');if(!e)return false;"
        "e.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'');"
        "e.dispatchEvent(new Event('input',{bubbles:true}));return true})()",
        -1, NULL, NULL, NULL, begin_input, NULL);
}

static void result(GObject *source, GAsyncResult *res, gpointer unused) {
    (void)unused;
    JSCValue *value = webkit_web_view_evaluate_javascript_finish(WEBKIT_WEB_VIEW(source), res, NULL);
    if (!value || !jsc_value_is_string(value)) { g_clear_object(&value); return; }
    char *actual = jsc_value_to_string(value);
    const char *area = g_getenv("LINGER_CHECK_AREA");
    char *path = g_build_filename(area, "probe.log", NULL);
    FILE *output = fopen(path, "a");
    if (output) {
        fprintf(output, "packaged %s: %s\n", phase == 0 ? "typing" : "clipboard",
            !strcmp(actual, sample) ? "MATCH" : "DIFFERENT");
        fclose(output);
    }
    g_free(path); g_free(actual); g_object_unref(value);
    if (phase++ == 0) prepare();
    else {
        path = g_build_filename(area, "completed", NULL);
        g_file_set_contents(path, "done", -1, NULL);
        g_free(path);
    }
}

static gboolean read_input(gpointer unused) {
    (void)unused;
    webkit_web_view_evaluate_javascript(view, "document.querySelector('input').value",
        -1, NULL, NULL, NULL, result, NULL);
    return G_SOURCE_REMOVE;
}

static gboolean find_view(gpointer unused) {
    (void)unused;
    GList *windows = gtk_window_list_toplevels();
    for (GList *item = windows; item && !view; item = item->next) {
        GtkWidget *found = webview(item->data);
        if (!found || !gtk_widget_get_mapped(found)) continue;
        view = WEBKIT_WEB_VIEW(found);
        GdkPixbuf *icon = gtk_window_get_icon(GTK_WINDOW(item->data));
        if (icon) {
            char *path = g_build_filename(g_getenv("LINGER_CHECK_AREA"), "running-window-icon.png", NULL);
            gdk_pixbuf_save(icon, path, "png", NULL, NULL);
            g_free(path);
        }
    }
    g_list_free(windows);
    if (!view) return G_SOURCE_CONTINUE;
    char *path = g_build_filename(g_getenv("LINGER_CHECK_AREA"), "backend", NULL);
    g_file_set_contents(path, G_OBJECT_TYPE_NAME(gdk_display_get_default()), -1, NULL);
    g_free(path);
    path = g_build_filename(g_getenv("LINGER_CHECK_AREA"), "gbm", NULL);
    const char *gbm = g_getenv("WEBKIT_DMABUF_RENDERER_DISABLE_GBM");
    g_file_set_contents(path, gbm ? gbm : "unset", -1, NULL);
    g_free(path);
    prepare();
    return G_SOURCE_REMOVE;
}

G_MODULE_EXPORT void gtk_module_init(gint *argc, gchar ***argv) {
    (void)argc; (void)argv;
    if (g_strcmp0(g_getenv("LINGER_PRIVATE_INPUT_DISPLAY"), "1") || !g_getenv("LINGER_CHECK_AREA")) return;
    g_timeout_add(2000, find_view, NULL);
}
