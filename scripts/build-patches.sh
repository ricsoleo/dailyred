#!/usr/bin/env bash
# Builds the patches the website ships instead of the ROM: one BPS patch per
# supported FireRed release, turning the player's own ROM into Daily Red.
#
#   scripts/build-rom.sh        # first: builds pokefirered/pokefirered_modern.gba
#   scripts/build-patches.sh    # writes web/game/*.bps.gz and web/game/patches.json
#
# To make them we need the original ROMs, and we build those too: pret's
# decompilation compiled with agbcc (the original compiler, pret/agbcc) gives
# byte-for-byte copies of FireRed v1.0 and v1.1, checked against their SHA-1s.
# They stay in .retail/ and are never part of the website.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TC="$ROOT/.toolchain"
RETAIL="$ROOT/.retail/pokefirered"
AGBCC_URL="https://github.com/pret/agbcc.git"
AGBCC_COMMIT="da598c1d918402c42c0c0d7128ba14567f3175e9"
PRET_COMMIT="$(sed -n 's/^PRET_COMMIT="\(.*\)"$/\1/p' "$ROOT/scripts/get-pokefirered.sh")"

if [ ! -x "$TC/arm-none-eabi/bin/arm-none-eabi-gcc" ]; then
  echo "Toolchain missing. Run scripts/setup-macos.sh first."; exit 1
fi
if [ ! -f "$ROOT/pokefirered/pokefirered_modern.gba" ]; then
  echo "Daily Red ROM missing. Run scripts/build-rom.sh first."; exit 1
fi

export PATH="$TC/arm-none-eabi/bin:$ROOT/scripts/shims:$PATH"
export CPATH="$TC/libpng/include${CPATH:+:$CPATH}"
export LIBRARY_PATH="$TC/libpng/lib${LIBRARY_PATH:+:$LIBRARY_PATH}"
JOBS="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

# --- agbcc ---------------------------------------------------------------------
if [ ! -x "$TC/agbcc/agbcc" ]; then
  echo ">> Building agbcc @ ${AGBCC_COMMIT:0:10}"
  rm -rf "$TC/agbcc"
  git init -q "$TC/agbcc"
  git -C "$TC/agbcc" remote add origin "$AGBCC_URL"
  git -C "$TC/agbcc" fetch -q --depth 1 origin "$AGBCC_COMMIT"
  git -C "$TC/agbcc" checkout -q FETCH_HEAD
  (cd "$TC/agbcc" && ./build.sh > build.log 2>&1) || { echo "agbcc build failed, see $TC/agbcc/build.log"; exit 1; }
fi

# --- Original ROMs ---------------------------------------------------------------
if [ ! -d "$RETAIL" ]; then
  echo ">> Unmodified pret/pokefirered @ ${PRET_COMMIT:0:10}"
  git init -q "$RETAIL"
  git -C "$RETAIL" fetch -q --depth 1 "$ROOT/pokefirered" "$PRET_COMMIT"
  git -C "$RETAIL" checkout -q FETCH_HEAD
  (cd "$TC/agbcc" && ./install.sh "$RETAIL" > /dev/null)
fi
for target in compare_firered compare_firered_rev1; do
  echo ">> make $target"
  make -C "$RETAIL" -j"$JOBS" TOOLCHAIN="$TC/arm-none-eabi" "$target" > "$ROOT/.retail/$target.log" 2>&1 \
    || { echo "Build failed, see .retail/$target.log"; exit 1; }
  tail -1 "$ROOT/.retail/$target.log"
done

# --- Patches -----------------------------------------------------------------------
node "$ROOT/scripts/make-patches.mjs" \
  "$RETAIL/pokefirered.gba" "$RETAIL/pokefirered_rev1.gba" \
  "$ROOT/pokefirered/pokefirered_modern.gba" "$ROOT/pokefirered/pokefirered_modern.elf" \
  "$ROOT/web/game"
