#ifndef SANGBO_AGENT_LOOP_GUARD_H
#define SANGBO_AGENT_LOOP_GUARD_H

#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

#define LOOP_GUARD_HISTORY_CAPACITY 64
#define LOOP_GUARD_SIGNATURE_MAX 256

typedef struct {
    char signature[LOOP_GUARD_SIGNATURE_MAX];
    bool is_error;
} ToolCallRecord;

typedef struct {
    ToolCallRecord history[LOOP_GUARD_HISTORY_CAPACITY];
    int count;
    int limit;
} LoopGuard;

void loop_guard_init(LoopGuard *lg, int limit);
void loop_guard_record(LoopGuard *lg, const char *tool_name, const char *args_snippet, bool is_error);
/* Returns human-readable failure reason if stuck in loop; NULL if healthy */
const char *loop_guard_check_stuck(const LoopGuard *lg);

#ifdef __cplusplus
}
#endif

#endif /* SANGBO_AGENT_LOOP_GUARD_H */
