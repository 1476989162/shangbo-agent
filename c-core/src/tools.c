#include "../include/tools.h"
#include "../include/safety.h"
#include "../include/native_process.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>

#ifdef _WIN32
#include <windows.h>
#include <direct.h>
#define STRDUP _strdup
#else
#include <unistd.h>
#include <dirent.h>
#include <sys/stat.h>
#define STRDUP strdup
#endif

#define MAX_TOOL_OUTPUT 16000
#define MAX_READ_DEFAULT 262144
#define MAX_SEARCH_FILES 5000
#define MAX_SEARCH_FILE_BYTES 512000

/* Windows-only conversion helpers: no callers exist in non-Windows branches,
   keeping empty stubs only triggers gcc -Wunused-function. */
#ifdef _WIN32
static wchar_t *utf8_wide(const char *text) {
    if (!text) return NULL;
    int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, -1, NULL, 0);
    if (n <= 0) return NULL;
    wchar_t *out = (wchar_t *)calloc((size_t)n, sizeof(wchar_t));
    if (out) MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, -1, out, n);
    return out;
}

static char *wide_utf8(const wchar_t *text) {
    int n = WideCharToMultiByte(CP_UTF8, 0, text, -1, NULL, 0, NULL, NULL);
    if (n <= 0) return NULL;
    char *out = (char *)calloc((size_t)n, 1);
    if (out) WideCharToMultiByte(CP_UTF8, 0, text, -1, out, n, NULL, NULL);
    return out;
}
#endif

static FILE *open_file_utf8(const char *path, const char *mode) {
#ifdef _WIN32
    wchar_t *wpath = utf8_wide(path);
    wchar_t *wmode = utf8_wide(mode);
    if (!wpath || !wmode) { free(wpath); free(wmode); return NULL; }
    FILE *f = _wfopen(wpath, wmode);
    free(wpath); free(wmode);
    return f;
#else
    return fopen(path, mode);
#endif
}

static void make_parent_dirs(const char *file_path) {
    if (!file_path) return;
    char *copy = STRDUP(file_path);
    if (!copy) return;
    for (size_t i = 0; copy[i]; ++i) {
        if (copy[i] == '/' || copy[i] == '\\') {
            char sep = copy[i]; copy[i] = '\0';
            if (i > 0 && !(i == 2 && copy[1] == ':')) {
#ifdef _WIN32
                wchar_t *wide = utf8_wide(copy);
                if (wide) { _wmkdir(wide); free(wide); }
#else
                mkdir(copy, 0755);
#endif
            }
            copy[i] = sep;
        }
    }
    free(copy);
}

void tool_result_free(ToolResult *res) {
    if (!res) return;
    free(res->output); res->output = NULL; res->output_len = 0;
    res->success = false; res->error_message[0] = '\0';
}

static size_t utf8_safe_prefix_len(const char *s, size_t max_len) {
    if (!s || max_len == 0) return 0;
    size_t cut = max_len;
    /* Find the start of the last UTF-8 character within [0, cut) */
    size_t k = cut;
    while (k > 0 && cut - k < 4 && ((unsigned char)s[k - 1] & 0xC0) == 0x80) {
        k--;
    }
    if (k > 0 && ((unsigned char)s[k - 1] & 0x80) != 0) {
        unsigned char lead = (unsigned char)s[k - 1];
        size_t needed = 0;
        if (lead >= 0xC2 && lead <= 0xDF) needed = 2;
        else if (lead >= 0xE0 && lead <= 0xEF) needed = 3;
        else if (lead >= 0xF0 && lead <= 0xF4) needed = 4;
        if (needed == 0 || (cut - (k - 1)) < needed) {
            cut = k - 1;
        }
    }
    return cut;
}

static void trim_incomplete_utf8(char *s) {
    if (!s) return;
    size_t len = strlen(s);
    size_t safe = utf8_safe_prefix_len(s, len);
    s[safe] = '\0';
}

static bool is_directory_path(const char *path) {
    if (!path || !*path) return false;
#ifdef _WIN32
    wchar_t *wpath = utf8_wide(path);
    if (!wpath) return false;
    DWORD attr = GetFileAttributesW(wpath);
    free(wpath);
    return (attr != INVALID_FILE_ATTRIBUTES) && ((attr & FILE_ATTRIBUTE_DIRECTORY) != 0);
#else
    struct stat st;
    return stat(path, &st) == 0 && S_ISDIR(st.st_mode);
#endif
}

static bool is_regular_file_path(const char *path) {
    if (!path || !*path) return false;
#ifdef _WIN32
    wchar_t *wpath = utf8_wide(path);
    if (!wpath) return false;
    DWORD attr = GetFileAttributesW(wpath);
    free(wpath);
    return (attr != INVALID_FILE_ATTRIBUTES) && ((attr & FILE_ATTRIBUTE_DIRECTORY) == 0);
#else
    struct stat st;
    return stat(path, &st) == 0 && S_ISREG(st.st_mode);
#endif
}

static int count_top_level_entries(const char *dir) {
    if (!dir || !*dir) return -1;
#ifdef _WIN32
    wchar_t *wide_dir = utf8_wide(dir);
    if (!wide_dir) return -1;
    size_t cap = wcslen(wide_dir) + 4;
    wchar_t *pattern = (wchar_t *)malloc(cap * sizeof(wchar_t));
    if (pattern) _snwprintf(pattern, cap, L"%s\\*", wide_dir);
    free(wide_dir);
    if (!pattern) return -1;
    WIN32_FIND_DATAW data;
    HANDLE find = FindFirstFileW(pattern, &data);
    free(pattern);
    if (find == INVALID_HANDLE_VALUE) return -1;
    int count = 0;
    do {
        if (wcscmp(data.cFileName, L".") == 0 || wcscmp(data.cFileName, L"..") == 0) continue;
        count++;
    } while (FindNextFileW(find, &data));
    FindClose(find);
    return count;
#else
    DIR *d = opendir(dir);
    if (!d) return -1;
    int count = 0;
    struct dirent *entry;
    while ((entry = readdir(d)) != NULL) {
        if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
        count++;
    }
    closedir(d);
    return count;
#endif
}

static char *alloc_empty(void) { return (char *)calloc(1, 1); }

static char *truncate_output(const char *text) {
    if (!text) return alloc_empty();
    size_t n = strlen(text);
    if (n <= MAX_TOOL_OUTPUT) return STRDUP(text);
    size_t keep = utf8_safe_prefix_len(text, MAX_TOOL_OUTPUT);
    char *out = (char *)malloc(keep + 160);
    if (!out) return NULL;
    memcpy(out, text, keep);
    snprintf(out + keep, 160, "\n\n... (output truncated, total %lu characters)", (unsigned long)n);
    return out;
}

static char *read_entire_file(const char *path, size_t *out_size) {
    FILE *f = open_file_utf8(path, "rb");
    if (!f) return NULL;
    if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return NULL; }
    long sz = ftell(f);
    if (sz < 0 || fseek(f, 0, SEEK_SET) != 0) { fclose(f); return NULL; }
    char *buf = (char *)malloc((size_t)sz + 1);
    if (!buf) { fclose(f); return NULL; }
    size_t got = fread(buf, 1, (size_t)sz, f);
    if (ferror(f)) { free(buf); fclose(f); return NULL; }
    buf[got] = '\0'; fclose(f);
    if (out_size) *out_size = got;
    return buf;
}

static bool contains_nul(const char *data, size_t size) { return memchr(data, '\0', size) != NULL; }

static char *read_lines_result(const char *path, const char *content, size_t size, int start, int end) {
    int current = 0, actual_end = start - 1;
    size_t pos = 0, cap = size + 1024, used = 0;
    char *lines = (char *)malloc(cap);
    if (!lines) return NULL;
    lines[0] = '\0';
    while (pos < size && current < end) {
        size_t begin = pos;
        while (pos < size && content[pos] != '\n') pos++;
        size_t line_len = pos - begin;
        if (line_len > 0 && content[begin + line_len - 1] == '\r') line_len--;
        current++;
        if (contains_nul(content + begin, line_len)) {
            free(lines);
            char *out = (char *)malloc(strlen(path) + 96);
            if (out) snprintf(out, strlen(path) + 96, "%s: binary file; text content is not provided.", path);
            return out;
        }
        if (current < start) { if (pos < size) pos++; continue; }
        actual_end = current;
        char prefix[40];
        int prefix_len = snprintf(prefix, sizeof(prefix), "%d: ", current);
        if (used + line_len + (size_t)prefix_len + 2 > cap) {
            cap = (used + line_len + (size_t)prefix_len + 2) * 2;
            char *grown = (char *)realloc(lines, cap);
            if (!grown) { free(lines); return NULL; }
            lines = grown;
        }
        memcpy(lines + used, prefix, (size_t)prefix_len); used += (size_t)prefix_len;
        memcpy(lines + used, content + begin, line_len); used += line_len;
        if (current < end && pos < size) lines[used++] = '\n';
        lines[used] = '\0';
        if (pos < size) pos++;
    }
    if (start > current) { free(lines); return NULL; }
    const char *notice = current < end ? "\n\n... (returned through end of file)" : "";
    const char *suffix = used > MAX_TOOL_OUTPUT ? "\n\n... (output truncated)" : notice;
    size_t keep = used > MAX_TOOL_OUTPUT ? utf8_safe_prefix_len(lines, MAX_TOOL_OUTPUT) : used;
    char *out = (char *)malloc(keep + strlen(path) + strlen(suffix) + 160);
    if (out) snprintf(out, keep + strlen(path) + strlen(suffix) + 160, "%s (lines %d-%d):\n\n%.*s%s", path, start, actual_end, (int)keep, lines, suffix);
    free(lines);
    return out;
}

ToolResult tool_read_file(const char *path, int start_line, int end_line, const char *workspace) {
    ToolResult res; memset(&res, 0, sizeof(res));
    if (!path || !*path) { snprintf(res.error_message, sizeof(res.error_message), "Path cannot be empty."); return res; }
    if (touches_private_data(path) || (workspace && *workspace && touches_private_data(workspace))) {
        snprintf(res.error_message, sizeof(res.error_message), "Access denied: attempting to read sensitive private data.");
        return res;
    }
    if (is_directory_path(path)) {
        snprintf(res.error_message, sizeof(res.error_message), "路径 %s 是目录不是文件：要列内容请用 list_directory，要读文件请传具体文件路径。", path);
        trim_incomplete_utf8(res.error_message);
        return res;
    }
    if (start_line < 0 || end_line < -1 || (end_line > 0 && start_line > 0 && end_line < start_line)) {
        snprintf(res.error_message, sizeof(res.error_message), "endLine must be greater than or equal to startLine."); return res;
    }
    size_t size = 0; char *content = read_entire_file(path, &size);
    if (!content) {
        snprintf(res.error_message, sizeof(res.error_message), "Failed to open or read file: %s", path);
        trim_incomplete_utf8(res.error_message);
        return res;
    }
    if (start_line > 0 || end_line > 0) {
        int start = start_line > 0 ? start_line : 1, end = end_line > 0 ? end_line : 2147483647;
        res.output = read_lines_result(path, content, size, start, end);
        free(content);
        if (!res.output) { snprintf(res.error_message, sizeof(res.error_message), "startLine %d exceeds file line count or output allocation failed.", start); return res; }
    } else {
        if (contains_nul(content, size)) {
            free(content);
            res.output = (char *)malloc(strlen(path) + 100);
            if (res.output) snprintf(res.output, strlen(path) + 100, "%s (%lu bytes): binary file; text content is not provided.", path, (unsigned long)size);
        } else {
            const char *notice = size > MAX_READ_DEFAULT ? "\n\n... (default 262144-byte read limit reached; use offsetBytes/maxBytes for the next chunk)" : "";
            size_t read_keep = size > MAX_READ_DEFAULT ? utf8_safe_prefix_len(content, MAX_READ_DEFAULT) : size;
            char *text = (char *)malloc(strlen(path) + strlen(notice) + read_keep + 128);
            if (text) snprintf(text, strlen(path) + strlen(notice) + read_keep + 128, "%s (%lu bytes):\n\n%.*s%s", path, (unsigned long)size, (int)read_keep, content, notice);
            res.output = truncate_output(text ? text : "");
            free(text);
        }
        free(content);
    }
    if (!res.output) { snprintf(res.error_message, sizeof(res.error_message), "Out of memory."); return res; }
    res.output_len = strlen(res.output); res.success = true; return res;
}

ToolResult tool_read_file_window(const char *path, int offset_bytes, int max_bytes, const char *workspace) {
    ToolResult res; memset(&res, 0, sizeof(res));
    if (!path || !*path || offset_bytes < 0 || max_bytes <= 0 || max_bytes > 8 * 1024 * 1024) {
        snprintf(res.error_message, sizeof(res.error_message), "Invalid byte window: offsetBytes >= 0 and 1 <= maxBytes <= 8388608 required."); return res;
    }
    if (touches_private_data(path) || (workspace && *workspace && touches_private_data(workspace))) {
        snprintf(res.error_message, sizeof(res.error_message), "Access denied: attempting to read sensitive private data.");
        return res;
    }
    if (is_directory_path(path)) {
        snprintf(res.error_message, sizeof(res.error_message), "路径 %s 是目录不是文件：要列内容请用 list_directory，要读文件请传具体文件路径。", path);
        trim_incomplete_utf8(res.error_message);
        return res;
    }
    FILE *f = open_file_utf8(path, "rb");
    if (!f) {
        snprintf(res.error_message, sizeof(res.error_message), "Failed to open or read file: %s", path);
        trim_incomplete_utf8(res.error_message);
        return res;
    }
    fseek(f, 0, SEEK_END); long file_size = ftell(f);
    if (file_size < 0 || fseek(f, offset_bytes, SEEK_SET) != 0) { fclose(f); snprintf(res.error_message, sizeof(res.error_message), "Invalid file or byte offset."); return res; }
    long remaining = file_size - offset_bytes;
    size_t want = remaining > 0 ? (size_t)(remaining < max_bytes ? remaining : max_bytes) : 0;
    unsigned char *buffer = (unsigned char *)malloc(want + 1);
    if (!buffer) { fclose(f); snprintf(res.error_message, sizeof(res.error_message), "Out of memory."); return res; }
    size_t got = fread(buffer, 1, want, f); fclose(f); buffer[got] = 0;
    if (contains_nul((const char *)buffer, got)) {
        free(buffer); res.output = (char *)malloc(strlen(path) + 100);
        if (res.output) snprintf(res.output, strlen(path) + 100, "%s (%ld bytes): binary file; text content is not provided.", path, file_size);
    } else {
        size_t start = 0;
        while (start < got && (buffer[start] & 0xc0) == 0x80) start++;
        size_t text_size = got - start;
        char *text = (char *)malloc(text_size + 1);
        if (text) {
            memcpy(text, buffer + start, text_size);
            text[text_size] = '\0';
            text_size = utf8_safe_prefix_len(text, text_size);
            text[text_size] = '\0';
        }
        size_t keep = text_size > MAX_TOOL_OUTPUT ? utf8_safe_prefix_len(text ? text : "", MAX_TOOL_OUTPUT) : text_size;
        const char *notice = offset_bytes + (long)got < file_size ? "\n\n... (more bytes available; continue with offsetBytes)" : "";
        const char *boundary = start > 0 ? "\n\n(start skipped a partial UTF-8 character)" : "";
        res.output = (char *)malloc(keep + strlen(path) + strlen(notice) + strlen(boundary) + 256);
        if (res.output) snprintf(res.output, keep + strlen(path) + strlen(notice) + strlen(boundary) + 256,
            "%s (%ld bytes, offset %d-%lu):\n\n%.*s%s%s%s", path, file_size, offset_bytes, (unsigned long)(offset_bytes + got), (int)keep, text ? text : "", boundary, notice, text_size > MAX_TOOL_OUTPUT ? "\n\n... (output truncated)" : "");
        free(text);
    }
    free(buffer);
    if (!res.output) { snprintf(res.error_message, sizeof(res.error_message), "Out of memory."); return res; }
    res.output_len = strlen(res.output); res.success = true; return res;
}

ToolResult tool_write_file(const char *path, const char *content, bool overwrite, const char *workspace) {
    ToolResult res; memset(&res, 0, sizeof(res));
    if (!path || !*path || !content) { snprintf(res.error_message, sizeof(res.error_message), "Path and content are required."); return res; }
    if (touches_private_data(path) || (workspace && *workspace && touches_private_data(workspace))) {
        snprintf(res.error_message, sizeof(res.error_message), "Security rejection: Writing to private data file is blocked.");
        return res;
    }
    if (!overwrite) { FILE *check = open_file_utf8(path, "rb"); if (check) { fclose(check); snprintf(res.error_message, sizeof(res.error_message), "File already exists and overwrite is false."); return res; } }
    make_parent_dirs(path);
    FILE *f = open_file_utf8(path, "wb");
    if (!f) {
        snprintf(res.error_message, sizeof(res.error_message), "Failed to open file for writing: %s", path);
        trim_incomplete_utf8(res.error_message);
        return res;
    }
    size_t n = strlen(content);
    bool ok = fwrite(content, 1, n, f) == n && fclose(f) == 0;
    if (!ok) {
        snprintf(res.error_message, sizeof(res.error_message), "Failed to write complete file: %s", path);
        trim_incomplete_utf8(res.error_message);
        return res;
    }
    res.output = (char *)malloc(strlen(path) + 100);
    if (!res.output) { snprintf(res.error_message, sizeof(res.error_message), "Out of memory."); return res; }
    snprintf(res.output, strlen(path) + 100, "Wrote %s (%lu bytes)", path, (unsigned long)n);
    res.output_len = strlen(res.output); res.success = true; return res;
}

static char *normalized_lf(const char *raw) {
    size_t n = strlen(raw), used = 0; char *out = (char *)malloc(n + 1);
    if (!out) return NULL;
    for (size_t i = 0; i < n; ++i) { if (raw[i] == '\r' && raw[i + 1] == '\n') continue; out[used++] = raw[i]; }
    out[used] = '\0'; return out;
}

static size_t map_norm_offset_to_raw(const char *raw, size_t norm_offset) {
    size_t raw_pos = 0;
    size_t norm_pos = 0;
    while (norm_pos < norm_offset && raw[raw_pos] != '\0') {
        if (raw[raw_pos] == '\r' && raw[raw_pos + 1] == '\n') {
            raw_pos += 2;
        } else {
            raw_pos += 1;
        }
        norm_pos += 1;
    }
    return raw_pos;
}

static char *convert_lf_to_crlf(const char *lf_text) {
    size_t n = strlen(lf_text);
    size_t newlines = 0;
    for (size_t i = 0; i < n; ++i) {
        if (lf_text[i] == '\n') newlines++;
    }
    char *out = (char *)malloc(n + newlines + 1);
    if (!out) return NULL;
    size_t used = 0;
    for (size_t i = 0; i < n; ++i) {
        if (lf_text[i] == '\n') {
            out[used++] = '\r';
            out[used++] = '\n';
        } else {
            out[used++] = lf_text[i];
        }
    }
    out[used] = '\0';
    return out;
}

ToolResult tool_patch_file(const char *path, const char *target, const char *replacement, const char *workspace) {
    ToolResult res; memset(&res, 0, sizeof(res));
    if (!path || !*path || !target || !*target || !replacement) { snprintf(res.error_message, sizeof(res.error_message), "Invalid patch arguments: path, non-empty target and replacement are required."); return res; }
    if (touches_private_data(path) || (workspace && *workspace && touches_private_data(workspace))) {
        snprintf(res.error_message, sizeof(res.error_message), "Security rejection: Patching private credentials is blocked.");
        return res;
    }
    size_t size = 0; char *raw = read_entire_file(path, &size);
    if (!raw) {
        snprintf(res.error_message, sizeof(res.error_message), "Failed to read file for patching: %s", path);
        trim_incomplete_utf8(res.error_message);
        return res;
    }
    const char *first = strstr(raw, target);
    if (first && strstr(first + strlen(target), target)) { free(raw); snprintf(res.error_message, sizeof(res.error_message), "Target string is not unique; add more context lines before patching."); return res; }
    char *updated = NULL;
    if (first) {
        size_t prefix = (size_t)(first - raw), target_len = strlen(target);
        bool file_has_crlf = strstr(raw, "\r\n") != NULL;
        char *norm_repl = (file_has_crlf && strchr(replacement, '\n') != NULL) ? normalized_lf(replacement) : NULL;
        char *effective_repl = norm_repl ? convert_lf_to_crlf(norm_repl) : NULL;
        free(norm_repl);
        const char *repl_to_use = effective_repl ? effective_repl : replacement;
        size_t replacement_len = strlen(repl_to_use);
        updated = (char *)malloc(size - target_len + replacement_len + 1);
        if (updated) {
            memcpy(updated, raw, prefix);
            memcpy(updated + prefix, repl_to_use, replacement_len);
            strcpy(updated + prefix + replacement_len, first + target_len);
        }
        free(effective_repl);
    } else {
        char *norm_raw = normalized_lf(raw), *norm_target = normalized_lf(target);
        if (!norm_raw || !norm_target) { free(raw); free(norm_raw); free(norm_target); snprintf(res.error_message, sizeof(res.error_message), "Out of memory."); return res; }
        char *match = strstr(norm_raw, norm_target);
        if (!match) { free(raw); free(norm_raw); free(norm_target); snprintf(res.error_message, sizeof(res.error_message), "Target string not found in file; read the exact block before retrying."); return res; }
        if (strstr(match + strlen(norm_target), norm_target)) { free(raw); free(norm_raw); free(norm_target); snprintf(res.error_message, sizeof(res.error_message), "Target string is not unique after newline normalization; add more context lines."); return res; }
        size_t norm_idx = (size_t)(match - norm_raw);
        size_t norm_len = strlen(norm_target);
        size_t begin = map_norm_offset_to_raw(raw, norm_idx);
        size_t end = map_norm_offset_to_raw(raw, norm_idx + norm_len);
        bool file_has_crlf = strstr(raw, "\r\n") != NULL;
        char *norm_repl = normalized_lf(replacement);
        char *effective_repl = (file_has_crlf && norm_repl) ? convert_lf_to_crlf(norm_repl) : STRDUP(norm_repl ? norm_repl : replacement);
        free(norm_repl);
        if (effective_repl) {
            size_t replacement_len = strlen(effective_repl);
            updated = (char *)malloc(begin + replacement_len + strlen(raw + end) + 1);
            if (updated) {
                memcpy(updated, raw, begin);
                memcpy(updated + begin, effective_repl, replacement_len);
                strcpy(updated + begin + replacement_len, raw + end);
            }
            free(effective_repl);
        }
        free(norm_raw); free(norm_target);
    }
    free(raw);
    if (!updated) { snprintf(res.error_message, sizeof(res.error_message), "Out of memory."); return res; }
    FILE *f = open_file_utf8(path, "wb");
    if (!f) {
        free(updated);
        snprintf(res.error_message, sizeof(res.error_message), "Failed to open file for saving patch: %s", path);
        trim_incomplete_utf8(res.error_message);
        return res;
    }
    size_t n = strlen(updated); bool ok = fwrite(updated, 1, n, f) == n && fclose(f) == 0; free(updated);
    if (!ok) {
        snprintf(res.error_message, sizeof(res.error_message), "Failed to save complete patch: %s", path);
        trim_incomplete_utf8(res.error_message);
        return res;
    }
    res.output = (char *)malloc(strlen(path) + 80);
    if (res.output) snprintf(res.output, strlen(path) + 80, "Successfully applied unique patch to %s.", path);
    if (!res.output) { snprintf(res.error_message, sizeof(res.error_message), "Out of memory."); return res; }
    res.output_len = strlen(res.output); res.success = true; return res;
}

static bool append_text(char **buffer, size_t *used, size_t *capacity, const char *text) {
    size_t n = strlen(text);
    if (*used + n + 1 > *capacity) {
        while (*used + n + 1 > *capacity) *capacity *= 2;
        char *grown = (char *)realloc(*buffer, *capacity);
        if (!grown) return false; *buffer = grown;
    }
    memcpy(*buffer + *used, text, n); *used += n; (*buffer)[*used] = '\0'; return true;
}

#ifdef _WIN32
ToolResult tool_list_directory(const char *path, int max_depth, const char *workspace) {
    ToolResult res; memset(&res, 0, sizeof(res)); (void)max_depth;
    const char *dir = path && *path ? path : ".";
    if (touches_private_data(dir) || (workspace && *workspace && touches_private_data(workspace))) {
        snprintf(res.error_message, sizeof(res.error_message), "Access denied: listing private data directory is blocked.");
        return res;
    }
    if (is_regular_file_path(dir)) {
        snprintf(res.error_message, sizeof(res.error_message), "路径 %s 是文件不是目录：要读内容请用 read_file，要列目录请传其父目录。", dir);
        trim_incomplete_utf8(res.error_message);
        return res;
    }
    wchar_t *wide_dir = utf8_wide(dir);
    if (!wide_dir) { snprintf(res.error_message, sizeof(res.error_message), "Invalid UTF-8 directory path."); return res; }
    size_t cap = wcslen(wide_dir) + 4; wchar_t *pattern = (wchar_t *)malloc(cap * sizeof(wchar_t));
    if (pattern) _snwprintf(pattern, cap, L"%s\\*", wide_dir);
    free(wide_dir);
    WIN32_FIND_DATAW data; HANDLE find = pattern ? FindFirstFileW(pattern, &data) : INVALID_HANDLE_VALUE;
    free(pattern);
    if (find == INVALID_HANDLE_VALUE) {
        snprintf(res.error_message, sizeof(res.error_message), "Failed to list directory: %s", dir);
        trim_incomplete_utf8(res.error_message);
        return res;
    }
    size_t used = 0, capacity = 8192; char *buf = alloc_empty(); capacity = 1;
    if (!buf) { FindClose(find); snprintf(res.error_message, sizeof(res.error_message), "Out of memory."); return res; }
    int count = 0; bool truncated = false;
    do {
        if (wcscmp(data.cFileName, L".") == 0 || wcscmp(data.cFileName, L"..") == 0) continue;
        char *name = wide_utf8(data.cFileName);
        if (!name) continue;
        char line[1024];
        if (data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) snprintf(line, sizeof(line), "[DIR] %s/\n", name);
        else snprintf(line, sizeof(line), "[FILE] %s  %llu bytes\n", name, ((unsigned long long)data.nFileSizeHigh << 32) | data.nFileSizeLow);
        free(name);
        if (count++ < 500) {
            if (!append_text(&buf, &used, &capacity, line)) { free(buf); FindClose(find); snprintf(res.error_message, sizeof(res.error_message), "Out of memory."); return res; }
        } else truncated = true;
    } while (FindNextFileW(find, &data));
    FindClose(find);
    if (truncated) append_text(&buf, &used, &capacity, "... (only first 500 entries)\n");
    char *final = (char *)malloc(used + strlen(dir) + 100);
    if (final) snprintf(final, used + strlen(dir) + 100, "%s: %d entries:\n%s", dir, count, buf);
    free(buf); res.output = truncate_output(final ? final : ""); free(final);
    if (!res.output) { snprintf(res.error_message, sizeof(res.error_message), "Out of memory."); return res; }
    res.output_len = strlen(res.output); res.success = true; return res;
}
#else
ToolResult tool_list_directory(const char *path, int max_depth, const char *workspace) {
    ToolResult res; memset(&res, 0, sizeof(res)); (void)max_depth;
    const char *dir = path && *path ? path : ".";
    if (touches_private_data(dir) || (workspace && *workspace && touches_private_data(workspace))) {
        snprintf(res.error_message, sizeof(res.error_message), "Access denied: listing private data directory is blocked.");
        return res;
    }
    if (is_regular_file_path(dir)) {
        snprintf(res.error_message, sizeof(res.error_message), "路径 %s 是文件不是目录：要读内容请用 read_file，要列目录请传其父目录。", dir);
        trim_incomplete_utf8(res.error_message);
        return res;
    }
    DIR *d = opendir(dir);
    if (!d) {
        snprintf(res.error_message, sizeof(res.error_message), "Failed to list directory: %s", dir);
        trim_incomplete_utf8(res.error_message);
        return res;
    }
    size_t used = 0, capacity = 8192; char *buf = alloc_empty(); capacity = 1;
    if (!buf) { closedir(d); snprintf(res.error_message, sizeof(res.error_message), "Out of memory."); return res; }
    struct dirent *entry; int count = 0;
    while ((entry = readdir(d)) != NULL && count < 500) {
        if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
        char *line = (char *)malloc(strlen(entry->d_name) + 80);
        if (line) { snprintf(line, strlen(entry->d_name) + 80, "%s %s\n", entry->d_type == DT_DIR ? "[DIR]" : "[FILE]", entry->d_name); append_text(&buf, &used, &capacity, line); free(line); }
        count++;
    }
    closedir(d); res.output = buf; res.output_len = used; res.success = true; return res;
}
#endif

ToolResult tool_search_files(const char *path, const char *query, const char *workspace) {
    ToolResult res; memset(&res, 0, sizeof(res));
    if (!query || !*query) { snprintf(res.error_message, sizeof(res.error_message), "Search query cannot be empty."); return res; }
    if (touches_private_data(query) || (path && touches_private_data(path)) || (workspace && *workspace && touches_private_data(workspace))) {
        snprintf(res.error_message, sizeof(res.error_message), "Access denied: searching private sensitive data is blocked.");
        trim_incomplete_utf8(res.error_message);
        return res;
    }
    const char *dir = path && *path ? path : (workspace && *workspace ? workspace : ".");
    for (const char *p = query; *p; ++p) if (strchr("&|;`$<>^%\"\n\r", *p)) { snprintf(res.error_message, sizeof(res.error_message), "Invalid search query: shell metacharacters not allowed."); return res; }
    NativeProcessResult process;
#ifdef _WIN32
    char *command = (char *)malloc(strlen(dir) + strlen(query) + 80);
    if (command) snprintf(command, strlen(dir) + strlen(query) + 80, "findstr /s /i /n \"%s\" \"%s\\*.*\" 2>nul", query, dir);
#else
    char *command = (char *)malloc(strlen(dir) + strlen(query) + 60);
    if (command) snprintf(command, strlen(dir) + strlen(query) + 60, "grep -r -n -i -F \"%s\" \"%s\" 2>/dev/null", query, dir);
#endif
    if (!command) { snprintf(res.error_message, sizeof(res.error_message), "Out of memory."); return res; }
    process = native_run_process(command, workspace, 60000); free(command);
    if (!process.started) {
        snprintf(res.error_message, sizeof(res.error_message), "%s", process.error);
        trim_incomplete_utf8(res.error_message);
        native_process_result_free(&process);
        return res;
    }
    res.output = truncate_output(process.output ? process.output : "");
    native_process_result_free(&process);
    if (!res.output) { snprintf(res.error_message, sizeof(res.error_message), "Out of memory."); return res; }
    res.output_len = strlen(res.output); res.success = true; return res;
}

/* Native search: bounded directory traversal, no shell interpreter involved. */
typedef struct {
    char *text;
    size_t used;
    size_t capacity;
    int results;
    int max_results;
    int scanned;
    bool completed;
    bool failed;
} SearchState;

static bool search_skip_dir(const char *name) {
    static const char *skip[] = {"node_modules", ".git", "dist", "out", "release", ".vite", "coverage", NULL};
    for (int i = 0; skip[i]; ++i) if (strcmp(name, skip[i]) == 0) return true;
    return false;
}

static bool contains_casefold(const char *text, const char *needle) {
    if (!needle || !*needle) return true;
    size_t n = strlen(needle);
    for (const char *p = text; *p; ++p) {
        size_t i = 0;
        while (i < n && p[i] && tolower((unsigned char)p[i]) == tolower((unsigned char)needle[i])) i++;
        if (i == n) return true;
    }
    return false;
}

static void search_result(SearchState *state, const char *text) {
    if (state->results >= state->max_results) return;
    if (!append_text(&state->text, &state->used, &state->capacity, text)) state->failed = true;
    state->results++;
}

static void search_file(SearchState *state, const char *path, const char *name, const char *filename, const char *needle) {
    state->scanned++;
    if (state->scanned > MAX_SEARCH_FILES) { state->completed = false; return; }
    if (filename && *filename && !contains_casefold(name, filename)) return;
    if (!needle || !*needle) {
        size_t n = strlen(path) + 2; char *line = (char *)malloc(n);
        if (line) { snprintf(line, n, "%s\n", path); search_result(state, line); free(line); } else state->failed = true;
        return;
    }
    size_t size = 0; char *raw = read_entire_file(path, &size);
    if (!raw) return;
    if (size > MAX_SEARCH_FILE_BYTES || contains_nul(raw, size)) { free(raw); return; }
    int line_number = 1, per_file = 0;
    char *cursor = raw;
    while (*cursor && per_file < 5 && state->results < state->max_results) {
        char *end = strchr(cursor, '\n');
        if (end) *end = '\0';
        if (contains_casefold(cursor, needle)) {
            size_t len = strlen(cursor), start = 0;
            while (start < len && (cursor[start] == ' ' || cursor[start] == '\t' || cursor[start] == '\r')) start++;
            size_t keep = len - start < 200 ? len - start : 200;
            char *line = (char *)malloc(strlen(path) + keep + 40);
            if (line) {
                snprintf(line, strlen(path) + keep + 40, "%s:%d: %.*s\n", path, line_number, (int)keep, cursor + start);
                search_result(state, line); free(line); per_file++;
            } else { state->failed = true; break; }
        }
        if (!end) break;
        cursor = end + 1; line_number++;
    }
    free(raw);
}

#ifdef _WIN32
static void search_directory(SearchState *state, const char *directory, const char *filename, const char *needle) {
    if (state->failed || state->results >= state->max_results || state->scanned > MAX_SEARCH_FILES) return;
    wchar_t *wide = utf8_wide(directory);
    if (!wide) return;
    size_t cap = wcslen(wide) + 4;
    wchar_t *pattern = (wchar_t *)malloc(cap * sizeof(wchar_t));
    if (pattern) _snwprintf(pattern, cap, L"%s\\*", wide);
    free(wide);
    WIN32_FIND_DATAW data;
    HANDLE find = pattern ? FindFirstFileW(pattern, &data) : INVALID_HANDLE_VALUE;
    free(pattern);
    if (find == INVALID_HANDLE_VALUE) return;
    do {
        if (state->results >= state->max_results || state->scanned > MAX_SEARCH_FILES || state->failed) break;
        if (wcscmp(data.cFileName, L".") == 0 || wcscmp(data.cFileName, L"..") == 0) continue;
        char *name = wide_utf8(data.cFileName);
        if (!name) continue;
        size_t len = strlen(directory) + strlen(name) + 2;
        char *path = (char *)malloc(len);
        if (!path) { free(name); state->failed = true; break; }
        snprintf(path, len, "%s\\%s", directory, name);
        if (data.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) { free(path); free(name); continue; }
        if (data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
            if (!search_skip_dir(name)) search_directory(state, path, filename, needle);
        } else search_file(state, path, name, filename, needle);
        free(path); free(name);
    } while (FindNextFileW(find, &data));
    FindClose(find);
}
#else
static void search_directory(SearchState *state, const char *directory, const char *filename, const char *needle) {
    if (state->failed || state->results >= state->max_results || state->scanned > MAX_SEARCH_FILES) return;
    DIR *dir = opendir(directory); if (!dir) return;
    struct dirent *entry;
    while ((entry = readdir(dir)) != NULL) {
        if (state->results >= state->max_results || state->scanned > MAX_SEARCH_FILES || state->failed) break;
        if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
        char path[4096]; snprintf(path, sizeof(path), "%s/%s", directory, entry->d_name);
        struct stat info;
        if (lstat(path, &info) != 0 || S_ISLNK(info.st_mode)) continue;
        if (S_ISDIR(info.st_mode)) { if (!search_skip_dir(entry->d_name)) search_directory(state, path, filename, needle); }
        else if (S_ISREG(info.st_mode)) search_file(state, path, entry->d_name, filename, needle);
    }
    closedir(dir);
}
#endif

ToolResult tool_search_files_ex(const char *path, const char *filename, const char *content, int max_results, const char *workspace) {
    ToolResult res; memset(&res, 0, sizeof(res));
    const char *root = path && *path ? path : (workspace && *workspace ? workspace : ".");
    if ((!filename || !*filename) && (!content || !*content)) { snprintf(res.error_message, sizeof(res.error_message), "At least filename or content is required."); return res; }
    if (touches_private_data(root) || (workspace && *workspace && touches_private_data(workspace))) {
        snprintf(res.error_message, sizeof(res.error_message), "Access denied: searching private data is blocked.");
        trim_incomplete_utf8(res.error_message);
        return res;
    }
    SearchState state; memset(&state, 0, sizeof(state));
    state.max_results = max_results > 0 && max_results <= 200 ? max_results : 50;
    state.completed = true; state.capacity = 8192; state.text = (char *)calloc(state.capacity, 1);
    if (!state.text) { snprintf(res.error_message, sizeof(res.error_message), "Out of memory."); return res; }
    search_directory(&state, root, filename, content);
    if (state.scanned >= MAX_SEARCH_FILES) state.completed = false;
    if (state.failed) { free(state.text); snprintf(res.error_message, sizeof(res.error_message), "Native search output allocation failed."); return res; }
    const char *scope = state.completed ? "complete" : "incomplete (5000-file limit; narrow path or filename)";
    res.output = (char *)malloc(state.used + strlen(root) + 240);
    if (res.output) snprintf(res.output, state.used + strlen(root) + 240, "Found %d matches in %s (scanned %d files, %s):\n%s", state.results, root, state.scanned, scope, state.text);
    free(state.text);
    char *truncated = truncate_output(res.output);
    free(res.output);
    res.output = truncated;
    if (!res.output) { snprintf(res.error_message, sizeof(res.error_message), "Out of memory."); return res; }
    res.output_len = strlen(res.output); res.success = true; return res;
}

ToolResult tool_run_command_cancellable(const char *command, const char *working_directory, const SafetyContext *safety_ctx, int timeout_ms, volatile long *cancel_requested) {
    ToolResult res; memset(&res, 0, sizeof(res));
    if (!command || !*command) { snprintf(res.error_message, sizeof(res.error_message), "Command cannot be empty."); return res; }
    if (touches_private_data(command) ||
        (working_directory && *working_directory && touches_private_data(working_directory)) ||
        (safety_ctx && safety_ctx->working_directory[0] && touches_private_data(safety_ctx->working_directory))) {
        snprintf(res.error_message, sizeof(res.error_message), "Access denied: command touches private data.");
        trim_incomplete_utf8(res.error_message);
        return res;
    }
    bool is_approved = safety_ctx && safety_ctx->approved;
    SafetyVerdict v = audit_hard_lines(command);
    if (v.tier == SAFETY_TIER_BLOCKED) {
        snprintf(res.error_message, sizeof(res.error_message), "BLOCKED: %s", v.reason);
        trim_incomplete_utf8(res.error_message);
        return res;
    }
    if (v.tier == SAFETY_TIER_HARD && !is_approved) {
        snprintf(res.error_message, sizeof(res.error_message), "HARD_APPROVAL_REQUIRED: %s", v.reason);
        trim_incomplete_utf8(res.error_message);
        return res;
    }
    if (safety_ctx && safety_ctx->autonomy == AUTONOMY_STRICT && !is_approved) {
        snprintf(res.error_message, sizeof(res.error_message), "APPROVAL_REQUIRED: Strict mode requires manual approval for command execution.");
        trim_incomplete_utf8(res.error_message);
        return res;
    }
    if (timeout_ms <= 0 || timeout_ms > 300000) timeout_ms = 60000;
    const char *cwd = (working_directory && *working_directory) ? working_directory :
                      (safety_ctx && safety_ctx->working_directory[0] ? safety_ctx->working_directory : ".");
    int before_count = count_top_level_entries(cwd);
    NativeProcessResult process = native_run_process_cancellable(command, cwd, timeout_ms, cancel_requested);
    if (!process.started) {
        snprintf(res.error_message, sizeof(res.error_message), "%s", process.error[0] ? process.error : "Failed to start command.");
        trim_incomplete_utf8(res.error_message);
        native_process_result_free(&process);
        return res;
    }
    int after_count = before_count > 0 ? count_top_level_entries(cwd) : before_count;
    bool fuse_tripped = (before_count > 0 && after_count <= 0);
    size_t n = process.output ? strlen(process.output) : 0;
    const char *fuse_msg = fuse_tripped ? "\n\n⚠️ 安全保险丝触发：检测到命令执行后工作区顶层条目被清空（执行前 > 0，执行后 = 0），已立即熔断后续操作。" : "";
    size_t display_cap = strlen(command) + n + strlen(fuse_msg) + 400;
    char *display = (char *)malloc(display_cap);
    if (display) snprintf(display, display_cap, "$ %s\n\n--- exit code %lu ---\n%s%s%s%s", command, process.exit_code, process.output ? process.output : "", process.error[0] ? "\n\n" : "", process.error, fuse_msg);
    res.output = truncate_output(display ? display : ""); free(display); native_process_result_free(&process);
    if (!res.output) { snprintf(res.error_message, sizeof(res.error_message), "Out of memory."); return res; }
    res.output_len = strlen(res.output);
    if (fuse_tripped) {
        res.success = false;
        snprintf(res.error_message, sizeof(res.error_message), "⚠️ 安全保险丝触发：检测到命令执行后工作区顶层条目被清空（执行前 %d 项，执行后 0 项），已立即熔断后续操作。", before_count);
        trim_incomplete_utf8(res.error_message);
        return res;
    }
    res.success = !process.timed_out;
    if (!res.success) {
        if (process.error[0]) snprintf(res.error_message, sizeof(res.error_message), "%s", process.error);
        else snprintf(res.error_message, sizeof(res.error_message), "Command timed out or cancelled (exit code %lu)", process.exit_code);
        trim_incomplete_utf8(res.error_message);
    }
    return res;
}

ToolResult tool_run_command_ex(const char *command, const char *working_directory, const SafetyContext *safety_ctx, int timeout_ms) {
    return tool_run_command_cancellable(command, working_directory, safety_ctx, timeout_ms, NULL);
}

ToolResult tool_run_command(const char *command, const char *working_directory, const SafetyContext *safety_ctx) {
    return tool_run_command_ex(command, working_directory, safety_ctx, 60000);
}
