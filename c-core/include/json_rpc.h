#ifndef SANGBO_AGENT_JSON_RPC_H
#define SANGBO_AGENT_JSON_RPC_H

#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Escape text into JSON string literal format (including enclosing quotes) */
void json_write_escaped_string(FILE *f, const char *s);

/* Process a single JSON-RPC request line and write response to stream */
void handle_json_rpc_line(const char *line, FILE *out);

/* CLI --json execution helpers */
void handle_json_audit_cmd(const char *command);
void handle_json_inject_check_cmd(const char *text);
void handle_json_is_safe_cmd(const char *command, const char *workspace);
void handle_json_classify_tool_cmd(const char *tool, const char *path, const char *cmd, const char *autonomy, const char *workspace);
void handle_json_run_tool_cmd(const char *tool, const char *arg1, const char *arg2, const char *arg3, const char *workspace);
void handle_json_detect_stuck_cmd(int limit, const char *history_json);
void handle_json_ping_cmd(void);

/* Persistent RPC loop reading stdin and writing responses to stdout */
void run_rpc_loop(void);

#ifdef __cplusplus
}
#endif

#endif /* SANGBO_AGENT_JSON_RPC_H */
