cmake_minimum_required(VERSION 3.25)
project(seatrace_simulator VERSION 1.0.0 DESCRIPTION "SeaTrace vessel simulator and OPC UA server"
        LANGUAGES C CXX)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(SEATRACE_BUILD_TESTS "Build the unit and integration tests" ON)

include(cmake/CompilerWarnings.cmake)
include(cmake/Dependencies.cmake)

# ---------------------------------------------------------------------------------------------
# seatrace_sim_core: simulation model, configuration, logging. No OPC UA dependency.
# ---------------------------------------------------------------------------------------------
add_library(seatrace_sim_core STATIC
  src/core/bilge_system.cpp
  src/core/config.cpp
  src/core/cooling_system.cpp
  src/core/equipment.cpp
  src/core/equipment_types.cpp
  src/core/generator.cpp
  src/core/logger.cpp
  src/core/main_engine.cpp
  src/core/params.cpp
  src/core/rng.cpp
  src/core/scenario.cpp
  src/core/sensor.cpp
  src/core/settings.cpp
  src/core/sim_time.cpp
  src/core/simulation.cpp
  src/core/vessel.cpp)
target_include_directories(seatrace_sim_core PUBLIC src)
target_link_libraries(seatrace_sim_core PUBLIC nlohmann_json::nlohmann_json)
seatrace_enable_warnings(seatrace_sim_core)

# ---------------------------------------------------------------------------------------------
# seatrace_sim_opcua: address space, method handlers, security and the server run loop.
# ---------------------------------------------------------------------------------------------
add_library(seatrace_sim_opcua STATIC
  src/opcua/access_control.cpp
  src/opcua/address_space.cpp
  src/opcua/method_handlers.cpp
  src/opcua/runner.cpp
  src/opcua/security.cpp
  src/opcua/server.cpp
  src/opcua/status_mapping.cpp)
target_include_directories(seatrace_sim_opcua PUBLIC src)
target_link_libraries(seatrace_sim_opcua PUBLIC seatrace_sim_core open62541::open62541)
seatrace_enable_warnings(seatrace_sim_opcua)

# ---------------------------------------------------------------------------------------------
# Executable
# ---------------------------------------------------------------------------------------------
add_executable(seatrace_simulator src/app/main.cpp)
target_link_libraries(seatrace_simulator PRIVATE seatrace_sim_opcua)
seatrace_enable_warnings(seatrace_simulator)

# ---------------------------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------------------------
if(SEATRACE_BUILD_TESTS)
  enable_testing()
  include(GoogleTest)
  add_subdirectory(tests)
endif()
