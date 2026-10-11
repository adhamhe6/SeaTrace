add_executable(seatrace_sim_tests
  config_test.cpp
  determinism_test.cpp
  equipment_test.cpp
  logger_test.cpp
  opcua_security_test.cpp
  opcua_server_test.cpp
  rng_test.cpp
  scenario_effects_test.cpp
  scenario_manager_test.cpp
  settings_test.cpp)
target_compile_definitions(seatrace_sim_tests PRIVATE
  SEATRACE_FLEET_CONFIG="${PROJECT_SOURCE_DIR}/config/fleet.json")
target_link_libraries(seatrace_sim_tests PRIVATE seatrace_sim_opcua GTest::gtest_main GTest::gmock)
seatrace_enable_warnings(seatrace_sim_tests)

# Each test case is its own ctest entry (they start in-process servers on free ports, so they
# can run in parallel). The generous timeout covers the slower real-time OPC UA tests.
gtest_discover_tests(seatrace_sim_tests DISCOVERY_TIMEOUT 60 PROPERTIES TIMEOUT 120)
