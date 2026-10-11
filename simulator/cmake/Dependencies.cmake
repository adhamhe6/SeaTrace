# Third-party dependencies, fetched with pinned git tags (no tarball downloads).
#
# Every dependency can be redirected to a local checkout, e.g. for offline builds:
#   -DFETCHCONTENT_SOURCE_DIR_OPEN62541=/path/to/open62541
#   -DFETCHCONTENT_SOURCE_DIR_GOOGLETEST=/path/to/googletest
#   -DFETCHCONTENT_SOURCE_DIR_NLOHMANN_JSON=/path/to/json

include(FetchContent)

set(FETCHCONTENT_QUIET OFF)

# --- nlohmann_json -----------------------------------------------------------
set(JSON_BuildTests OFF CACHE INTERNAL "")
set(JSON_Install OFF CACHE INTERNAL "")
FetchContent_Declare(
  nlohmann_json
  GIT_REPOSITORY https://github.com/nlohmann/json.git
  GIT_TAG v3.12.0
  GIT_SHALLOW TRUE
  SYSTEM)

# --- open62541 ---------------------------------------------------------------
# Single-threaded server, static library, OpenSSL based encryption (system OpenSSL 3).
# Only the core server is needed, so no submodules are initialised.
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(UA_ENABLE_ENCRYPTION "OPENSSL" CACHE STRING "" FORCE)
set(UA_MULTITHREADING 0 CACHE STRING "" FORCE)
set(UA_NAMESPACE_ZERO "REDUCED" CACHE STRING "" FORCE)
set(UA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(UA_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
set(UA_BUILD_UNIT_TESTS OFF CACHE BOOL "" FORCE)
set(UA_ENABLE_AMALGAMATION OFF CACHE BOOL "" FORCE)
set(UA_ENABLE_PUBSUB OFF CACHE BOOL "" FORCE)
set(UA_ENABLE_PUBSUB_INFORMATIONMODEL OFF CACHE BOOL "" FORCE)
set(UA_ENABLE_HISTORIZING OFF CACHE BOOL "" FORCE)
set(UA_ENABLE_DISCOVERY OFF CACHE BOOL "" FORCE)
set(UA_ENABLE_DISCOVERY_MULTICAST OFF CACHE BOOL "" FORCE)
set(UA_ENABLE_DA OFF CACHE BOOL "" FORCE)
set(UA_ENABLE_DIAGNOSTICS OFF CACHE BOOL "" FORCE)
set(UA_ENABLE_JSON_ENCODING OFF CACHE BOOL "" FORCE)
set(UA_FORCE_WERROR OFF CACHE BOOL "" FORCE)
FetchContent_Declare(
  open62541
  GIT_REPOSITORY https://github.com/open62541/open62541.git
  GIT_TAG v1.4.21
  GIT_SHALLOW TRUE
  GIT_SUBMODULES ""
  SYSTEM)

# --- GoogleTest --------------------------------------------------------------
if(SEATRACE_BUILD_TESTS)
  set(INSTALL_GTEST OFF CACHE BOOL "" FORCE)
  set(gtest_force_shared_crt ON CACHE BOOL "" FORCE)
  FetchContent_Declare(
    googletest
    GIT_REPOSITORY https://github.com/google/googletest.git
    GIT_TAG v1.17.0
    GIT_SHALLOW TRUE
    SYSTEM)
  FetchContent_MakeAvailable(googletest)
endif()

FetchContent_MakeAvailable(nlohmann_json open62541)
