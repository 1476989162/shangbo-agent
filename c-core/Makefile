CC ?= gcc
CFLAGS ?= -Wall -Wextra -O2 -Iinclude -std=c11
# 严格 -std=c11 会隐匿 POSIX 扩展声明（strdup/lstat/dirent 等），
# 非 Windows 编译必须显式开启 _GNU_SOURCE 与 pthread；
# Windows（nmake/MinGW 直接调 make）下这两个标志无意义甚至报错，故按 OS 变量条件赋值。
ifneq ($(OS),Windows_NT)
UNIXONLY := -D_GNU_SOURCE -pthread
endif
BINDIR = bin
OBJDIR = obj

SRCS = src/safety.c src/command_guard.c src/injection_detector.c src/loop_guard.c src/stream_processor.c src/tools.c src/agent_runtime.c src/json_rpc.c src/native_process.c
OBJS = $(SRCS:src/%.c=$(OBJDIR)/%.o)

TEST_SRCS = tests/test_runner.c tests/test_safety.c tests/test_command_guard.c tests/test_injection.c tests/test_stream_processor.c tests/test_loop_guard.c tests/test_tools.c tests/test_agent_runtime.c tests/test_json_rpc.c
TEST_OBJS = $(TEST_SRCS:tests/%.c=$(OBJDIR)/%.o)

all: $(BINDIR)/shangbo_agent $(BINDIR)/test_runner

$(OBJDIR)/%.o: src/%.c | $(OBJDIR)
	$(CC) $(CFLAGS) $(UNIXONLY) -c $< -o $@

$(OBJDIR)/%.o: tests/%.c | $(OBJDIR)
	$(CC) $(CFLAGS) $(UNIXONLY) -c $< -o $@

$(BINDIR)/shangbo_agent: $(OBJDIR)/main.o $(OBJS) | $(BINDIR)
	$(CC) $(CFLAGS) $(UNIXONLY) -o $@ $^

$(BINDIR)/test_runner: $(TEST_OBJS) $(OBJS) | $(BINDIR)
	$(CC) $(CFLAGS) $(UNIXONLY) -o $@ $^

test: $(BINDIR)/test_runner
	./$(BINDIR)/test_runner

$(BINDIR):
	mkdir -p $(BINDIR)

$(OBJDIR):
	mkdir -p $(OBJDIR)

clean:
	rm -rf $(BINDIR) $(OBJDIR)

.PHONY: all test clean
