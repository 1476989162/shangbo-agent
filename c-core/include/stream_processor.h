#ifndef SANGBO_AGENT_STREAM_PROCESSOR_H
#define SANGBO_AGENT_STREAM_PROCESSOR_H

#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef void (*StreamOutputCallback)(const char *content, size_t length, void *user_data);

typedef struct {
    bool in_think_tag;
    char tag_buffer[16];
    size_t tag_buffer_len;
    StreamOutputCallback on_text;
    StreamOutputCallback on_reasoning;
    void *user_data;
} StreamProcessor;

void stream_processor_init(StreamProcessor *sp, StreamOutputCallback on_text, StreamOutputCallback on_reasoning, void *user_data);
void stream_processor_feed(StreamProcessor *sp, const char *chunk, size_t chunk_len);
void stream_processor_flush(StreamProcessor *sp);
void stream_processor_reset(StreamProcessor *sp);

#ifdef __cplusplus
}
#endif

#endif /* SANGBO_AGENT_STREAM_PROCESSOR_H */
