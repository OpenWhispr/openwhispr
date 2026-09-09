cmake_minimum_required(VERSION 3.26)
project(orukeet_openwhispr_sidecar VERSION 0.1.0 LANGUAGES C CXX)

set(ORUKEET_SDK_ROOT "" CACHE PATH "Extracted pinned NeMo-Speech.cpp v0.1.0 SDK")
if(NOT IS_DIRECTORY "${ORUKEET_SDK_ROOT}")
  message(FATAL_ERROR "Set ORUKEET_SDK_ROOT to the extracted v0.1.0 SDK")
endif()
find_package(NeMoSpeech 0.1.0 EXACT REQUIRED COMPONENTS ASR
  PATHS "${ORUKEET_SDK_ROOT}/lib/cmake/NeMoSpeech" NO_DEFAULT_PATH)

add_library(orukeet_cjson STATIC third_party/cjson/cJSON.c)
target_include_directories(orukeet_cjson PUBLIC third_party/cjson)
target_compile_definitions(orukeet_cjson PRIVATE CJSON_NESTING_LIMIT=16)
add_executable(orukeet-sidecar sidecar.cpp)
target_compile_features(orukeet-sidecar PRIVATE cxx_std_17)
target_link_libraries(orukeet-sidecar PRIVATE NeMoSpeech::ASR orukeet_cjson)
if(WIN32)
  target_link_libraries(orukeet-sidecar PRIVATE shell32)
endif()
if(MSVC)
  target_compile_options(orukeet-sidecar PRIVATE /W4 /utf-8)
else()
  target_compile_options(orukeet-sidecar PRIVATE -Wall -Wextra -Wpedantic)
endif()
if(APPLE)
  set_target_properties(orukeet-sidecar PROPERTIES
    BUILD_RPATH "${ORUKEET_SDK_ROOT}/lib" INSTALL_RPATH "@loader_path/../lib")
elseif(UNIX)
  set_target_properties(orukeet-sidecar PROPERTIES
    BUILD_RPATH "${ORUKEET_SDK_ROOT}/lib" INSTALL_RPATH "$ORIGIN/../lib")
  target_link_options(orukeet-sidecar PRIVATE "LINKER:--allow-shlib-undefined")
endif()

install(TARGETS orukeet-sidecar RUNTIME DESTINATION bin)
if(WIN32)
  install(PROGRAMS "${ORUKEET_SDK_ROOT}/bin/nemo-speech.exe" DESTINATION bin RENAME orukeet-device-info.exe)
else()
  install(PROGRAMS "${ORUKEET_SDK_ROOT}/bin/nemo-speech" DESTINATION bin RENAME orukeet-device-info)
endif()
if(WIN32)
  install(DIRECTORY "${ORUKEET_SDK_ROOT}/bin/" DESTINATION bin
    USE_SOURCE_PERMISSIONS FILES_MATCHING PATTERN "*.dll")
else()
  install(DIRECTORY "${ORUKEET_SDK_ROOT}/lib/" DESTINATION lib
    USE_SOURCE_PERMISSIONS PATTERN "cmake" EXCLUDE
    # The SDK bundles an older GCC runtime; use the target system runtime
    # matched to this build toolchain instead of shadowing it on Linux.
    PATTERN "libstdc++*" EXCLUDE PATTERN "libgcc_s*" EXCLUDE)
endif()
install(DIRECTORY "${ORUKEET_SDK_ROOT}/share/licenses/" DESTINATION share/licenses
  OPTIONAL)
install(FILES third_party/cjson/LICENSE DESTINATION share/licenses/cjson)
