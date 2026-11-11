#include "../include/command_guard.h"
#include "../include/safety.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>

static const char *ALLOWED_VERBS[] = {
    "npm", "npx", "pnpm", "yarn", "bun", "node", "tsc", "vitest",
    "git", "ssh", "python", "pip", "pytest", "dotnet", "cargo", "go",
    "mvn", "gradle", "make", "ls", "dir", "cat", "type", "more",
    "findstr", "where", "tree", "echo", "mkdir", "copy", "move", NULL
};

static const char *ALLOWED_GIT_SUBS[] = {
    "status", "diff", "log", "show", "branch", "remote", "rev-parse",
    "ls-files", "blame", "describe", "add", "commit", "stash", "checkout", NULL
};

static const char *strcasestr_cg(const char *haystack, const char *needle) {
    if (!haystack || !needle) return NULL;
    if (!*needle) return haystack;
    for (; *haystack; ++haystack) {
        if (tolower((unsigned char)*haystack) == tolower((unsigned char)*needle)) {
            const char *h = haystack;
            const char *n = needle;
            while (*h && *n && tolower((unsigned char)*h) == tolower((unsigned char)*n)) {
                ++h;
                ++n;
            }
            if (!*n) return haystack;
        }
    }
    return NULL;
}

static void trim_inplace(char *s) {
    if (!s) return;
    char *p = s;
    while (*p && isspace((unsigned char)*p)) p++;
    if (p != s) memmove(s, p, strlen(p) + 1);
    size_t len = strlen(s);
    while (len > 0 && isspace((unsigned char)s[len - 1])) {
        s[--len] = '\0';
    }
}

CommandSegments split_command_segments(const char *raw_command) {
    CommandSegments res;
    memset(&res, 0, sizeof(res));

    if (!raw_command || !*raw_command) return res;

    size_t len = strlen(raw_command);
    char buf[MAX_SEGMENT_LEN];
    size_t b_idx = 0;
    bool in_double_quote = false;
    bool in_single_quote = false;

    for (size_t i = 0; i < len; ++i) {
        char c = raw_command[i];

        if (c == '"' && !in_single_quote) {
            in_double_quote = !in_double_quote;
            if (b_idx + 1 < sizeof(buf)) buf[b_idx++] = c;
            continue;
        }
        if (c == '\'' && !in_double_quote) {
            in_single_quote = !in_single_quote;
            if (b_idx + 1 < sizeof(buf)) buf[b_idx++] = c;
            continue;
        }

        /* If unquoted ';' appears in Windows cmd command, only flag as syntax error if followed by non-whitespace commands */
        if (!in_double_quote && !in_single_quote && c == ';') {
            const char *rest = raw_command + i + 1;
            while (*rest && isspace((unsigned char)*rest)) rest++;
            if (*rest != '\0') {
                res.has_syntax_error = true;
                snprintf(res.error_reason, sizeof(res.error_reason), "cmd.exe 复合命令不支持分号 ';' 分隔符，请使用 && 或 & 连接。");
                return res;
            }
            continue; /* Trailing semicolon (e.g. terminating SQL statement) is allowed */
        }

        /* Check for delimiters && or || */
        if (!in_double_quote && !in_single_quote &&
            ((c == '&' && i + 1 < len && raw_command[i + 1] == '&') ||
             (c == '|' && i + 1 < len && raw_command[i + 1] == '|'))) {
            buf[b_idx] = '\0';
            trim_inplace(buf);
            if (buf[0] && res.count < MAX_COMMAND_SEGMENTS) {
                strncpy(res.segments[res.count++], buf, MAX_SEGMENT_LEN - 1);
            }
            b_idx = 0;
            i++; /* skip second operator char */
            continue;
        }

        /* Redirection check: 2>&1 or >&2 should not be treated as command separator */
        if (!in_double_quote && !in_single_quote && c == '&') {
            if (i > 0 && raw_command[i - 1] == '>') {
                if (b_idx + 1 < sizeof(buf)) buf[b_idx++] = c;
                continue;
            }
        }

        /* Check for single delimiter & or | */
        if (!in_double_quote && !in_single_quote && (c == '&' || c == '|')) {
            buf[b_idx] = '\0';
            trim_inplace(buf);
            if (buf[0] && res.count < MAX_COMMAND_SEGMENTS) {
                strncpy(res.segments[res.count++], buf, MAX_SEGMENT_LEN - 1);
            }
            b_idx = 0;
            continue;
        }

        if (b_idx + 1 < sizeof(buf)) {
            buf[b_idx++] = c;
        }
    }

    buf[b_idx] = '\0';
    trim_inplace(buf);
    if (buf[0] && res.count < MAX_COMMAND_SEGMENTS) {
        strncpy(res.segments[res.count++], buf, MAX_SEGMENT_LEN - 1);
    }

    return res;
}

bool is_verb_allowed(const char *verb) {
    if (!verb || !*verb) return false;
    char clean_verb[64];
    size_t i = 0;
    while (verb[i] && !isspace((unsigned char)verb[i]) && i + 1 < sizeof(clean_verb)) {
        clean_verb[i] = (char)tolower((unsigned char)verb[i]);
        i++;
    }
    clean_verb[i] = '\0';

    /* Strip Windows extensions .exe, .cmd, .bat */
    char *dot = strrchr(clean_verb, '.');
    if (dot && (strcmp(dot, ".exe") == 0 || strcmp(dot, ".cmd") == 0 || strcmp(dot, ".bat") == 0)) {
        *dot = '\0';
    }

    for (int idx = 0; ALLOWED_VERBS[idx]; ++idx) {
        if (strcmp(clean_verb, ALLOWED_VERBS[idx]) == 0) {
            return true;
        }
    }
    return false;
}

bool is_git_subcommand_allowed(const char *subcommand) {
    if (!subcommand || !*subcommand) return false;
    for (int i = 0; ALLOWED_GIT_SUBS[i]; ++i) {
        if (strcmp(subcommand, ALLOWED_GIT_SUBS[i]) == 0) {
            return true;
        }
    }
    return false;
}

bool has_dangerous_pattern(const char *command) {
    if (!command || !*command) return false;

    /* Detect escape sequences: ..\ or ../ */
    if (strstr(command, "..\\") || strstr(command, "../")) return true;

    /* Detect root relative escape */
    if (strstr(command, "\\Windows") || strstr(command, "\\users") || strstr(command, "/etc/")) return true;

    /* Detect dangerous flags and commands */
    if (strstr(command, "--force") || strstr(command, "-enc") || strstr(command, "iex ") ||
        strstr(command, "invoke-expression") || strstr(command, "iwr ") || strstr(command, "curl ") ||
        strstr(command, "wget ") || strstr(command, "scp ") || strstr(command, "mklink")) {
        return true;
    }

    return false;
}

bool unpack_nested_interpreter(const char *command, char *out_payload, size_t out_payload_size) {
    if (!command || !out_payload || out_payload_size == 0) return false;

    const char *p = NULL;
    if ((p = strcasestr_cg(command, "powershell -c")) != NULL ||
        (p = strcasestr_cg(command, "powershell -command")) != NULL ||
        (p = strcasestr_cg(command, "pwsh -c")) != NULL ||
        (p = strcasestr_cg(command, "pwsh -command")) != NULL ||
        (p = strcasestr_cg(command, "cmd /c")) != NULL ||
        (p = strcasestr_cg(command, "bash -c")) != NULL ||
        (p = strcasestr_cg(command, "node -e")) != NULL ||
        (p = strcasestr_cg(command, "node --eval")) != NULL ||
        (p = strcasestr_cg(command, "python -c")) != NULL) {
        
        /* Find start of payload quote */
        const char *quote = strchr(p, '"');
        if (!quote) quote = strchr(p, '\'');
        if (quote) {
            char q_char = *quote;
            const char *end_quote = strrchr(quote + 1, q_char);
            if (end_quote && end_quote > quote + 1) {
                size_t p_len = (size_t)(end_quote - (quote + 1));
                if (p_len >= out_payload_size) p_len = out_payload_size - 1;
                strncpy(out_payload, quote + 1, p_len);
                out_payload[p_len] = '\0';
                return true;
            }
        }
    }
    return false;
}

bool is_command_safe_for_auto_approval(const char *command, const char *workspace) {
    if (!command || !*command) return false;

    /* 1. Check hard redlines first */
    SafetyVerdict hard_check = audit_hard_lines(command);
    if (hard_check.tier != SAFETY_TIER_AUTO) {
        return false;
    }

    /* 2. Split compound commands and verify each segment */
    CommandSegments segs = split_command_segments(command);
    if (segs.has_syntax_error || segs.count == 0) {
        return false;
    }

    for (int i = 0; i < segs.count; ++i) {
        const char *seg = segs.segments[i];

        /* Check dangerous patterns */
        if (has_dangerous_pattern(seg)) {
            return false;
        }

        /* Check nested interpreter payloads recursively */
        char payload[1024];
        if (unpack_nested_interpreter(seg, payload, sizeof(payload))) {
            SafetyVerdict payload_check = audit_hard_lines(payload);
            if (payload_check.tier != SAFETY_TIER_AUTO) {
                return false;
            }
            if (has_dangerous_pattern(payload)) {
                return false;
            }
        }

        /* Check command first word / verb against whitelist */
        char first_word[64];
        size_t w_len = 0;
        while (seg[w_len] && !isspace((unsigned char)seg[w_len]) && w_len + 1 < sizeof(first_word)) {
            first_word[w_len] = seg[w_len];
            w_len++;
        }
        first_word[w_len] = '\0';

        if (!is_verb_allowed(first_word)) {
            return false;
        }

        /* Git extra safety: checkout must not be without subcommands */
        if (strcmp(first_word, "git") == 0) {
            const char *after_git = seg + w_len;
            while (*after_git && isspace((unsigned char)*after_git)) after_git++;
            char git_sub[64];
            size_t s_len = 0;
            while (after_git[s_len] && !isspace((unsigned char)after_git[s_len]) && s_len + 1 < sizeof(git_sub)) {
                git_sub[s_len] = after_git[s_len];
                s_len++;
            }
            git_sub[s_len] = '\0';
            if (!is_git_subcommand_allowed(git_sub)) {
                return false;
            }
        }
    }

    return true;
}
