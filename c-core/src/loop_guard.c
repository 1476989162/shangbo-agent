#include "../include/loop_guard.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void trim_incomplete_utf8_lg(char *s) {
    if (!s) return;
    size_t len = strlen(s);
    if (len == 0) return;
    size_t k = len;
    while (k > 0 && len - k < 4 && ((unsigned char)s[k - 1] & 0xC0) == 0x80) {
        k--;
    }
    if (k > 0 && ((unsigned char)s[k - 1] & 0x80) != 0) {
        unsigned char lead = (unsigned char)s[k - 1];
        size_t needed = 0;
        if (lead >= 0xC2 && lead <= 0xDF) needed = 2;
        else if (lead >= 0xE0 && lead <= 0xEF) needed = 3;
        else if (lead >= 0xF0 && lead <= 0xF4) needed = 4;
        if (needed == 0 || (len - (k - 1)) < needed) {
            s[k - 1] = '\0';
        }
    }
}

void loop_guard_init(LoopGuard *lg, int limit) {
    if (!lg) return;
    memset(lg, 0, sizeof(LoopGuard));
    lg->limit = (limit > 0) ? (limit <= LOOP_GUARD_HISTORY_CAPACITY ? limit : LOOP_GUARD_HISTORY_CAPACITY) : 3;
}

void loop_guard_record(LoopGuard *lg, const char *tool_name, const char *args_snippet, bool is_error) {
    if (!lg) return;

    if (lg->count >= LOOP_GUARD_HISTORY_CAPACITY) {
        /* Shift older records */
        memmove(&lg->history[0], &lg->history[1], sizeof(ToolCallRecord) * (LOOP_GUARD_HISTORY_CAPACITY - 1));
        lg->count = LOOP_GUARD_HISTORY_CAPACITY - 1;
    }

    ToolCallRecord *rec = &lg->history[lg->count++];
    rec->is_error = is_error;

    if (tool_name && args_snippet && *args_snippet) {
        snprintf(rec->signature, sizeof(rec->signature), "%s:%s", tool_name, args_snippet);
    } else if (tool_name) {
        snprintf(rec->signature, sizeof(rec->signature), "%s", tool_name);
    } else {
        snprintf(rec->signature, sizeof(rec->signature), "unknown");
    }
    trim_incomplete_utf8_lg(rec->signature);
}

static bool is_polling_signature_lg(const char *sig) {
    /* 生图/视频异步任务的轮询（generation_result 同 id 反复查询）是正常等结果，不算打转。 */
    /* sig 形如 "tool:args"，只看冒号前的工具名是否以 generation_result 结尾（含 MCP 前缀）。 */
    if (!sig || !*sig) return false;
    const char *colon = strchr(sig, ':');
    size_t name_len = colon ? (size_t)(colon - sig) : strlen(sig);
    while (name_len > 0 && (sig[name_len - 1] == ' ' || sig[name_len - 1] == '\t')) name_len--;
    const char *suffix = "generation_result";
    size_t suffix_len = strlen(suffix);
    if (name_len < suffix_len) return false;
    const char *tail = sig + name_len - suffix_len;
    for (size_t i = 0; i < suffix_len; i++) {
        char a = tail[i];
        char b = suffix[i];
        if (a >= 'A' && a <= 'Z') a = (char)(a + ('a' - 'A'));
        if (a != b) return false;
    }
    return true;
}

const char *loop_guard_check_stuck(const LoopGuard *lg) {
    if (!lg || lg->limit <= 0 || lg->count < lg->limit) {
        return NULL;
    }

    int start = lg->count - lg->limit;
    
    /* 1. Check if all recent calls are errors */
    bool all_errors = true;
    for (int i = start; i < lg->count; ++i) {
        if (!lg->history[i].is_error) {
            all_errors = false;
            break;
        }
    }
    if (all_errors) {
        LoopGuard *mut_lg = (LoopGuard *)lg;
        snprintf(mut_lg->last_reason, sizeof(mut_lg->last_reason),
                 "工具已连续失败 %d 次（%s），先停下来请人看一眼，不要继续烧 Token。",
                 lg->limit, lg->history[lg->count - 1].signature);
        trim_incomplete_utf8_lg(mut_lg->last_reason);
        return mut_lg->last_reason;
    }

    /* 2. Check if all recent calls have the same signature */
    const char *first_sig = lg->history[start].signature;
    bool all_identical = true;
    for (int i = start + 1; i < lg->count; ++i) {
        if (strcmp(lg->history[i].signature, first_sig) != 0) {
            all_identical = false;
            break;
        }
    }
    if (all_identical) {
        /* 轮询豁免：generation_result 同 id 查 N 次是正常等图，不暂停；连续失败仍照常拦截。 */
        if (is_polling_signature_lg(first_sig)) {
            return NULL;
        }
        LoopGuard *mut_lg = (LoopGuard *)lg;
        snprintf(mut_lg->last_reason, sizeof(mut_lg->last_reason),
                 "同一个工具调用已重复 %d 次（%s），疑似原地打转，先停下来。",
                 lg->limit, first_sig);
        trim_incomplete_utf8_lg(mut_lg->last_reason);
        return mut_lg->last_reason;
    }

    return NULL;
}
