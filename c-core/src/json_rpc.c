#include "../include/json_rpc.h"
#include "../include/safety.h"
#include "../include/command_guard.h"
#include "../include/injection_detector.h"
#include "../include/loop_guard.h"
#include "../include/stream_processor.h"
#include "../include/tools.h"
#include "../include/agent_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>

#ifdef _WIN32
#include <windows.h>
#include <process.h>
#else
#include <pthread.h>
#endif

#define MAX_RPC_TASKS 8

typedef struct {
    char *request;
    volatile long *cancel_requested;
    bool used;
    bool completed;
#ifdef _WIN32
    HANDLE thread;
#else
    pthread_t thread;
#endif
    void *output_lock;
} RpcTask;

static RpcTask rpc_tasks[MAX_RPC_TASKS];
#ifdef _WIN32
static CRITICAL_SECTION rpc_task_lock;
#else
static pthread_mutex_t rpc_task_lock = PTHREAD_MUTEX_INITIALIZER;
#endif

static void rpc_lock_tasks(void) {
#ifdef _WIN32
    EnterCriticalSection(&rpc_task_lock);
#else
    pthread_mutex_lock(&rpc_task_lock);
#endif
}
static void rpc_unlock_tasks(void) {
#ifdef _WIN32
    LeaveCriticalSection(&rpc_task_lock);
#else
    pthread_mutex_unlock(&rpc_task_lock);
#endif
}
static bool rpc_tasks_initialized = false;
static int json_get_int_val(const char *json, const char *key, int default_val);
static bool json_get_bool_val(const char *json, const char *key, bool default_val);
static char *json_dup_string_val(const char *json, const char *key);
static AutonomyLevel parse_autonomy_level(const char *str);
static char *json_escape_to_str(const char *s);

static void rpc_output_lock(void *lock) {
#ifdef _WIN32
    EnterCriticalSection((CRITICAL_SECTION *)lock);
#else
    pthread_mutex_lock((pthread_mutex_t *)lock);
#endif
}

static void rpc_output_unlock(void *lock) {
#ifdef _WIN32
    LeaveCriticalSection((CRITICAL_SECTION *)lock);
#else
    pthread_mutex_unlock((pthread_mutex_t *)lock);
#endif
}

static void rpc_write_response(const char *response, void *lock) {
    rpc_output_lock(lock);
    if (response) {
        fputs(response, stdout);
        fflush(stdout);
    }
    rpc_output_unlock(lock);
}

static void rpc_task_execute(void *argument) {
    RpcTask *task = (RpcTask *)argument;
    int id = json_get_int_val(task->request, "id", 0);
    char *tool = json_dup_string_val(task->request, "tool");
    char *command = json_dup_string_val(task->request, "command");
    char *workspace = json_dup_string_val(task->request, "workspace");
    char *autonomy = json_dup_string_val(task->request, "autonomy");
    char *user_data_dir = json_dup_string_val(task->request, "user_data_dir");
    bool approved = json_get_bool_val(task->request, "approved", false);
    int timeout = json_get_int_val(task->request, "timeout_ms", 60000);
    if (timeout <= 0 || timeout > 300000) timeout = 60000;
    SafetyContext context;
    memset(&context, 0, sizeof(context));
    if (workspace) strncpy(context.working_directory, workspace, sizeof(context.working_directory) - 1);
    /* TLS 线程副本：工作线程必须显式设置本线程副本，否则异步线程私有目录防护完全失效。 */
    if (user_data_dir && *user_data_dir) {
        strncpy(context.user_data_dir, user_data_dir, sizeof(context.user_data_dir) - 1);
        safety_set_user_data_dir(user_data_dir);
    } else {
        safety_set_user_data_dir("");
    }
    context.autonomy = parse_autonomy_level(autonomy);
    context.approved = approved;
    ToolResult result = tool_run_command_cancellable(command ? command : "", workspace ? workspace : ".", &context, timeout, task->cancel_requested);

    char *esc_tool = json_escape_to_str(tool ? tool : "run_command");
    char *esc_out = json_escape_to_str(result.output ? result.output : "");
    char *esc_err = json_escape_to_str(result.error_message);
    if (!esc_tool || !esc_out || !esc_err) {
        /* Ticket 3：内存分配失败也必须回 JSON 错误响应，不能静默丢帧 */
        char oom_response[160];
        snprintf(oom_response, sizeof(oom_response),
                 "{\"id\":%d,\"success\":false,\"error\":\"Out of memory building response\"}\n", id);
        rpc_write_response(oom_response, task->output_lock);
        free(esc_tool); free(esc_out); free(esc_err);
        esc_tool = NULL; esc_out = NULL; esc_err = NULL;
    }
    if (esc_tool && esc_out && esc_err) {
        size_t resp_cap = strlen(esc_tool) + strlen(esc_out) + strlen(esc_err) + 128;
        char *response = (char *)malloc(resp_cap);
        if (response) {
            snprintf(response, resp_cap,
                     "{\"id\":%d,\"success\":true,\"action\":\"run_tool\",\"tool\":%s,\"toolSuccess\":%s,\"output\":%s,\"error\":%s}\n",
                     id, esc_tool, result.success ? "true" : "false", esc_out, esc_err);
            rpc_write_response(response, task->output_lock);
            free(response);
        } else {
            char oom_response[160];
            snprintf(oom_response, sizeof(oom_response),
                     "{\"id\":%d,\"success\":false,\"error\":\"Out of memory building response\"}\n", id);
            rpc_write_response(oom_response, task->output_lock);
        }
    }
    free(esc_tool);
    free(esc_out);
    free(esc_err);

    tool_result_free(&result);
    free(tool); free(command); free(workspace); free(autonomy); free(user_data_dir);
    /* 任务结束清空本线程 TLS 副本：线程复用时不把上个请求的私有目录带给下个任务 */
    safety_set_user_data_dir("");
    /* The owner frees cancellation state only after joining this worker. */
    rpc_lock_tasks();
    task->completed = true;
    rpc_unlock_tasks();
}

#ifdef _WIN32
static unsigned __stdcall rpc_task_main(void *argument) {
    rpc_task_execute(argument);
    return 0;
}
#else
static void *rpc_task_main(void *argument) {
    rpc_task_execute(argument);
    return NULL;
}
#endif

static void rpc_init_tasks(void *lock) {
    if (rpc_tasks_initialized) return;
    for (int i = 0; i < MAX_RPC_TASKS; ++i) rpc_tasks[i].output_lock = lock;
    rpc_tasks_initialized = true;
}

static void rpc_reap_tasks(void) {
    rpc_lock_tasks();
    for (int i = 0; i < MAX_RPC_TASKS; ++i) {
        RpcTask *task = &rpc_tasks[i];
        if (!task->used || !task->completed) continue;
#ifdef _WIN32
        WaitForSingleObject(task->thread, INFINITE);
        CloseHandle(task->thread);
#else
        pthread_join(task->thread, NULL);
#endif
        free(task->request);
        free((void *)task->cancel_requested);
        void *output_lock = task->output_lock;
        memset(task, 0, sizeof(*task));
        task->output_lock = output_lock;
    }
    rpc_unlock_tasks();
}

static void rpc_cancel_task(int id, void *lock) {
    rpc_lock_tasks();
    bool found = false;
    for (int i = 0; i < MAX_RPC_TASKS; ++i) {
        if (rpc_tasks[i].used && json_get_int_val(rpc_tasks[i].request, "id", 0) == id && !rpc_tasks[i].completed) {
            if (rpc_tasks[i].cancel_requested) *rpc_tasks[i].cancel_requested = 1;
            found = true;
        }
    }
    rpc_unlock_tasks();
    char response[160];
    snprintf(response, sizeof(response), "{\"id\":%d,\"success\":true,\"action\":\"cancel\",\"cancelled\":%s}\n", id, found ? "true" : "false");
    rpc_write_response(response, lock);
}

static bool rpc_start_task(char *request, void *lock) {
    rpc_lock_tasks();
    int slot = -1;
    for (int i = 0; i < MAX_RPC_TASKS; ++i) if (!rpc_tasks[i].used) { slot = i; break; }
    if (slot < 0) { rpc_unlock_tasks(); return false; }
    RpcTask *task = &rpc_tasks[slot];
    memset(task, 0, sizeof(*task));
    task->output_lock = lock;
    task->request = request;
    task->cancel_requested = (volatile long *)calloc(1, sizeof(long));
    if (!task->cancel_requested) { rpc_unlock_tasks(); return false; }
    task->used = true;
#ifdef _WIN32
    task->thread = (HANDLE)_beginthreadex(NULL, 0, rpc_task_main, task, 0, NULL);
    if (!task->thread) {
        free((void *)task->cancel_requested);
        task->cancel_requested = NULL;
        task->used = false;
        rpc_unlock_tasks();
        return false;
    }
#else
    if (pthread_create(&task->thread, NULL, rpc_task_main, task) != 0) {
        free((void *)task->cancel_requested);
        task->cancel_requested = NULL;
        task->used = false;
        rpc_unlock_tasks();
        return false;
    }
#endif
    rpc_unlock_tasks();
    return true;
}

static void rpc_shutdown_tasks(void) {
    /* EOF only closes the request stream. Accepted work must finish and return
     * its result; explicit cancel or process teardown is a separate signal. */
    for (int i = 0; i < MAX_RPC_TASKS; ++i) {
        RpcTask *task = &rpc_tasks[i];
        if (!task->used) continue;
#ifdef _WIN32
        WaitForSingleObject(task->thread, INFINITE);
        CloseHandle(task->thread);
#else
        pthread_join(task->thread, NULL);
#endif
        free(task->request);
        free((void *)task->cancel_requested);
        task->cancel_requested = NULL;
        task->used = false;
    }
}

static bool esc_buf_append(char **buf, size_t *len, size_t *cap, const char *str, size_t slen) {
    if (*len + slen + 2 >= *cap) {
        size_t next = (*cap + slen + 64) * 2;
        char *grown = (char *)realloc(*buf, next);
        if (!grown) return false;
        *buf = grown;
        *cap = next;
    }
    memcpy(*buf + *len, str, slen);
    *len += slen;
    (*buf)[*len] = '\0';
    return true;
}

static char *json_escape_to_str(const char *s) {
    size_t cap = s ? (strlen(s) + 32) : 16;
    size_t len = 0;
    char *buf = (char *)malloc(cap);
    if (!buf) return NULL;
    buf[len++] = '"';
    buf[len] = '\0';

    if (s) {
        const unsigned char *u = (const unsigned char *)s;
        size_t slen = strlen(s);
        size_t i = 0;
        while (i < slen) {
            unsigned char c = u[i];
            if (c == '"') {
                if (!esc_buf_append(&buf, &len, &cap, "\\\"", 2)) { free(buf); return NULL; }
                i++;
            } else if (c == '\\') {
                if (!esc_buf_append(&buf, &len, &cap, "\\\\", 2)) { free(buf); return NULL; }
                i++;
            } else if (c == '\n') {
                if (!esc_buf_append(&buf, &len, &cap, "\\n", 2)) { free(buf); return NULL; }
                i++;
            } else if (c == '\r') {
                if (!esc_buf_append(&buf, &len, &cap, "\\r", 2)) { free(buf); return NULL; }
                i++;
            } else if (c == '\t') {
                if (!esc_buf_append(&buf, &len, &cap, "\\t", 2)) { free(buf); return NULL; }
                i++;
            } else if (c < 0x20) {
                char uhex[7];
                snprintf(uhex, sizeof(uhex), "\\u%04x", c);
                if (!esc_buf_append(&buf, &len, &cap, uhex, 6)) { free(buf); return NULL; }
                i++;
            } else if (c < 0x80) {
                if (!esc_buf_append(&buf, &len, &cap, (const char *)&u[i], 1)) { free(buf); return NULL; }
                i++;
            } else if (c >= 0xC2 && c <= 0xDF && i + 1 < slen && (u[i + 1] & 0xC0) == 0x80) {
                if (!esc_buf_append(&buf, &len, &cap, (const char *)&u[i], 2)) { free(buf); return NULL; }
                i += 2;
            } else if (c >= 0xE0 && c <= 0xEF && i + 2 < slen &&
                       (u[i + 1] & 0xC0) == 0x80 && (u[i + 2] & 0xC0) == 0x80 &&
                       !(c == 0xE0 && u[i + 1] < 0xA0) && !(c == 0xED && u[i + 1] >= 0xA0)) {
                if (!esc_buf_append(&buf, &len, &cap, (const char *)&u[i], 3)) { free(buf); return NULL; }
                i += 3;
            } else if (c >= 0xF0 && c <= 0xF4 && i + 3 < slen &&
                       (u[i + 1] & 0xC0) == 0x80 && (u[i + 2] & 0xC0) == 0x80 && (u[i + 3] & 0xC0) == 0x80 &&
                       !(c == 0xF0 && u[i + 1] < 0x90) && !(c == 0xF4 && u[i + 1] >= 0x90)) {
                if (!esc_buf_append(&buf, &len, &cap, (const char *)&u[i], 4)) { free(buf); return NULL; }
                i += 4;
            } else {
                /* Invalid or incomplete UTF-8 byte: emit U+FFFD replacement so closing quote is never swallowed */
                if (!esc_buf_append(&buf, &len, &cap, "\\ufffd", 6)) { free(buf); return NULL; }
                i++;
            }
        }
    }
    if (!esc_buf_append(&buf, &len, &cap, "\"", 1)) { free(buf); return NULL; }
    return buf;
}

void json_write_escaped_string(FILE *f, const char *s) {
    char *esc = json_escape_to_str(s);
    if (esc) {
        fputs(esc, f);
        free(esc);
    } else {
        fputs("\"\"", f);
    }
}

/* Find key in JSON object and return pointer to start of value (string-aware parser) */
static const char *json_find_val(const char *json, const char *key) {
    if (!json || !key) return NULL;
    const size_t klen = strlen(key);
    int depth = 0;
    bool in_string = false;
    bool escape = false;
    for (const char *p = json; *p; ++p) {
        const char ch = *p;
        if (in_string) {
            if (escape) { escape = false; continue; }
            if (ch == '\\') { escape = true; continue; }
            if (ch == '"') in_string = false;
            continue;
        }
        if (ch == '"') {
            if (depth == 1 && strncmp(p + 1, key, klen) == 0 && p[klen + 1] == '"') {
                const char *after = p + klen + 2;
                while (*after && isspace((unsigned char)*after)) after++;
                if (*after == ':') {
                    after++;
                    while (*after && isspace((unsigned char)*after)) after++;
                    return after;
                }
            }
            in_string = true;
            escape = false;
            continue;
        }
        if (ch == '{' || ch == '[') depth++;
        else if (ch == '}' || ch == ']') depth--;
    }
    return NULL;
}

static bool json_append_utf8(char **buf, size_t *len, size_t *cap, unsigned int cp) {
    unsigned char bytes[4]; size_t n = 0;
    if (cp < 0x80) bytes[n++] = (unsigned char)cp;
    else if (cp < 0x800) { bytes[n++] = (unsigned char)(0xC0 | (cp >> 6)); bytes[n++] = (unsigned char)(0x80 | (cp & 0x3F)); }
    else if (cp < 0x10000) { bytes[n++] = (unsigned char)(0xE0 | (cp >> 12)); bytes[n++] = (unsigned char)(0x80 | ((cp >> 6) & 0x3F)); bytes[n++] = (unsigned char)(0x80 | (cp & 0x3F)); }
    else { bytes[n++] = (unsigned char)(0xF0 | (cp >> 18)); bytes[n++] = (unsigned char)(0x80 | ((cp >> 12) & 0x3F)); bytes[n++] = (unsigned char)(0x80 | ((cp >> 6) & 0x3F)); bytes[n++] = (unsigned char)(0x80 | (cp & 0x3F)); }
    if (*len + n + 1 >= *cap) {
        size_t next = (*cap + n + 1) * 2;
        char *grown = (char *)realloc(*buf, next);
        if (!grown) return false;
        *buf = grown; *cap = next;
    }
    for (size_t i = 0; i < n; ++i) (*buf)[(*len)++] = (char)bytes[i];
    return true;
}

static char *json_dup_string_val(const char *json, const char *key) {
    const char *p = json_find_val(json, key);
    if (!p || *p != '"') return NULL;
    p++; /* skip opening quote */

    size_t cap = 256;
    size_t len = 0;
    char *buf = (char *)malloc(cap);
    if (!buf) return NULL;

    while (*p && *p != '"') {
        char c = *p++;
        if (c == '\\' && *p) {
            char esc = *p++;
            if (esc == 'n') c = '\n';
            else if (esc == 'r') c = '\r';
            else if (esc == 't') c = '\t';
            else if (esc == 'b') c = '\b';
            else if (esc == 'f') c = '\f';
            else if (esc == '"') c = '"';
            else if (esc == '\\') c = '\\';
            else if (esc == '/') c = '/';
            else if (esc == 'u') {
                char hex[5] = {0};
                for (int h = 0; h < 4 && isxdigit((unsigned char)*p); h++) hex[h] = *p++;
                if (strlen(hex) != 4) { free(buf); return NULL; }
                unsigned int cp = (unsigned int)strtoul(hex, NULL, 16);
                if (cp >= 0xD800 && cp <= 0xDBFF && p[0] == '\\' && p[1] == 'u') {
                    char low_hex[5] = {0};
                    const char *low = p + 2;
                    for (int h = 0; h < 4 && isxdigit((unsigned char)low[h]); h++) low_hex[h] = low[h];
                    unsigned int low_cp = strlen(low_hex) == 4 ? (unsigned int)strtoul(low_hex, NULL, 16) : 0;
                    if (low_cp >= 0xDC00 && low_cp <= 0xDFFF) {
                        cp = 0x10000 + ((cp - 0xD800) << 10) + (low_cp - 0xDC00);
                        p += 6;
                    }
                }
                if (cp >= 0xD800 && cp <= 0xDFFF) { free(buf); return NULL; }
                if (!json_append_utf8(&buf, &len, &cap, cp)) { free(buf); return NULL; }
                continue;
            }
        }
        if (len + 2 >= cap) {
            cap *= 2;
            char *nb = (char *)realloc(buf, cap);
            if (!nb) { free(buf); return NULL; }
            buf = nb;
        }
        buf[len++] = c;
    }
    buf[len] = '\0';
    return buf;
}

static bool json_has_nonnull_key(const char *json, const char *key) {
    const char *p = json_find_val(json, key);
    if (!p) return false;
    if (strncmp(p, "null", 4) == 0 && (!p[4] || isspace((unsigned char)p[4]) || p[4] == ',' || p[4] == '}' || p[4] == ']')) {
        return false;
    }
    return true;
}

static int json_get_int_val(const char *json, const char *key, int default_val) {
    const char *p = json_find_val(json, key);
    if (!p || strncmp(p, "null", 4) == 0) return default_val;
    return atoi(p);
}

static bool json_get_bool_val(const char *json, const char *key, bool default_val) {
    const char *p = json_find_val(json, key);
    if (!p) return default_val;
    if (strncmp(p, "true", 4) == 0) return true;
    if (strncmp(p, "false", 5) == 0) return false;
    return default_val;
}

static AutonomyLevel parse_autonomy_level(const char *str) {
    if (!str) return AUTONOMY_BALANCED;
    if (strcmp(str, "strict") == 0) return AUTONOMY_STRICT;
    if (strcmp(str, "trusted") == 0) return AUTONOMY_TRUSTED;
    return AUTONOMY_BALANCED;
}

/* Stream buffer for chunk accumulation in RPC */
typedef struct {
    char *text;
    size_t text_len;
    size_t text_cap;
    char *reasoning;
    size_t reasoning_len;
    size_t reasoning_cap;
} StreamAccumulator;

static void on_accum_text(const char *content, size_t length, void *user_data) {
    StreamAccumulator *acc = (StreamAccumulator *)user_data;
    if (!acc) return;
    if (acc->text_len + length + 1 >= acc->text_cap) {
        size_t next_cap = (acc->text_cap + length + 256) * 2;
        char *grown = (char *)realloc(acc->text, next_cap);
        if (!grown) return;
        acc->text = grown;
        acc->text_cap = next_cap;
    }
    memcpy(acc->text + acc->text_len, content, length);
    acc->text_len += length;
    acc->text[acc->text_len] = '\0';
}

static void on_accum_reasoning(const char *content, size_t length, void *user_data) {
    StreamAccumulator *acc = (StreamAccumulator *)user_data;
    if (!acc) return;
    if (acc->reasoning_len + length + 1 >= acc->reasoning_cap) {
        size_t next_cap = (acc->reasoning_cap + length + 256) * 2;
        char *grown = (char *)realloc(acc->reasoning, next_cap);
        if (!grown) return;
        acc->reasoning = grown;
        acc->reasoning_cap = next_cap;
    }
    memcpy(acc->reasoning + acc->reasoning_len, content, length);
    acc->reasoning_len += length;
    acc->reasoning[acc->reasoning_len] = '\0';
}

/* Global StreamProcessor for persistent streaming session */
static StreamProcessor g_rpc_sp;
static bool g_rpc_sp_inited = false;
static StreamAccumulator g_rpc_acc = { NULL, 0, 0, NULL, 0, 0 };

static void ensure_rpc_stream_processor(void) {
    if (!g_rpc_sp_inited) {
        if (!g_rpc_acc.text) {
            g_rpc_acc.text_cap = 4096;
            g_rpc_acc.text = (char *)malloc(g_rpc_acc.text_cap);
            g_rpc_acc.text_len = 0;
            if (!g_rpc_acc.text) return;
            g_rpc_acc.text[0] = '\0';
        }
        if (!g_rpc_acc.reasoning) {
            g_rpc_acc.reasoning_cap = 4096;
            g_rpc_acc.reasoning = (char *)malloc(g_rpc_acc.reasoning_cap);
            g_rpc_acc.reasoning_len = 0;
            if (!g_rpc_acc.reasoning) return;
            g_rpc_acc.reasoning[0] = '\0';
        }
        stream_processor_init(&g_rpc_sp, on_accum_text, on_accum_reasoning, &g_rpc_acc);
        g_rpc_sp_inited = true;
    }
}

/* Parse history array of {"sig":"...","isError":bool} objects safely,
 * respecting JSON string escapes, embedded braces, and the closing ']' boundary. */
static void parse_stuck_history(LoopGuard *lg, const char *p) {
    if (!lg || !p) return;
    while (*p && isspace((unsigned char)*p)) p++;
    bool in_array = false;
    if (*p == '[') {
        in_array = true;
        p++;
    }
    while (*p) {
        while (*p && (isspace((unsigned char)*p) || *p == ',')) p++;
        if (!*p || (in_array && *p == ']')) break;
        while (*p && *p != '{' && !(in_array && *p == ']')) p++;
        if (!*p || (in_array && *p == ']')) break;
        const char *obj_start = p;
        const char *obj_end = NULL;
        int depth = 0;
        bool in_str = false;
        bool esc = false;
        for (const char *q = obj_start; *q; ++q) {
            char ch = *q;
            if (in_str) {
                if (esc) { esc = false; continue; }
                if (ch == '\\') { esc = true; continue; }
                if (ch == '"') in_str = false;
                continue;
            }
            if (ch == '"') {
                in_str = true;
                esc = false;
                continue;
            }
            if (ch == '{') depth++;
            else if (ch == '}') {
                depth--;
                if (depth == 0) {
                    obj_end = q;
                    break;
                }
            }
        }
        if (!obj_end) break;

        size_t olen = (size_t)(obj_end - obj_start + 1);
        char *obj_buf = (char *)malloc(olen + 1);
        if (!obj_buf) break;
        memcpy(obj_buf, obj_start, olen);
        obj_buf[olen] = '\0';

        char *sig = json_dup_string_val(obj_buf, "sig");
        bool is_err = json_get_bool_val(obj_buf, "isError", false);
        if (sig) {
            loop_guard_record(lg, sig, "", is_err);
            free(sig);
        }
        free(obj_buf);
        p = obj_end + 1;
    }
}

void handle_json_rpc_line(const char *line, FILE *out) {
    if (!line || !*line || !out) return;

    int id = json_get_int_val(line, "id", 0);
    char *action = json_dup_string_val(line, "action");
    if (!action) {
        fprintf(out, "{\"id\":%d,\"success\":false,\"error\":\"Missing action\"}\n", id);
        return;
    }

    if (strcmp(action, "ping") == 0) {
        fprintf(out, "{\"id\":%d,\"success\":true,\"engine\":\"c-core\",\"version\":\"0.9.9\"}\n", id);
        free(action);
        return;
    }

    if (strcmp(action, "audit_hard_lines") == 0 || strcmp(action, "audit") == 0) {
        char *cmd = json_dup_string_val(line, "command");
        char *ws = json_dup_string_val(line, "workspace");
        char *user_data_dir = json_dup_string_val(line, "user_data_dir");
        if (user_data_dir && *user_data_dir) safety_set_user_data_dir(user_data_dir);
        const char *c = cmd ? cmd : "";
        SafetyVerdict v = audit_hard_lines(c);
        bool is_hit = (v.tier == SAFETY_TIER_HARD || v.tier == SAFETY_TIER_BLOCKED);
        bool guard_safe = is_command_safe_for_auto_approval(c, (ws && *ws) ? ws : ".");

        fprintf(out, "{\"id\":%d,\"success\":true,\"action\":\"audit\",\"command\":", id);
        json_write_escaped_string(out, c);
        fprintf(out, ",\"hit\":%s,\"tier\":", is_hit ? "true" : "false");
        json_write_escaped_string(out, safety_tier_to_string(v.tier));
        fprintf(out, ",\"category\":");
        json_write_escaped_string(out, safety_category_to_string(v.category));
        fprintf(out, ",\"reason\":");
        json_write_escaped_string(out, v.reason);
        fprintf(out, ",\"autoApprovable\":%s,\"guardSafe\":%s}\n",
                v.auto_approvable ? "true" : "false",
                guard_safe ? "true" : "false");
        if (cmd) free(cmd);
        if (ws) free(ws);
        if (user_data_dir) free(user_data_dir);
        free(action);
        return;
    }

    if (strcmp(action, "classify_tool_call") == 0 || strcmp(action, "classify_tool") == 0) {
        char *tool = json_dup_string_val(line, "tool");
        char *path = json_dup_string_val(line, "path");
        char *cmd = json_dup_string_val(line, "command");
        char *autonomy = json_dup_string_val(line, "autonomy");
        char *workspace = json_dup_string_val(line, "workspace");
        char *user_data_dir = json_dup_string_val(line, "user_data_dir");

        SafetyContext ctx;
        memset(&ctx, 0, sizeof(ctx));
        if (workspace) strncpy(ctx.working_directory, workspace, sizeof(ctx.working_directory) - 1);
        if (user_data_dir && *user_data_dir) {
            strncpy(ctx.user_data_dir, user_data_dir, sizeof(ctx.user_data_dir) - 1);
            safety_set_user_data_dir(user_data_dir);
        }
        ctx.autonomy = parse_autonomy_level(autonomy);

        SafetyVerdict v = audit_tool_call(tool ? tool : "", path, cmd, &ctx);

        fprintf(out, "{\"id\":%d,\"success\":true,\"action\":\"classify_tool\",\"tool\":", id);
        json_write_escaped_string(out, tool ? tool : "");
        fprintf(out, ",\"tier\":");
        json_write_escaped_string(out, safety_tier_to_string(v.tier));
        fprintf(out, ",\"category\":");
        json_write_escaped_string(out, safety_category_to_string(v.category));
        fprintf(out, ",\"reason\":");
        json_write_escaped_string(out, v.reason);
        fprintf(out, ",\"autoApprovable\":%s}\n", v.auto_approvable ? "true" : "false");

        if (tool) free(tool);
        if (path) free(path);
        if (cmd) free(cmd);
        if (autonomy) free(autonomy);
        if (workspace) free(workspace);
        if (user_data_dir) free(user_data_dir);
        free(action);
        return;
    }

    if (strcmp(action, "is_command_safe") == 0 || strcmp(action, "is_safe") == 0) {
        char *cmd = json_dup_string_val(line, "command");
        char *ws = json_dup_string_val(line, "workspace");
        char *user_data_dir = json_dup_string_val(line, "user_data_dir");
        if (user_data_dir && *user_data_dir) safety_set_user_data_dir(user_data_dir);
        bool safe = is_command_safe_for_auto_approval(cmd ? cmd : "", ws ? ws : ".");

        fprintf(out, "{\"id\":%d,\"success\":true,\"action\":\"is_safe\",\"safe\":%s}\n",
                id, safe ? "true" : "false");
        if (cmd) free(cmd);
        if (ws) free(ws);
        if (user_data_dir) free(user_data_dir);
        free(action);
        return;
    }

    if (strcmp(action, "inject_check") == 0) {
        char *text = json_dup_string_val(line, "text");
        InjectionFinding f = scan_injection_rules(text ? text : "");

        fprintf(out, "{\"id\":%d,\"success\":true,\"action\":\"inject_check\",\"level\":", id);
        json_write_escaped_string(out, injection_level_to_string(f.level));
        fprintf(out, ",\"reason\":");
        json_write_escaped_string(out, f.reason);
        fprintf(out, ",\"via\":\"rule\"}\n");

        if (text) free(text);
        free(action);
        return;
    }

    if (strcmp(action, "detect_stuck") == 0) {
        int limit = json_get_int_val(line, "limit", 3);
        LoopGuard *lg = (LoopGuard *)calloc(1, sizeof(LoopGuard));
        if (!lg) {
            fprintf(out, "{\"id\":%d,\"success\":false,\"error\":\"Out of memory\"}\n", id);
            free(action);
            return;
        }
        loop_guard_init(lg, limit);

        const char *hist_val = json_find_val(line, "history");
        if (hist_val) {
            parse_stuck_history(lg, hist_val);
        }

        const char *reason = loop_guard_check_stuck(lg);
        fprintf(out, "{\"id\":%d,\"success\":true,\"action\":\"detect_stuck\",\"stuck\":%s,\"reason\":",
                id, (reason != NULL) ? "true" : "false");
        json_write_escaped_string(out, reason ? reason : "");
        fprintf(out, "}\n");
        free(lg);
        free(action);
        return;
    }

    if (strcmp(action, "stream_chunk") == 0) {
        ensure_rpc_stream_processor();
        char *chunk = json_dup_string_val(line, "chunk");
        bool flush = json_get_bool_val(line, "flush", false);
        bool reset = json_get_bool_val(line, "reset", false);

        if (reset) {
            stream_processor_reset(&g_rpc_sp);
        }

        /* Clear accumulator buffers */
        g_rpc_acc.text_len = 0;
        if (g_rpc_acc.text) g_rpc_acc.text[0] = '\0';
        g_rpc_acc.reasoning_len = 0;
        if (g_rpc_acc.reasoning) g_rpc_acc.reasoning[0] = '\0';

        if (chunk && *chunk) {
            stream_processor_feed(&g_rpc_sp, chunk, strlen(chunk));
        }
        if (flush) {
            stream_processor_flush(&g_rpc_sp);
        }

        fprintf(out, "{\"id\":%d,\"success\":true,\"action\":\"stream_chunk\",\"text\":", id);
        json_write_escaped_string(out, g_rpc_acc.text ? g_rpc_acc.text : "");
        fprintf(out, ",\"reasoning\":");
        json_write_escaped_string(out, g_rpc_acc.reasoning ? g_rpc_acc.reasoning : "");
        fprintf(out, "}\n");

        if (chunk) free(chunk);
        free(action);
        return;
    }

    if (strcmp(action, "run_tool") == 0) {
        char *tool = json_dup_string_val(line, "tool");
        char *path = json_dup_string_val(line, "path");
        char *content = json_dup_string_val(line, "content");
        char *target = json_dup_string_val(line, "target");
        char *replacement = json_dup_string_val(line, "replacement");
        char *cmd = json_dup_string_val(line, "command");
        char *ws = json_dup_string_val(line, "workspace");
        char *autonomy = json_dup_string_val(line, "autonomy");
        char *user_data_dir = json_dup_string_val(line, "user_data_dir");
        bool has_start_line = json_has_nonnull_key(line, "start_line") || json_has_nonnull_key(line, "startLine");
        bool has_end_line = json_has_nonnull_key(line, "end_line") || json_has_nonnull_key(line, "endLine");
        bool has_line_range = has_start_line || has_end_line;
        int start_line = json_has_nonnull_key(line, "start_line") ? json_get_int_val(line, "start_line", 0) : json_get_int_val(line, "startLine", 0);
        int end_line = json_has_nonnull_key(line, "end_line") ? json_get_int_val(line, "end_line", 0) : json_get_int_val(line, "endLine", 0);
        int max_depth = json_get_int_val(line, "max_depth", 2);
        int offset_bytes = json_has_nonnull_key(line, "offset_bytes") ? json_get_int_val(line, "offset_bytes", 0) : json_get_int_val(line, "offsetBytes", 0);
        int max_bytes = json_has_nonnull_key(line, "max_bytes") ? json_get_int_val(line, "max_bytes", 262144) : json_get_int_val(line, "maxBytes", 262144);
        int timeout_ms = json_get_int_val(line, "timeout_ms", 60000);
        int max_results = json_get_int_val(line, "max_results", 50);
        char *filename = json_dup_string_val(line, "filename");
        bool has_byte_window = json_has_nonnull_key(line, "offset_bytes") || json_has_nonnull_key(line, "offsetBytes") ||
                               json_has_nonnull_key(line, "max_bytes") || json_has_nonnull_key(line, "maxBytes");
        bool overwrite = json_get_bool_val(line, "overwrite", true);
        bool approved = json_get_bool_val(line, "approved", false);

        /* 主线程串行区：保留一次性同步（run_rpc_loop 已整体加锁，无并发写） */
        if (user_data_dir && *user_data_dir) safety_set_user_data_dir(user_data_dir);
        const char *workspace = (ws && *ws) ? ws : ".";
        ToolResult res;
        memset(&res, 0, sizeof(res));

        if (!tool) {
            res.success = false;
            snprintf(res.error_message, sizeof(res.error_message), "Missing tool name.");
        } else if (strcmp(tool, "read_file") == 0) {
            if (has_line_range && has_byte_window) {
                res.success = false;
                snprintf(res.error_message, sizeof(res.error_message), "startLine/endLine 不能与 offsetBytes/maxBytes 同时使用，请选择按行或按字节其中一种方式。");
            } else if (has_line_range && ((has_start_line && start_line < 1) || (has_end_line && end_line < 1))) {
                res.success = false;
                snprintf(res.error_message, sizeof(res.error_message), "Invalid line range: startLine and endLine must be positive integers (>= 1).");
            } else if (has_byte_window) {
                res = tool_read_file_window(path ? path : "", offset_bytes, max_bytes, workspace);
            } else {
                int eff_start = has_start_line ? start_line : (has_end_line ? 1 : 0);
                int eff_end = has_end_line ? end_line : (has_start_line ? -1 : 0);
                res = tool_read_file(path ? path : "", eff_start, eff_end, workspace);
            }
        } else if (strcmp(tool, "write_file") == 0) {
            res = tool_write_file(path ? path : "", content ? content : "", overwrite, workspace);
        } else if (strcmp(tool, "patch_file") == 0) {
            res = tool_patch_file(path ? path : "", target ? target : "", replacement ? replacement : "", workspace);
        } else if (strcmp(tool, "list_directory") == 0) {
            res = tool_list_directory(path ? path : ".", max_depth, workspace);
        } else if (strcmp(tool, "search_files") == 0) {
            res = tool_search_files_ex(path ? path : ".", filename ? filename : "", content ? content : (target ? target : ""), max_results, workspace);
        } else if (strcmp(tool, "run_command") == 0) {
            SafetyContext sctx;
            memset(&sctx, 0, sizeof(sctx));
            strncpy(sctx.working_directory, workspace, sizeof(sctx.working_directory) - 1);
            if (user_data_dir && *user_data_dir) strncpy(sctx.user_data_dir, user_data_dir, sizeof(sctx.user_data_dir) - 1);
            sctx.autonomy = parse_autonomy_level(autonomy);
            sctx.approved = approved;
            res = tool_run_command_ex(cmd ? cmd : (path ? path : ""), workspace, &sctx, timeout_ms);
        } else {
            res.success = false;
            snprintf(res.error_message, sizeof(res.error_message), "Unknown tool: %s", tool);
        }

        fprintf(out, "{\"id\":%d,\"success\":true,\"action\":\"run_tool\",\"tool\":", id);
        json_write_escaped_string(out, tool ? tool : "");
        fprintf(out, ",\"toolSuccess\":%s,\"output\":", res.success ? "true" : "false");
        json_write_escaped_string(out, res.output ? res.output : "");
        fprintf(out, ",\"error\":");
        json_write_escaped_string(out, res.error_message);
        fprintf(out, "}\n");

        tool_result_free(&res);
        if (tool) free(tool);
        if (path) free(path);
        if (content) free(content);
        if (target) free(target);
        if (replacement) free(replacement);
        if (filename) free(filename);
        if (cmd) free(cmd);
        if (ws) free(ws);
        if (autonomy) free(autonomy);
        if (user_data_dir) free(user_data_dir);
        free(action);
        return;
    }

    char err_buf[512];
    snprintf(err_buf, sizeof(err_buf), "Unknown action: %s", action);
    fprintf(out, "{\"id\":%d,\"success\":false,\"error\":", id);
    json_write_escaped_string(out, err_buf);
    fprintf(out, "}\n");
    free(action);
}

void handle_json_audit_cmd(const char *command) {
    const char *cmd = command ? command : "";
    SafetyVerdict v = audit_hard_lines(cmd);
    bool is_hit = (v.tier == SAFETY_TIER_HARD || v.tier == SAFETY_TIER_BLOCKED);
    bool guard_safe = is_command_safe_for_auto_approval(cmd, ".");

    printf("{\"success\":true,\"action\":\"audit\",\"command\":");
    json_write_escaped_string(stdout, cmd);
    printf(",\"hit\":%s,\"tier\":", is_hit ? "true" : "false");
    json_write_escaped_string(stdout, safety_tier_to_string(v.tier));
    printf(",\"category\":");
    json_write_escaped_string(stdout, safety_category_to_string(v.category));
    printf(",\"reason\":");
    json_write_escaped_string(stdout, v.reason);
    printf(",\"autoApprovable\":%s,\"guardSafe\":%s}\n",
           v.auto_approvable ? "true" : "false",
           guard_safe ? "true" : "false");
}

void handle_json_inject_check_cmd(const char *text) {
    const char *t = text ? text : "";
    InjectionFinding f = scan_injection_rules(t);

    printf("{\"success\":true,\"action\":\"inject_check\",\"text\":");
    json_write_escaped_string(stdout, t);
    printf(",\"level\":");
    json_write_escaped_string(stdout, injection_level_to_string(f.level));
    printf(",\"reason\":");
    json_write_escaped_string(stdout, f.reason);
    printf(",\"via\":\"rule\"}\n");
}

void handle_json_is_safe_cmd(const char *command, const char *workspace) {
    const char *cmd = command ? command : "";
    const char *ws = workspace ? workspace : ".";
    bool safe = is_command_safe_for_auto_approval(cmd, ws);
    printf("{\"success\":true,\"action\":\"is_safe\",\"command\":");
    json_write_escaped_string(stdout, cmd);
    printf(",\"safe\":%s}\n", safe ? "true" : "false");
}

void handle_json_classify_tool_cmd(const char *tool, const char *path, const char *cmd, const char *autonomy, const char *workspace) {
    SafetyContext ctx;
    memset(&ctx, 0, sizeof(ctx));
    if (workspace && *workspace) strncpy(ctx.working_directory, workspace, sizeof(ctx.working_directory) - 1);
    ctx.autonomy = parse_autonomy_level(autonomy);

    SafetyVerdict v = audit_tool_call(tool ? tool : "", path, cmd, &ctx);

    printf("{\"success\":true,\"action\":\"classify_tool\",\"tool\":");
    json_write_escaped_string(stdout, tool ? tool : "");
    printf(",\"tier\":");
    json_write_escaped_string(stdout, safety_tier_to_string(v.tier));
    printf(",\"category\":");
    json_write_escaped_string(stdout, safety_category_to_string(v.category));
    printf(",\"reason\":");
    json_write_escaped_string(stdout, v.reason);
    printf(",\"autoApprovable\":%s}\n", v.auto_approvable ? "true" : "false");
}

void handle_json_run_tool_cmd(const char *tool, const char *arg1, const char *arg2, const char *arg3, const char *workspace) {
    const char *ws = (workspace && *workspace) ? workspace : ".";
    ToolResult res;
    memset(&res, 0, sizeof(res));

    if (!tool) {
        res.success = false;
        snprintf(res.error_message, sizeof(res.error_message), "Missing tool name.");
    } else if (strcmp(tool, "read_file") == 0) {
        int start = (arg2 && *arg2) ? atoi(arg2) : 0;
        int end = (arg3 && *arg3) ? atoi(arg3) : (start > 0 ? -1 : 0);
        res = tool_read_file(arg1 ? arg1 : "", start, end, ws);
    } else if (strcmp(tool, "write_file") == 0) {
        bool overwrite = (!arg3 || strcmp(arg3, "false") != 0);
        res = tool_write_file(arg1 ? arg1 : "", arg2 ? arg2 : "", overwrite, ws);
    } else if (strcmp(tool, "patch_file") == 0) {
        res = tool_patch_file(arg1 ? arg1 : "", arg2 ? arg2 : "", arg3 ? arg3 : "", ws);
    } else if (strcmp(tool, "list_directory") == 0) {
        int depth = arg2 ? atoi(arg2) : 2;
        res = tool_list_directory(arg1 ? arg1 : ".", depth, ws);
    } else if (strcmp(tool, "search_files") == 0) {
        res = tool_search_files(arg1 ? arg1 : ".", arg2 ? arg2 : "", ws);
    } else if (strcmp(tool, "run_command") == 0) {
        SafetyContext sctx;
        memset(&sctx, 0, sizeof(sctx));
        strncpy(sctx.working_directory, ws, sizeof(sctx.working_directory) - 1);
        sctx.autonomy = AUTONOMY_BALANCED;
        res = tool_run_command(arg1 ? arg1 : "", ws, &sctx);
    } else {
        res.success = false;
        snprintf(res.error_message, sizeof(res.error_message), "Unknown tool: %s", tool);
    }

    printf("{\"success\":%s,\"action\":\"run_tool\",\"tool\":", res.success ? "true" : "false");
    json_write_escaped_string(stdout, tool ? tool : "");
    printf(",\"output\":");
    json_write_escaped_string(stdout, res.output ? res.output : "");
    printf(",\"error\":");
    json_write_escaped_string(stdout, res.error_message);
    printf("}\n");

    tool_result_free(&res);
}

void handle_json_detect_stuck_cmd(int limit, const char *history_json) {
    LoopGuard *lg = (LoopGuard *)calloc(1, sizeof(LoopGuard));
    if (!lg) {
        printf("{\"success\":false,\"action\":\"detect_stuck\",\"error\":\"Out of memory\"}\n");
        return;
    }
    loop_guard_init(lg, limit > 0 ? limit : 3);
    if (history_json && *history_json) {
        parse_stuck_history(lg, history_json);
    }
    const char *reason = loop_guard_check_stuck(lg);
    printf("{\"success\":true,\"action\":\"detect_stuck\",\"stuck\":%s,\"reason\":",
           (reason != NULL) ? "true" : "false");
    json_write_escaped_string(stdout, reason ? reason : "");
    printf("}\n");
    free(lg);
}

void handle_json_ping_cmd(void) {
    printf("{\"success\":true,\"engine\":\"c-core\",\"version\":\"0.9.9\"}\n");
}

static char *read_line_dynamic(FILE *f) {
    size_t cap = 4096;
    size_t len = 0;
    char *buf = (char *)malloc(cap);
    if (!buf) return NULL;
    int c;
    while ((c = fgetc(f)) != EOF) {
        if (c == '\n') break;
        if (c == '\r') continue;
        if (len + 2 >= cap) {
            cap *= 2;
            char *nb = (char *)realloc(buf, cap);
            if (!nb) { free(buf); return NULL; }
            buf = nb;
        }
        buf[len++] = (char)c;
    }
    if (len == 0 && c == EOF) {
        free(buf);
        return NULL;
    }
    buf[len] = '\0';
    return buf;
}

void run_rpc_loop(void) {
#ifdef _WIN32
    CRITICAL_SECTION output_lock;
    InitializeCriticalSection(&output_lock);
    InitializeCriticalSection(&rpc_task_lock);
    void *lock = &output_lock;
#else
    pthread_mutex_t output_lock = PTHREAD_MUTEX_INITIALIZER;
    void *lock = &output_lock;
#endif
    rpc_init_tasks(lock);
    while (1) {
        rpc_reap_tasks();
        char *line = read_line_dynamic(stdin);
        if (!line) break;
        size_t l = strlen(line);
        while (l > 0 && (line[l - 1] == ' ' || line[l - 1] == '\t')) line[--l] = '\0';
        if (l == 0) { free(line); continue; }
        if (strcmp(line, "exit") == 0 || strcmp(line, "quit") == 0) { free(line); break; }
        char *action = json_dup_string_val(line, "action");
        if (action && (strcmp(action, "run_tool") == 0 || strcmp(action, "cancel") == 0)) {
            if (strcmp(action, "cancel") == 0) {
                rpc_cancel_task(json_find_val(line, "cancel_id") ? json_get_int_val(line, "cancel_id", 0) : json_get_int_val(line, "id", 0), lock);
                free(action); free(line); continue;
            }
            char *tool = json_dup_string_val(line, "tool");
            bool async_command = tool && strcmp(tool, "run_command") == 0;
            free(tool);
            if (async_command) {
                if (!rpc_start_task(line, lock)) {
                    int id = json_get_int_val(line, "id", 0);
                    char response[192];
                    snprintf(response, sizeof(response), "{\"id\":%d,\"success\":false,\"error\":\"C-Core command queue is full\"}\n", id);
                    rpc_write_response(response, lock);
                    free(line);
                }
                free(action); continue;
            }
        }
        free(action);
        rpc_output_lock(lock);
        handle_json_rpc_line(line, stdout);
        fflush(stdout);
        rpc_output_unlock(lock);
        free(line);
    }
    rpc_shutdown_tasks();
#ifdef _WIN32
    DeleteCriticalSection(&output_lock);
    DeleteCriticalSection(&rpc_task_lock);
#else
    pthread_mutex_destroy(&output_lock);
#endif
}
