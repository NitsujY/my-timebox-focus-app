cmake_minimum_required(VERSION 3.16.0)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(firmware)

# IDF4's toolchain defaults to -Werror=all; under GCC 8.4 that turns benign
# notes in NimBLE (ble_hs.h int-in-bool-context) and app snprintf into hard
# errors the prebuilt-core build never enforced. Demote just those to warnings.
idf_build_set_property(COMPILE_OPTIONS "-Wno-error=int-in-bool-context" APPEND)
idf_build_set_property(COMPILE_OPTIONS "-Wno-error=format-truncation" APPEND)
idf_build_set_property(COMPILE_OPTIONS "-Wno-error=maybe-uninitialized" APPEND)
idf_build_set_property(COMPILE_OPTIONS "-Wno-error=char-subscripts" APPEND)

