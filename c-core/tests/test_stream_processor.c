#include "test_framework.h"
#include "../include/stream_processor.h"
#include <stdlib.h>
#include <string.h>

typedef struct {
    char text_buf[4096];
    size_t text_len;
    char reasoning_buf[4096];
    size_t reasoning_len;
    int text_call_count;
    int reasoning_call_count;
} TestStreamContext;

static void test_on_text(const char *content, size_t len, void *user_data) {
    TestStreamContext *ctx = (TestStreamContext *)user_data;
    if (ctx->text_len + len < sizeof(ctx->text_buf)) {
        memcpy(ctx->text_buf + ctx->text_len, content, len);
        ctx->text_len += len;
        ctx->text_buf[ctx->text_len] = '\0';
    }
    ctx->text_call_count++;
}

static void test_on_reasoning(const char *content, size_t len, void *user_data) {
    TestStreamContext *ctx = (TestStreamContext *)user_data;
    if (ctx->reasoning_len + len < sizeof(ctx->reasoning_buf)) {
        memcpy(ctx->reasoning_buf + ctx->reasoning_len, content, len);
        ctx->reasoning_len += len;
        ctx->reasoning_buf[ctx->reasoning_len] = '\0';
    }
    ctx->reasoning_call_count++;
}

TEST_CASE(test_boost_split_chunk_think_tag_isolation) {
    /* Exact test case from boostVerification.test.ts:
     * Chunk 1: "前置文本 <th"
     * Chunk 2: "ink>思考内容</th"
     * Chunk 3: "ink>后续正文"
     */
    TestStreamContext ctx;
    memset(&ctx, 0, sizeof(ctx));

    StreamProcessor sp;
    stream_processor_init(&sp, test_on_text, test_on_reasoning, &ctx);

    const char *c1 = "前置文本 <th";
    stream_processor_feed(&sp, c1, strlen(c1));
    ASSERT_EQ_STR(ctx.text_buf, "前置文本 ");
    ASSERT_EQ_INT(ctx.reasoning_len, 0);

    const char *c2 = "ink>思考内容</th";
    stream_processor_feed(&sp, c2, strlen(c2));
    ASSERT_EQ_STR(ctx.text_buf, "前置文本 ");
    ASSERT_EQ_STR(ctx.reasoning_buf, "思考内容");

    const char *c3 = "ink>后续正文";
    stream_processor_feed(&sp, c3, strlen(c3));
    stream_processor_flush(&sp);

    ASSERT_EQ_STR(ctx.text_buf, "前置文本 后续正文");
    ASSERT_EQ_STR(ctx.reasoning_buf, "思考内容");

    /* Verify no think tags leaked into text */
    ASSERT_TRUE(strstr(ctx.text_buf, "<think>") == NULL);
    ASSERT_TRUE(strstr(ctx.text_buf, "</think>") == NULL);
    ASSERT_TRUE(strstr(ctx.text_buf, "<th") == NULL);
    ASSERT_TRUE(strstr(ctx.text_buf, "ink>") == NULL);
}

TEST_CASE(test_stream_normal_text_without_think) {
    TestStreamContext ctx;
    memset(&ctx, 0, sizeof(ctx));

    StreamProcessor sp;
    stream_processor_init(&sp, test_on_text, test_on_reasoning, &ctx);

    const char *m1 = "Hello world, ";
    const char *m2 = "this is standard output.";
    stream_processor_feed(&sp, m1, strlen(m1));
    stream_processor_feed(&sp, m2, strlen(m2));
    stream_processor_flush(&sp);

    ASSERT_EQ_STR(ctx.text_buf, "Hello world, this is standard output.");
    ASSERT_EQ_INT(ctx.reasoning_len, 0);
}

TEST_CASE(test_stream_complete_think_block) {
    TestStreamContext ctx;
    memset(&ctx, 0, sizeof(ctx));

    StreamProcessor sp;
    stream_processor_init(&sp, test_on_text, test_on_reasoning, &ctx);

    const char *block = "Answer prefix: <think>detailed deep reasoning steps</think> final result.";
    stream_processor_feed(&sp, block, strlen(block));
    stream_processor_flush(&sp);

    ASSERT_EQ_STR(ctx.text_buf, "Answer prefix:  final result.");
    ASSERT_EQ_STR(ctx.reasoning_buf, "detailed deep reasoning steps");
}

void run_stream_processor_tests(void) {
    printf("\n=== Running Stream Chunk & Think Tag Isolator Tests (Boost Spec) ===\n");
    RUN_TEST(test_boost_split_chunk_think_tag_isolation);
    RUN_TEST(test_stream_normal_text_without_think);
    RUN_TEST(test_stream_complete_think_block);
}
