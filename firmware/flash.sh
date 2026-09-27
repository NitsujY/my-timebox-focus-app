#!/bin/sh
# build + flash in one step; any args pass through to pio (e.g. ./flash.sh -t monitor)
set -e
cd "$(dirname "$0")"
pio run -t upload "$@"
