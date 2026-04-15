cmake_minimum_required(VERSION 3.16)
project(meeting_aec_helper LANGUAGES C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT DEFINED MEETING_AEC_GENERATED_CMAKE)
  message(FATAL_ERROR "MEETING_AEC_GENERATED_CMAKE must point to a generated source manifest")
endif()

include(${MEETING_AEC_GENERATED_CMAKE})

add_executable(
  meeting-aec-helper
  src/main.cc
  src/aec_processor.cc
  src/null_aec_dump_factory.cc
  ${MEETING_AEC_WEBRTC_SOURCES}
  ${MEETING_AEC_ABSL_SOURCES}
  ${MEETING_AEC_AVX2_SOURCES}
)

target_include_directories(
  meeting-aec-helper
  PRIVATE
  src
  ${MEETING_AEC_INCLUDE_DIRS}
)

target_compile_definitions(meeting-aec-helper PRIVATE ${MEETING_AEC_DEFINES})
target_compile_options(meeting-aec-helper PRIVATE ${MEETING_AEC_COMPILE_OPTIONS})
target_link_options(meeting-aec-helper PRIVATE ${MEETING_AEC_LINK_OPTIONS})

if(MEETING_AEC_AVX2_SOURCES AND MEETING_AEC_AVX2_COMPILE_OPTIONS)
  set_source_files_properties(
    ${MEETING_AEC_AVX2_SOURCES}
    PROPERTIES COMPILE_OPTIONS "${MEETING_AEC_AVX2_COMPILE_OPTIONS}"
  )
endif()
