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
#endif

void json_write_escaped_string(FILE *f, const char *s) {
    fputc('"', f);
    if (s) {
        for (; *s; ++s) {
            unsigned char c = (unsigned char)*s;
            if (c == '"') fputs("\\\"", f);
            else if (c == '\\') fputs("\\\\", f);
            else if (c == '\n') fputs("\\n", f);
            else if (c == '\r') fputs("\\r", f);
            else if (c == '\t') fputs("\\t", f);
            else if (c < 32) fprintf(f, "\\u%04x", c);
            else fputc(c, f);
        }
    }
    fputc('"', f);
}

/* Find key in JSON object and return pointer to start of value (string-aware parser) */
static const char *json_find_val(const char *json, const char *key) {
    if (!json || !key) return NULL;
    size_t klen = strlen(key);
    const char *p = json;
    bool in_str = false;

    while (*p) {
        if (*p == '\\' && in_str && *(p + 1)) {
            p += 2;
            continue;
        }
        if (*p == '"') {
            if (!in_str) {
                const char *str_start = p + 1;
                if (strncmp(str_start, key, klen) == 0 && str_start[klen] == '"') {
                    const char *after = str_start + klen + 1;
                    while (*after && (*after == ' ' || *after == '\t' || *after == '\r' || *after == '\n')) after++;
                    if (*after == ':') {
                        after++;
                        while (*after && (*after == ' ' || *after == '\t' || *after == '\r' || *after == '\n')) after++;
                        return after;
                    }
                }
                in_str = true;
            } else {
                in_str = false;
            }
        }
        p++;
    }
    return NULL;
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
            else if (esc == '"') c = '"';
            else if (esc == '\\') c = '\\';
            else if (esc == '/') c = '/';
            else if (esc == 'u') {
                char hex[5] = {0};
                for (int h = 0; h < 4 && *p; h++) hex[h] = *p++;
                unsigned int cp = (unsigned int)strtoul(hex, NULL, 16);
                if (cp < 0x80) {
                    c = (char)cp;
                } else if (cp < 0x800) {
                    if (len + 3 >= cap) { cap *= 2; char *nb = (char *)realloc(buf, cap); if (!nb) { free(buf); return NULL; } buf = nb; }
                    buf[len++] = (char)(0xC0 | (cp >> 6));
                    buf[len++] = (char)(0x80 | (cp & 0x3F));
                    continue;
                } else {
                    if (len + 4 >= cap) { cap *= 2; char *nb = (char *)realloc(buf, cap); if (!nb) { free(buf); return NULL; } buf = nb; }
                    buf[len++] = (char)(0xE0 | (cp >> 12));
                    buf[len++] = (char)(0x80 | ((cp >> 6) & 0x3F));
                    buf[len++] = (char)(0x80 | (cp & 0x3F));
                    continue;
                }
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

static int json_get_int_val(const char *json, const char *key, int default_val) {
    const char *p = json_find_val(json, key);
    if (!p) return default_val;
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
        acc->text_cap = (acc->text_cap + length + 256) * 2;
        acc->text = (char *)realloc(acc->text, acc->text_cap);
    }
    memcpy(acc->text + acc->text_len, content, length);
    acc->text_len += length;
    acc->text[acc->text_len] = '\0';
}

static void on_accum_reasoning(const char *content, size_t length, void *user_data) {
    StreamAccumulator *acc = (StreamAccumulator *)user_data;
    if (!acc) return;
    if (acc->reasoning_len + length + 1 >= acc->reasoning_cap) {
        acc->reasoning_cap = (acc->reasoning_cap + length + 256) * 2;
        acc->reasoning = (char *)realloc(acc->reasoning, acc->reasoning_cap);
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
            g_rpc_acc.text[0] = '\0';
        }
        if (!g_rpc_acc.reasoning) {
            g_rpc_acc.reasoning_cap = 4096;
            g_rpc_acc.reasoning = (char *)malloc(g_rpc_acc.reasoning_cap);
            g_rpc_acc.reasoning_len = 0;
            g_rpc_acc.reasoning[0] = '\0';
        }
        stream_processor_init(&g_rpc_sp, on_accum_text, on_accum_reasoning, &g_rpc_acc);
        g_rpc_sp_inited = true;
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
        fprintf(out, "{\"id\":%d,\"success\":true,\"engine\":\"c-core\",\"version\":\"0.9.4\"}\n", id);
        free(action);
        return;
    }

    if (strcmp(action, "audit_hard_lines") == 0 || strcmp(action, "audit") == 0) {
        char *cmd = json_dup_string_val(line, "command");
        const char *c = cmd ? cmd : "";
        SafetyVerdict v = audit_hard_lines(c);
        bool is_hit = (v.tier == SAFETY_TIER_HARD || v.tier == SAFETY_TIER_BLOCKED);
        bool guard_safe = is_command_safe_for_auto_approval(c, ".");

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
        free(action);
        return;
    }

    if (strcmp(action, "classify_tool_call") == 0 || strcmp(action, "classify_tool") == 0) {
        char *tool = json_dup_string_val(line, "tool");
        char *path = json_dup_string_val(line, "path");
        char *cmd = json_dup_string_val(line, "command");
        char *autonomy = json_dup_string_val(line, "autonomy");
        char *workspace = json_dup_string_val(line, "workspace");

        SafetyContext ctx;
        memset(&ctx, 0, sizeof(ctx));
        if (workspace) strncpy(ctx.working_directory, workspace, sizeof(ctx.working_directory) - 1);
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
        free(action);
        return;
    }

    if (strcmp(action, "is_command_safe") == 0 || strcmp(action, "is_safe") == 0) {
        char *cmd = json_dup_string_val(line, "command");
        char *ws = json_dup_string_val(line, "workspace");
        bool safe = is_command_safe_for_auto_approval(cmd ? cmd : "", ws ? ws : ".");

        fprintf(out, "{\"id\":%d,\"success\":true,\"action\":\"is_safe\",\"safe\":%s}\n",
                id, safe ? "true" : "false");
        if (cmd) free(cmd);
        if (ws) free(ws);
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
        LoopGuard lg;
        loop_guard_init(&lg, limit);

        /* Parse history array if provided: e.g. [{"sig":"...","isError":true}] */
        const char *p = strstr(line, "\"history\"");
        if (p) {
            p = strchr(p, '[');
            if (p) {
                while (*p && *p != ']') {
                    const char *obj_start = strchr(p, '{');
                    if (!obj_start) break;
                    const char *obj_end = strchr(obj_start, '}');
                    if (!obj_end) break;

                    char obj_buf[1024];
                    size_t olen = (size_t)(obj_end - obj_start + 1);
                    if (olen >= sizeof(obj_buf)) olen = sizeof(obj_buf) - 1;
                    memcpy(obj_buf, obj_start, olen);
                    obj_buf[olen] = '\0';

                    char *sig = json_dup_string_val(obj_buf, "sig");
                    bool is_err = json_get_bool_val(obj_buf, "isError", false);
                    if (sig) {
                        loop_guard_record(&lg, sig, "", is_err);
                        free(sig);
                    }
                    p = obj_end + 1;
                }
            }
        }

        const char *reason = loop_guard_check_stuck(&lg);
        fprintf(out, "{\"id\":%d,\"success\":true,\"action\":\"detect_stuck\",\"stuck\":%s,\"reason\":",
                id, (reason != NULL) ? "true" : "false");
        json_write_escaped_string(out, reason ? reason : "");
        fprintf(out, "}\n");
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
        int start_line = json_get_int_val(line, "start_line", 1);
        int end_line = json_get_int_val(line, "end_line", -1);
        int max_depth = json_get_int_val(line, "max_depth", 2);
        bool overwrite = json_get_bool_val(line, "overwrite", true);

        const char *workspace = (ws && *ws) ? ws : ".";
        ToolResult res;
        memset(&res, 0, sizeof(res));

        if (!tool) {
            res.success = false;
            snprintf(res.error_message, sizeof(res.error_message), "Missing tool name.");
        } else if (strcmp(tool, "read_file") == 0) {
            res = tool_read_file(path ? path : "", start_line, end_line, workspace);
        } else if (strcmp(tool, "write_file") == 0) {
            res = tool_write_file(path ? path : "", content ? content : "", overwrite, workspace);
        } else if (strcmp(tool, "patch_file") == 0) {
            res = tool_patch_file(path ? path : "", target ? target : "", replacement ? replacement : "", workspace);
        } else if (strcmp(tool, "list_directory") == 0) {
            res = tool_list_directory(path ? path : ".", max_depth, workspace);
        } else if (strcmp(tool, "search_files") == 0) {
            res = tool_search_files(path ? path : ".", target ? target : (cmd ? cmd : ""), workspace);
        } else if (strcmp(tool, "run_command") == 0) {
            SafetyContext sctx;
            memset(&sctx, 0, sizeof(sctx));
            strncpy(sctx.working_directory, workspace, sizeof(sctx.working_directory) - 1);
            sctx.autonomy = AUTONOMY_BALANCED;
            res = tool_run_command(cmd ? cmd : (path ? path : ""), workspace, &sctx);
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
        if (cmd) free(cmd);
        if (ws) free(ws);
        free(action);
        return;
    }

    fprintf(out, "{\"id\":%d,\"success\":false,\"error\":\"Unknown action: %s\"}\n", id, action);
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
        int start = arg2 ? atoi(arg2) : 1;
        int end = arg3 ? atoi(arg3) : -1;
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
    LoopGuard lg;
    loop_guard_init(&lg, limit > 0 ? limit : 3);
    if (history_json && *history_json) {
        const char *p = history_json;
        while (*p) {
            const char *obj_start = strchr(p, '{');
            if (!obj_start) break;
            const char *obj_end = strchr(obj_start, '}');
            if (!obj_end) break;
            char obj_buf[1024];
            size_t olen = (size_t)(obj_end - obj_start + 1);
            if (olen >= sizeof(obj_buf)) olen = sizeof(obj_buf) - 1;
            memcpy(obj_buf, obj_start, olen);
            obj_buf[olen] = '\0';
            char *sig = json_dup_string_val(obj_buf, "sig");
            bool is_err = json_get_bool_val(obj_buf, "isError", false);
            if (sig) {
                loop_guard_record(&lg, sig, "", is_err);
                free(sig);
            }
            p = obj_end + 1;
        }
    }
    const char *reason = loop_guard_check_stuck(&lg);
    printf("{\"success\":true,\"action\":\"detect_stuck\",\"stuck\":%s,\"reason\":",
           (reason != NULL) ? "true" : "false");
    json_write_escaped_string(stdout, reason ? reason : "");
    printf("}\n");
}

void handle_json_ping_cmd(void) {
    printf("{\"success\":true,\"engine\":\"c-core\",\"version\":\"0.9.4\"}\n");
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
    while (1) {
        char *line = read_line_dynamic(stdin);
        if (!line) break;
        size_t l = strlen(line);
        while (l > 0 && (line[l - 1] == ' ' || line[l - 1] == '\t')) line[--l] = '\0';
        if (l == 0) {
            free(line);
            continue;
        }
        if (strcmp(line, "exit") == 0 || strcmp(line, "quit") == 0) {
            free(line);
            break;
        }

        handle_json_rpc_line(line, stdout);
        fflush(stdout);
        free(line);
    }
}
