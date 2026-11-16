#ifndef SANGBO_AGENT_TOOLS_H
#define SANGBO_AGENT_TOOLS_H

#include "safety.h"
#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    bool success;
    char *output;
    size_t output_len;
    char error_message[1024];
} ToolResult;

void tool_result_free(ToolResult *res);

ToolResult tool_read_file(const char *path, int start_line, int end_line, const char *workspace);
ToolResult tool_read_file_window(const char *path, int offset_bytes, int max_bytes, const char *workspace);
ToolResult tool_write_file(const char *path, const char *content, bool overwrite, const char *workspace);
ToolResult tool_patch_file(const char *path, const char *target, const char *replacement, const char *workspace);
ToolResult tool_list_directory(const char *path, int max_depth, const char *workspace);
ToolResult tool_search_files(const char *path, const char *query, const char *workspace);
ToolResult tool_search_files_ex(const char *path, const char *filename, const char *content, int max_results, const char *workspace);
ToolResult tool_run_command(const char *command, const char *working_directory, const SafetyContext *safety_ctx);
ToolResult tool_run_command_ex(const char *command, const char *working_directory, const SafetyContext *safety_ctx, int timeout_ms);
ToolResult tool_run_command_cancellable(const char *command, const char *working_directory, const SafetyContext *safety_ctx, int timeout_ms, volatile long *cancel_requested);

#ifdef __cplusplus
}
#endif

#endif /* SANGBO_AGENT_TOOLS_H */
