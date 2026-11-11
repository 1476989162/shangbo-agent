#include "../include/stream_processor.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char THINK_OPEN[] = "<think>";
static const size_t THINK_OPEN_LEN = 7;
static const char THINK_CLOSE[] = "</think>";
static const size_t THINK_CLOSE_LEN = 8;

void stream_processor_init(StreamProcessor *sp, StreamOutputCallback on_text, StreamOutputCallback on_reasoning, void *user_data) {
    if (!sp) return;
    memset(sp, 0, sizeof(StreamProcessor));
    sp->in_think_tag = false;
    sp->on_text = on_text;
    sp->on_reasoning = on_reasoning;
    sp->user_data = user_data;
}

void stream_processor_reset(StreamProcessor *sp) {
    if (!sp) return;
    sp->in_think_tag = false;
    sp->tag_buffer[0] = '\0';
    sp->tag_buffer_len = 0;
}

static void emit_text(StreamProcessor *sp, const char *text, size_t len) {
    if (len > 0 && sp->on_text) {
        sp->on_text(text, len, sp->user_data);
    }
}

static void emit_reasoning(StreamProcessor *sp, const char *text, size_t len) {
    if (len > 0 && sp->on_reasoning) {
        sp->on_reasoning(text, len, sp->user_data);
    }
}

void stream_processor_feed(StreamProcessor *sp, const char *chunk, size_t chunk_len) {
    if (!sp || !chunk || chunk_len == 0) return;

    /* Combine tag_buffer with incoming chunk */
    size_t total_len = sp->tag_buffer_len + chunk_len;
    char *current = (char *)malloc(total_len + 1);
    if (!current) return;

    if (sp->tag_buffer_len > 0) {
        memcpy(current, sp->tag_buffer, sp->tag_buffer_len);
    }
    memcpy(current + sp->tag_buffer_len, chunk, chunk_len);
    current[total_len] = '\0';

    sp->tag_buffer[0] = '\0';
    sp->tag_buffer_len = 0;

    size_t curr_pos = 0;

    while (curr_pos < total_len) {
        const char *cur_str = current + curr_pos;
        size_t cur_rem = total_len - curr_pos;

        if (!sp->in_think_tag) {
            const char *start_ptr = strstr(cur_str, THINK_OPEN);
            if (start_ptr == NULL) {
                /* Check if a suffix of cur_str matches a prefix of "<think>" */
                size_t partial_len = 0;
                size_t max_check = (cur_rem < THINK_OPEN_LEN - 1) ? cur_rem : (THINK_OPEN_LEN - 1);
                for (size_t check_len = max_check; check_len >= 1; --check_len) {
                    const char *sub = cur_str + (cur_rem - check_len);
                    if (strncmp(THINK_OPEN, sub, check_len) == 0) {
                        partial_len = check_len;
                        break;
                    }
                }

                if (partial_len > 0) {
                    emit_text(sp, cur_str, cur_rem - partial_len);
                    memcpy(sp->tag_buffer, cur_str + (cur_rem - partial_len), partial_len);
                    sp->tag_buffer_len = partial_len;
                    sp->tag_buffer[partial_len] = '\0';
                } else {
                    emit_text(sp, cur_str, cur_rem);
                }
                break;
            } else {
                size_t text_len = (size_t)(start_ptr - cur_str);
                emit_text(sp, cur_str, text_len);
                sp->in_think_tag = true;
                curr_pos += text_len + THINK_OPEN_LEN;
            }
        } else {
            const char *end_ptr = strstr(cur_str, THINK_CLOSE);
            if (end_ptr == NULL) {
                /* Check if a suffix of cur_str matches a prefix of "</think>" */
                size_t partial_len = 0;
                size_t max_check = (cur_rem < THINK_CLOSE_LEN - 1) ? cur_rem : (THINK_CLOSE_LEN - 1);
                for (size_t check_len = max_check; check_len >= 1; --check_len) {
                    const char *sub = cur_str + (cur_rem - check_len);
                    if (strncmp(THINK_CLOSE, sub, check_len) == 0) {
                        partial_len = check_len;
                        break;
                    }
                }

                if (partial_len > 0) {
                    emit_reasoning(sp, cur_str, cur_rem - partial_len);
                    memcpy(sp->tag_buffer, cur_str + (cur_rem - partial_len), partial_len);
                    sp->tag_buffer_len = partial_len;
                    sp->tag_buffer[partial_len] = '\0';
                } else {
                    emit_reasoning(sp, cur_str, cur_rem);
                }
                break;
            } else {
                size_t reason_len = (size_t)(end_ptr - cur_str);
                emit_reasoning(sp, cur_str, reason_len);
                sp->in_think_tag = false;
                curr_pos += reason_len + THINK_CLOSE_LEN;
            }
        }
    }

    free(current);
}

void stream_processor_flush(StreamProcessor *sp) {
    if (!sp || sp->tag_buffer_len == 0) return;

    if (sp->in_think_tag) {
        emit_reasoning(sp, sp->tag_buffer, sp->tag_buffer_len);
    } else {
        emit_text(sp, sp->tag_buffer, sp->tag_buffer_len);
    }
    sp->tag_buffer[0] = '\0';
    sp->tag_buffer_len = 0;
}
