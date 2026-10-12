#!/usr/bin/env bash
# Builds the modified FireRed ROM with the project-local toolchain
# (see scripts/setup-macos.sh). The website never ships this ROM: run
# scripts/build-patches.sh next to turn it into patches for web/game/.
#
#   scripts/build-rom.sh            # normal build
#   scripts/build-rom.sh clean      # any extra args are passed to make
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TC="$ROOT/.toolchain"
GAME="$ROOT/pokefirered"

if [ ! -x "$TC/arm-none-eabi/bin/arm-none-eabi-gcc" ]; then
  echo "Toolchain missing. Run scripts/setup-macos.sh first."; exit 1
fi

# gbagfx asks pkg-config for libpng; clang also honours these variables,
# which lets it find our static libpng without pkg-config/Homebrew.
export CPATH="$TC/libpng/include${CPATH:+:$CPATH}"
export LIBRARY_PATH="$TC/libpng/lib${LIBRARY_PATH:+:$LIBRARY_PATH}"
# A no-op pkg-config so the tool Makefiles don't print "command not found".
export PATH="$ROOT/scripts/shims:$PATH"

JOBS="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

if [ "$#" -gt 0 ]; then
  make -C "$GAME" -j"$JOBS" TOOLCHAIN="$TC/arm-none-eabi" MODERN=1 "$@"
  exit 0
fi

make -C "$GAME" -j"$JOBS" TOOLCHAIN="$TC/arm-none-eabi" MODERN=1

ROM="$GAME/pokefirered_modern.gba"
# Older versions of this script copied the ROM into web/game/; make sure no
# copy is left where it could be deployed.
rm -f "$ROOT/web/game/dailyred.gba.gz" "$ROOT/web/game/dailyred.gba" "$ROOT/web/game/red.png"
echo
echo "Built $ROM"
echo "Next: scripts/build-patches.sh (the patches the website ships)"
