#ifndef SHANGBO_NATIVE_PROCESS_H
#define SHANGBO_NATIVE_PROCESS_H

#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    bool started;
    bool timed_out;
    unsigned long exit_code;
    char *output;
    size_t output_len;
    char error[512];
} NativeProcessResult;

/* Runs one non-interactive command in an explicit Unicode working directory.
 * Windows uses a Job Object so timeout/bridge teardown terminates the process tree.
 */
NativeProcessResult native_run_process(const char *command, const char *working_directory, int timeout_ms);
NativeProcessResult native_run_process_cancellable(const char *command, const char *working_directory, int timeout_ms, volatile long *cancel_requested);
void native_process_result_free(NativeProcessResult *result);

#ifdef __cplusplus
}
#endif
#endif
