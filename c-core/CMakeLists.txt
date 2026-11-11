cmake_minimum_required(VERSION 3.15)
project(shangbo_agent_c C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

include_directories(include)

if(MSVC)
    add_compile_options(/W3 /D_CRT_SECURE_NO_WARNINGS /utf-8)
else()
    add_compile_options(-Wall -Wextra -O2)
endif()

set(CORE_SOURCES
    src/safety.c
    src/command_guard.c
    src/injection_detector.c
    src/loop_guard.c
    src/stream_processor.c
    src/tools.c
    src/agent_runtime.c
    src/json_rpc.c
)

add_library(shangbo_core STATIC ${CORE_SOURCES})

add_executable(shangbo_agent src/main.c)
target_link_libraries(shangbo_agent PRIVATE shangbo_core)

enable_testing()
add_executable(test_runner
    tests/test_runner.c
    tests/test_safety.c
    tests/test_command_guard.c
    tests/test_injection.c
    tests/test_stream_processor.c
    tests/test_loop_guard.c
    tests/test_tools.c
    tests/test_agent_runtime.c
    tests/test_json_rpc.c
)
target_link_libraries(test_runner PRIVATE shangbo_core)
add_test(NAME CTestSuite COMMAND test_runner)
