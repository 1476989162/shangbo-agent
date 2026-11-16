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

static int strncasecmp_cg(const char *a, const char *b, size_t n) {
    for (size_t i = 0; i < n; ++i) {
        int ca = tolower((unsigned char)a[i]);
        int cb = tolower((unsigned char)b[i]);
        if (ca != cb) return ca - cb;
        if (ca == '\0') return 0;
    }
    return 0;
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

static bool is_token_left_boundary(const char *start, const char *pos) {
    if (pos == start) return true;
    unsigned char prev = (unsigned char)*(pos - 1);
    return isspace(prev) || prev == ';' || prev == '&' || prev == '|' ||
           prev == '"' || prev == '\'' || prev == '`' || prev == '=' || prev == '(';
}

static bool is_token_right_boundary(char c) {
    return c == '\0' || isspace((unsigned char)c) || c == ';' || c == '&' ||
           c == '|' || c == '"' || c == '\'' || c == '`' || c == ')';
}

static bool match_ci_token(const char *str, const char *token) {
    size_t tlen = strlen(token);
    const char *p = strcasestr_cg(str, token);
    while (p) {
        if (is_token_left_boundary(str, p) && is_token_right_boundary(p[tlen])) {
            return true;
        }
        p = strcasestr_cg(p + 1, token);
    }
    return false;
}

static bool has_percent_env_var(const char *cmd) {
    for (const char *p = cmd; *p; ++p) {
        if (*p == '%') {
            const char *q = p + 1;
            if (isalpha((unsigned char)*q) || *q == '_') {
                q++;
                while (isalnum((unsigned char)*q) || *q == '_') q++;
                if (*q == '%') return true;
            }
        }
    }
    return false;
}

static bool is_eval_flag_match(const char *arg_tok, size_t alen, const char *flag) {
    while (alen > 0 && (*arg_tok == '"' || *arg_tok == '\'')) {
        arg_tok++;
        alen--;
    }
    while (alen > 0 && (arg_tok[alen - 1] == '"' || arg_tok[alen - 1] == '\'')) {
        alen--;
    }
    size_t flen = strlen(flag);
    if (alen < flen) return false;
    if (strncasecmp_cg(arg_tok, flag, flen) != 0) return false;
    if (alen == flen) return true;
    char next = arg_tok[flen];
    return next == '=' || next == '"' || next == '\'';
}

static bool has_inline_eval_flag(const char *cmd) {
    /* Match node(.exe) -e / --eval / -p / --print and python/python3(.exe) -c */
    const char *p = cmd;
    while (*p) {
        while (*p && (isspace((unsigned char)*p) || *p == '"' || *p == '\'')) p++;
        if (!*p) break;
        const char *wstart = p;
        while (*p && !isspace((unsigned char)*p) && *p != '"' && *p != '\'' && *p != ';' && *p != '&' && *p != '|') p++;
        size_t wlen = (size_t)(p - wstart);
        char word[64];
        if (wlen >= sizeof(word)) wlen = sizeof(word) - 1;
        for (size_t i = 0; i < wlen; ++i) word[i] = (char)tolower((unsigned char)wstart[i]);
        word[wlen] = '\0';
        /* Strip leading path if any */
        const char *base = strrchr(word, '/');
        const char *base_bs = strrchr(word, '\\');
        if (base_bs && (!base || base_bs > base)) base = base_bs;
        const char *verb = base ? base + 1 : word;
        char clean[64];
        strncpy(clean, verb, sizeof(clean) - 1);
        clean[sizeof(clean) - 1] = '\0';
        char *dot = strrchr(clean, '.');
        if (dot && (strcmp(dot, ".exe") == 0 || strcmp(dot, ".cmd") == 0 || strcmp(dot, ".bat") == 0)) *dot = '\0';

        bool is_node = (strcmp(clean, "node") == 0);
        bool is_py = (strcmp(clean, "python") == 0 || strcmp(clean, "python3") == 0);
        if (is_node || is_py) {
            const char *arg = p;
            while (*arg && *arg != ';' && *arg != '&' && *arg != '|') {
                while (*arg && isspace((unsigned char)*arg)) arg++;
                if (!*arg || *arg == ';' || *arg == '&' || *arg == '|') break;
                const char *astart = arg;
                while (*arg && !isspace((unsigned char)*arg) && *arg != ';' && *arg != '&' && *arg != '|') arg++;
                size_t alen = (size_t)(arg - astart);
                if (is_node && (is_eval_flag_match(astart, alen, "-e") ||
                                is_eval_flag_match(astart, alen, "-p") ||
                                is_eval_flag_match(astart, alen, "--eval") ||
                                is_eval_flag_match(astart, alen, "--print"))) {
                    return true;
                }
                if (is_py && is_eval_flag_match(astart, alen, "-c")) {
                    return true;
                }
            }
        }
        while (*p && *p != ';' && *p != '&' && *p != '|') p++;
        if (*p) p++;
    }
    return false;
}

bool has_dangerous_pattern(const char *command) {
    if (!command || !*command) return false;

    /* Detect escape sequences: ..\ or ../ or standalone .. or ~ at token boundary */
    if (strstr(command, "..\\") || strstr(command, "../")) return true;
    for (const char *p = command; *p; ++p) {
        if (p[0] == '.' && p[1] == '.' && is_token_left_boundary(command, p) &&
            (is_token_right_boundary(p[2]) || p[2] == '/' || p[2] == '\\')) {
            return true;
        }
        if (p[0] == '~' && is_token_left_boundary(command, p) &&
            (is_token_right_boundary(p[1]) || p[1] == '/' || p[1] == '\\')) {
            return true;
        }
    }

    /* Detect environment variable expansions */
    if (has_percent_env_var(command)) return true;
    if (strcasestr_cg(command, "$env:") || strcasestr_cg(command, "$home") ||
        strcasestr_cg(command, "${home}") || strcasestr_cg(command, "$userprofile") ||
        strcasestr_cg(command, "${userprofile}") || strcasestr_cg(command, "$profile") ||
        strcasestr_cg(command, "${profile}") || strcasestr_cg(command, "$pwd")) {
        return true;
    }

    /* Detect root relative escape (case-insensitive) */
    for (const char *p = command; *p; ++p) {
        if (p[0] == '\\' && is_token_left_boundary(command, p) &&
            (isalpha((unsigned char)p[1]) || is_token_right_boundary(p[1]) || p[1] == '*')) {
            return true;
        }
        if (p[0] == '/' && is_token_left_boundary(command, p)) {
            const char *tok_end = p + 1;
            while (*tok_end && !is_token_right_boundary(*tok_end)) tok_end++;
            if (tok_end == p + 1 || p[1] == '*' || memchr(p + 1, '/', (size_t)(tok_end - (p + 1))) != NULL) {
                return true;
            }
        }
    }
    if (strcasestr_cg(command, "\\windows") || strcasestr_cg(command, "\\users") ||
        strcasestr_cg(command, "/etc/") || strcasestr_cg(command, "/usr/") ||
        strcasestr_cg(command, "/bin/") || strcasestr_cg(command, "/var/") ||
        strcasestr_cg(command, "/tmp/") || strcasestr_cg(command, "/home/") ||
        strcasestr_cg(command, "/root/")) {
        return true;
    }

    /* Detect dangerous flags and commands (case-insensitive) */
    if (match_ci_token(command, "--force") || match_ci_token(command, "-enc") ||
        match_ci_token(command, "-encodedcommand") || match_ci_token(command, "iex") ||
        strcasestr_cg(command, "invoke-expression") || strcasestr_cg(command, "invoke-webrequest") ||
        match_ci_token(command, "iwr") || match_ci_token(command, "curl") ||
        match_ci_token(command, "wget") || match_ci_token(command, "scp") ||
        match_ci_token(command, "mklink") || strcasestr_cg(command, "symboliclink") ||
        strcasestr_cg(command, "[environment]") || strcasestr_cg(command, "[io.")) {
        return true;
    }

    /* Detect inline code evaluation: node -e/--eval/-p/--print, python/python3 -c */
    if (has_inline_eval_flag(command)) return true;

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
        (p = strcasestr_cg(command, "node -p")) != NULL ||
        (p = strcasestr_cg(command, "node --print")) != NULL ||
        (p = strcasestr_cg(command, "python -c")) != NULL ||
        (p = strcasestr_cg(command, "python3 -c")) != NULL) {
        
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

static bool segment_paths_stay_inside_workspace(const char *seg, const char *workspace) {
    if (!seg) return true;
    for (const char *p = seg; *p; ++p) {
        /* Detect Windows drive-letter path (e.g. C:\... or C:/...) or UNC path (\\...) */
        bool is_drive = isalpha((unsigned char)p[0]) && p[1] == ':' && (p[2] == '\\' || p[2] == '/') &&
                        (p == seg || isspace((unsigned char)*(p - 1)) || *(p - 1) == '"' || *(p - 1) == '\'' || *(p - 1) == '=');
        bool is_unc = (p[0] == '\\' && p[1] == '\\') &&
                      (p == seg || isspace((unsigned char)*(p - 1)) || *(p - 1) == '"' || *(p - 1) == '\'' || *(p - 1) == '=');
        if (!is_drive && !is_unc) continue;

        const char *end = p;
        while (*end && !isspace((unsigned char)*end) && *end != '"' && *end != '\'' &&
               *end != ';' && *end != '&' && *end != '|') {
            end++;
        }
        size_t path_len = (size_t)(end - p);
        char path_buf[1024];
        if (path_len >= sizeof(path_buf)) path_len = sizeof(path_buf) - 1;
        memcpy(path_buf, p, path_len);
        path_buf[path_len] = '\0';

        if (!workspace || !*workspace || strcmp(workspace, ".") == 0) {
            return false;
        }
        if (!is_path_inside_workspace(path_buf, workspace)) {
            return false;
        }
        p = end - 1;
    }
    return true;
}

bool is_command_safe_for_auto_approval(const char *command, const char *workspace) {
    if (!command || !*command) return false;
    if (touches_private_data(command)) return false;

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

        /* Validate any absolute paths in segment stay inside workspace */
        if (!segment_paths_stay_inside_workspace(seg, workspace)) {
            return false;
        }

        /* Check command first word / verb against whitelist */
        const char *seg_trim = seg;
        while (*seg_trim && (isspace((unsigned char)*seg_trim) || *seg_trim == '"' || *seg_trim == '\'')) seg_trim++;
        char first_word[64];
        size_t w_len = 0;
        while (seg_trim[w_len] && !isspace((unsigned char)seg_trim[w_len]) &&
               seg_trim[w_len] != '"' && seg_trim[w_len] != '\'' && w_len + 1 < sizeof(first_word)) {
            first_word[w_len] = (char)tolower((unsigned char)seg_trim[w_len]);
            w_len++;
        }
        first_word[w_len] = '\0';

        if (!is_verb_allowed(first_word)) {
            return false;
        }

        char clean_verb[64];
        strncpy(clean_verb, first_word, sizeof(clean_verb) - 1);
        clean_verb[sizeof(clean_verb) - 1] = '\0';
        char *dot = strrchr(clean_verb, '.');
        if (dot && (strcmp(dot, ".exe") == 0 || strcmp(dot, ".cmd") == 0 || strcmp(dot, ".bat") == 0)) {
            *dot = '\0';
        }

        /* SSH extra safety: remote destructive commands must require manual confirmation */
        if (strcmp(clean_verb, "ssh") == 0) {
            static const char *ssh_blocked_verbs[] = {
                "rm", "rmdir", "rd", "del", "erase", "remove-item", "ri",
                "unlink", "shred", "format", "diskpart", "mkfs", "dd", NULL
            };
            for (int k = 0; ssh_blocked_verbs[k]; ++k) {
                if (match_ci_token(seg, ssh_blocked_verbs[k])) {
                    return false;
                }
            }
        }

        /* Git extra safety: subcommand must be allowed, and checkout requires -b <branch> */
        if (strcmp(clean_verb, "git") == 0) {
            const char *after_git = seg_trim + w_len;
            while (*after_git && (*after_git == '"' || *after_git == '\'')) after_git++;
            while (*after_git && isspace((unsigned char)*after_git)) after_git++;
            char git_sub[64];
            size_t s_len = 0;
            while (after_git[s_len] && !isspace((unsigned char)after_git[s_len]) && s_len + 1 < sizeof(git_sub)) {
                git_sub[s_len] = (char)tolower((unsigned char)after_git[s_len]);
                s_len++;
            }
            git_sub[s_len] = '\0';
            if (!is_git_subcommand_allowed(git_sub)) {
                return false;
            }
            if (strcmp(git_sub, "checkout") == 0) {
                const char *after_sub = after_git + s_len;
                while (*after_sub && isspace((unsigned char)*after_sub)) after_sub++;
                if (strncmp(after_sub, "-b", 2) != 0 || !isspace((unsigned char)after_sub[2])) {
                    return false;
                }
                const char *branch = after_sub + 2;
                while (*branch && isspace((unsigned char)*branch)) branch++;
                if (!*branch || *branch == '-') {
                    return false;
                }
            }
        }
    }

    return true;
}
