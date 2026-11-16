CC ?= gcc
CFLAGS ?= -Wall -Wextra -O2 -Iinclude -std=c11
BINDIR = bin
OBJDIR = obj

SRCS = src/safety.c src/command_guard.c src/injection_detector.c src/loop_guard.c src/stream_processor.c src/tools.c src/agent_runtime.c src/json_rpc.c src/native_process.c
OBJS = $(SRCS:src/%.c=$(OBJDIR)/%.o)

TEST_SRCS = tests/test_runner.c tests/test_safety.c tests/test_command_guard.c tests/test_injection.c tests/test_stream_processor.c tests/test_loop_guard.c tests/test_tools.c tests/test_agent_runtime.c tests/test_json_rpc.c
TEST_OBJS = $(TEST_SRCS:tests/%.c=$(OBJDIR)/%.o)

all: $(BINDIR)/shangbo_agent $(BINDIR)/test_runner

$(OBJDIR)/%.o: src/%.c | $(OBJDIR)
	$(CC) $(CFLAGS) -c $< -o $@

$(OBJDIR)/%.o: tests/%.c | $(OBJDIR)
	$(CC) $(CFLAGS) -c $< -o $@

$(BINDIR)/shangbo_agent: $(OBJDIR)/main.o $(OBJS) | $(BINDIR)
	$(CC) $(CFLAGS) -o $@ $^

$(BINDIR)/test_runner: $(TEST_OBJS) $(OBJS) | $(BINDIR)
	$(CC) $(CFLAGS) -o $@ $^

test: $(BINDIR)/test_runner
	./$(BINDIR)/test_runner

$(BINDIR):
	mkdir -p $(BINDIR)

$(OBJDIR):
	mkdir -p $(OBJDIR)

clean:
	rm -rf $(BINDIR) $(OBJDIR)

.PHONY: all test clean
