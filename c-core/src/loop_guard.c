#include "../include/loop_guard.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void loop_guard_init(LoopGuard *lg, int limit) {
    if (!lg) return;
    memset(lg, 0, sizeof(LoopGuard));
    lg->limit = (limit > 0) ? limit : 3;
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
        static char err_msg[256];
        snprintf(err_msg, sizeof(err_msg),
                 "工具已连续失败 %d 次（%s），先停下来请人看一眼，不要继续烧 Token。",
                 lg->limit, lg->history[lg->count - 1].signature);
        return err_msg;
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
        static char loop_msg[256];
        snprintf(loop_msg, sizeof(loop_msg),
                 "同一个工具调用已重复 %d 次（%s），疑似原地打转，先停下来。",
                 lg->limit, first_sig);
        return loop_msg;
    }

    return NULL;
}
