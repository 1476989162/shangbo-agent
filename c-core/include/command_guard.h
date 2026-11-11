#ifndef SANGBO_AGENT_COMMAND_GUARD_H
#define SANGBO_AGENT_COMMAND_GUARD_H

#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

#define MAX_COMMAND_SEGMENTS 32
#define MAX_SEGMENT_LEN 1024

typedef struct {
    char segments[MAX_COMMAND_SEGMENTS][MAX_SEGMENT_LEN];
    int count;
    bool has_syntax_error;
    char error_reason[256];
} CommandSegments;

/* Splits composite commands by &&, ||, |, & while rejecting ';' (cmd.exe restriction) */
CommandSegments split_command_segments(const char *raw_command);

/* Checks if command verb is in allowed whitelist for auto-approval */
bool is_verb_allowed(const char *verb);

/* Checks if git sub-command is in whitelist (status, diff, log, add, commit, etc.) */
bool is_git_subcommand_allowed(const char *subcommand);

/* Detects dangerous escape patterns: .. escape, encoded commands, iex, download-and-run */
bool has_dangerous_pattern(const char *command);

/* Extracts payload from nested interpreters: powershell -c, cmd /c, bash -c, node -e, python -c */
bool unpack_nested_interpreter(const char *command, char *out_payload, size_t out_payload_size);

/* Classifies whether command stays strictly inside workspace and is safe for auto-approval */
bool is_command_safe_for_auto_approval(const char *command, const char *workspace);

#ifdef __cplusplus
}
#endif

#endif /* SANGBO_AGENT_COMMAND_GUARD_H */
