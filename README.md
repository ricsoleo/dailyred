# Daily Red

A daily Pokémon battle in the browser, like Wordle: once a day you press
**Play**, get the day's six random level 100 Pokémon from Generations 1–3
(everyone gets the same team that day), and climb to RED at the top of the
mountain. Your first battle of the day is the one that counts; after it you
can rematch the day's team as often as you like, just for fun. You play as a
trainer with a name and an ID; your wins, losses, win streak and daily play
streak are kept on the server, and the **Hall of Fame** shows today's
champions, the most wins and the longest win streaks.

Every battle runs on the original Pokémon FireRed engine: the game is the
[pret/pokefirered](https://github.com/pret/pokefirered) decompilation with a
small set of source changes, built into a GBA ROM and played in the browser
through the mGBA emulator compiled to WebAssembly. Nothing about battles is
reimplemented in JavaScript.

The site never ships the game. Each player loads their own Pokémon FireRed
(USA) ROM once; the site sends a patch (about 1.2 MB) that turns it into
Daily Red in the browser, the way ROM hacks are distributed.

- [Quick start (macOS)](#quick-start-macos)
- [How it works](#how-it-works)
- [Your ROM and the patches](#your-rom-and-the-patches)
- [Trainers, the server and the Hall of Fame](#trainers-the-server-and-the-hall-of-fame)
- [Team generation](#team-generation)
- [RED's team](#reds-team)
- [Development workflow](#development-workflow)
- [Testing and debugging](#testing-and-debugging)
- [Running it locally](#running-it-locally)
- [Deploying](#deploying)
- [Copyright and licenses](#copyright-and-licenses)
- [Known limitations](#known-limitations)

## Quick start (macOS)

You need the Xcode Command Line Tools (`xcode-select --install`), Node.js 22+
and git. No Homebrew, no `sudo`, and **no ROM download**: the decompilation
builds the whole game from source, including byte-for-byte copies of the
original FireRed ROMs that the patches are made from.

```sh
scripts/setup-macos.sh      # ARM cross-compiler + libpng into .toolchain/ (~1 GB, one time)
scripts/get-pokefirered.sh  # pret/pokefirered at a pinned commit + patches/
scripts/fetch-vendor.sh     # emulator, emulator core and font into web/vendor/
scripts/build-rom.sh        # builds pokefirered/pokefirered_modern.gba
scripts/build-patches.sh    # builds agbcc + the original ROMs, writes web/game/*.bps.gz
cd server && npm install && npm run dev   # open http://localhost:8787
```

`setup-macos.sh` picks the right compiler for Intel or Apple Silicon Macs.
The repository's paths must not contain spaces (`make` can't handle them).

## How it works

```
pret/pokefirered @ 037335f + patches/  ──make modern──▶  pokefirered_modern.gba
pret/pokefirered @ 037335f (agbcc)     ──make──────────▶  FireRed v1.0 / v1.1 (in .retail/)
                                         make-bps.mjs: original → Daily Red
                                                              ▼
web/ (static files)                      game/firered-v1.0.bps.gz, firered-v1.1.bps.gz
  index.html + app.js                    game/patches.json
        │  your FireRed ROM (picked once, kept in IndexedDB) + the patch → Daily Red (bps.js)
        │  writes the day's seed + your record into the ROM bytes (rom-config.js)
        ▼
  Nostalgist.js ──▶ RetroArch + mGBA core (WebAssembly) ──▶ <canvas>
        ▲
        └─ game-link.js reads the battle's status from the game's RAM
           → api.js tells the server when RED's battle starts and how it ended

server/ (Cloudflare Worker + D1)  serves web/ and /api/: trainers, today's
                                  day and seed, results, the Hall of Fame
```

**Why an emulator instead of compiling the C to WebAssembly:** the decomp is
written for GBA hardware (video, DMA, interrupts, the m4a sound engine,
ARM/Thumb assembly). Running the real ROM in mGBA keeps the battle engine,
animations and sound exactly as shipped, with no porting work. mGBA has a
built-in BIOS replacement, so no BIOS file is needed either.

**Why Nostalgist + RetroArch's mGBA core:** it accepts the ROM as raw bytes
(needed for the config below), exposes button presses and the emulator's
memory to JavaScript, and doesn't need `SharedArrayBuffer`, so a plain static
file server works without special headers. Everything loads from `web/vendor/`.

### The daily game

- **The day's team:** the server decides the day (the UTC date, so it changes
  at midnight UTC for everyone) and its seed, a hash of the date (`dailySeed`
  in `server/src/index.js`). Everyone gets the same team on the same day, and
  changing the computer's clock doesn't unlock another battle.
- **Site → game:** the ROM contains a small struct, `gDailyRedRomConfig`: the
  magic bytes `DAILYRED-CONF-V2`, then the seed, the player's wins and battles
  so far, and a mode (`DAILYRED_MODE_*` in `include/constants/dailyred.h`):
  free play, the day's battle, or a rematch. Before booting,
  `web/rom-config.js` finds the magic bytes in the patched ROM and fills them
  in; no addresses are hard-coded on either side. The game uses the record
  for its "Record: x win(s) in x battle(s)" message.
- **Game → site:** the game keeps a status block in RAM (`sStatus` in
  `src/dailyred.c`): the magic `DAILYRED-STATUS1`, the seed, a phase (exploring
  / battle / result / finished) and a result (won / lost). `web/game-link.js`
  finds it in the emulator's WebAssembly memory (the magic followed by the
  seed it injected) and reads it twice a second.
- **One battle a day per trainer:** the day counts as played as soon as RED's
  battle starts (the site tells the server, which refuses a second start).
  Closing or reloading the page mid-battle counts as a loss, and so does a
  battle that sends no result within 2 hours. The result is sent the moment
  it's known. After the closing messages the game fades to black and holds;
  the site then closes it and shows today's result and a countdown to the
  next ranked battle. Before the battle you can reload freely: it's the same
  team all day.
- **Rematches:** once the day's battle is done, **Play again** starts another
  go with the day's team in rematch mode: one battle, then the game says
  "Rematches don't count for the HALL OF FAME" (no record message) and the
  site closes it. Rematches are never sent to the server, so they're
  unlimited and don't change the stats or the Hall of Fame.
- **Stats** (on the server, per trainer): wins, losses, win streak (daily wins
  in a row), best win streak and day streak (days played in a row). Missing a
  day resets both current streaks.
- **Without the website** (seed 0, e.g. the ROM in a desktop emulator): the
  normal intro and title screen appear, pressing Start seeds the game the way
  vanilla FireRed does, and after each battle a new team arrives.
- **`?seed=1234`** in the URL starts a practice run for testing: that seed's
  team, no daily limit, nothing sent to the server, and a new team after each
  battle. It isn't shown anywhere in the UI.

## Your ROM and the patches

On the first visit the site asks for the player's Pokémon FireRed ROM: the
USA release, version 1.0 or 1.1, unmodified (`web/rom-store.js`). It's
identified by its SHA-1 against `web/game/patches.json`, kept in the browser
(IndexedDB) so it's only asked once, and patched in memory on every visit
(`web/bps.js`, about a second). Wrong files get a specific message: a zip, a
modified FireRed, another region, LeafGreen. **Change ROM** forgets it.

The patches are BPS files (byuu's format, the usual one for ROM hacks), so
they also work in Floating IPS or Rom Patcher JS. `scripts/build-patches.sh` makes them without needing a ROM:

1. It builds [pret/agbcc](https://github.com/pret/agbcc), the original GBA
   compiler, into `.toolchain/agbcc/`.
2. It checks out the same pret/pokefirered commit, unmodified, into
   `.retail/pokefirered/` and builds FireRed v1.0 and v1.1 with agbcc
   (`make compare_firered compare_firered_rev1`), checking that they match
   the original ROMs' SHA-1s byte for byte.
3. `scripts/make-patches.mjs` writes one patch per release from each original
   to `pokefirered_modern.gba` (`scripts/make-bps.mjs`, checked by applying it),
   gzips them into `web/game/`, and writes `patches.json`.

`.retail/` holds Nintendo's game and is never part of the site; nor is the
Daily Red ROM itself (`build-rom.sh` no longer copies it into `web/`). The
title card's picture of RED is drawn from the patched ROM in the browser
(`web/red-sprite.js`, using the offsets in `patches.json`), so the site ships
no game art either. Rebuild the patches after every ROM change.

## Trainers, the server and the Hall of Fame

`server/` is a Cloudflare Worker that serves `web/` and the API in
`server/src/index.js`, with a D1 (SQLite) database (`server/migrations/`).

- **Trainers:** after loading a ROM, a new player picks a name (2–16
  characters). The server gives them a public 6-character **ID**, shown next
  to the name (names don't have to be unique), and a secret **recovery code**
  (`XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`), kept in localStorage and sent with every
  request. Only its SHA-256 is stored. Entering the code in another browser
  ("I have a recovery code") brings the trainer there.
- **Battles:** one row per trainer per day. The page picks a random run ID for
  each battle and reports when RED's battle starts and its result; the
  server keeps the totals and streaks on the trainer's row (one transaction
  per result). Repeating a start with the same run ID is accepted (a lost
  response); only that run can send the result. A battle started on another
  device doesn't end when you open the site elsewhere: that page shows it as
  under way. Reloading the tab that's playing settles it as a loss (the tab
  remembers it in sessionStorage), and battles left running for more than 2
  hours are settled as losses whenever someone loads the Hall of Fame or the
  trainer comes back. Up to 30 minutes after midnight UTC, yesterday's battle
  can still start, for players who pressed Play just before.
- **Hall of Fame** (under the game): today's champions in the order they beat
  RED, the most wins of all time, and the longest win streaks still alive.
  Your own rows are highlighted.

| API | |
|---|---|
| `POST /api/players {name}` | new trainer → `{player, code}` |
| `GET /api/me` | your stats and today's battle: day, seed, `open` / `running` / `won` / `lost` |
| `PATCH /api/me {name}` | rename |
| `POST /api/battles/start {day, run}` | RED's battle began (409 if you already played today) |
| `POST /api/battles/result {day, won, run}` | the result (409 if that run has no battle running) |
| `GET /api/halloffame` | today's champions, most wins, win streaks |

Authenticated calls send `Authorization: Bearer <recovery code>`.

**Results are taken on trust.** The battle runs in the player's browser, so the
server can enforce one battle a day per trainer, but it can't tell a real win
from a forged request. Making wins verifiable would mean recording the
player's inputs and replaying the battle on a server with the same emulator.

### Game flow and the files involved

| Step | Code |
|---|---|
| Copyright screen → straight in (seed set) | `src/intro.c` → `CB2_DailyRed_StartFromCopyright` (`src/dailyred.c`) |
| Title screen → straight in (no seed) | `src/title_screen.c` → `CB2_DailyRed_StartFromTitle` |
| New game data: LEAF (FireRed's female player), fast text | `StartNewGame` in `src/dailyred.c`, then vanilla `CB2_NewGame` |
| Team + warp to the summit instead of the bedroom | `src/new_game.c` → `DailyRed_InitNewGame` |
| The summit: an open peak with no exits; stairs up to RED, who faces the drop | `data/maps/DailyRed_Summit/`, `data/layouts/DailyRed_Summit/` |
| Snow on the summit (fixes FireRed's unused snow weather, whose flakes never came back) | `src/field_weather_effects.c` |
| Talking to RED → battle → "You defeated RED!" / "Your team was wiped out…" → record → "Play again tomorrow!" / "Try again tomorrow." → fade out | `data/maps/DailyRed_Summit/scripts.inc` and `text.inc`; the `DailyRed_On*` specials in `src/dailyred.c` |
| Mountain battle background on the summit | `BattleSetup_GetTerrainId` in `src/battle_setup.c` |
| No free switch when RED's Pokémon faints: Battle Style starts on SET and is locked in Options | `StartNewGame` in `src/dailyred.c`, `src/option_menu.c` |
| RED as a trainer | `TRAINER_DAILYRED_RED` in `include/constants/opponents.h`, `src/data/trainers.h`, `src/dailyred_boss.c` |
| Menus: POKéMON / OPTION / EXIT; party: SUMMARY / SWITCH / CANCEL | `src/start_menu.c`, `src/party_menu.c`; window height for short menus in `src/new_menu_helpers.c` |
| RED's overworld sprite, in its own palette slot so it doesn't clash with LEAF's | `OBJ_EVENT_GFX_DAILYRED_RED` in `include/constants/event_objects.h`, `src/data/object_events/` |

The battle itself is a standard FireRed trainer battle. The map script uses
`trainerbattle_earlyrival` with `RIVAL_BATTLE_HEAL_AFTER`, the mode FireRed
uses for the rival fight in Oak's lab, so losing doesn't white out. The script
then reads `VAR_RESULT`, updates a win/battle counter, calls the
`DailyRed_StartNextRun` special (new team) and warps back to the start tile,
which also resets RED.

Every vanilla file that was changed has a `Daily Red:` comment at the change:

```sh
grep -rn "Daily Red" pokefirered/src pokefirered/include pokefirered/data
```

The summit layout is a copy of Navel Rock's summit (the peak where Ho-Oh
appears) with the arrival ladder removed. RED stands on the tip at (9, 11)
facing north, out over the drop, and turns around when you talk to him. The project uses pokefirered's `modern` target (GCC 14),
not the byte-matching `agbcc` build, so it doesn't reproduce the retail ROM.

## Team generation

`pokefirered/src/dailyred_team.c` builds each team with the decomp's own data
(`gLevelUpLearnsets`, `CanMonLearnTMHM`, the TM/HM move table,
`CreateMon`, `CalculateMonStats`):

- **Species:** 6 different Pokémon from all 386 of Generations 1–3 whose
  **base stat totals add up to at least 2700** (`MIN_TEAM_BASE_STAT_TOTAL`).
  **Legendaries are a 1-in-8 roll** (`LEGENDARY_TEAM_ODDS`): 1 team in 8 gets
  exactly one legendary or mythical Pokémon, in a random party slot, and the
  other 7 get none. The generator then redraws the rest of the team until it
  meets the minimum, so every qualifying team is equally likely. Per-species
  rules live in `IsEligibleSpecies`, e.g. add "fully evolved only" there.

  Why a minimum: RED's team totals 2954 (see below). A fully random team
  averages about 2430, and two thirds of them include a Pokémon under 300,
  which made most runs hopeless. A team can still include one weak Pokémon if
  the rest make up for it.

  Why legendaries are a separate roll: they average 613 against 393 for
  everything else, so a stat minimum on its own mostly gets met by drawing
  one. With a 2750 minimum alone, 70% of teams had a legendary and 20% had two
  or more.

  How the minimum sets the difficulty: with the IVs and EVs below, a team's
  actual in-battle stat total is almost exactly 2 × its base stat total +
  2580, and RED's is 8555. So each minimum gives:

  | Minimum | Typical team vs RED | Weakest possible | Teams stronger than RED |
  |---|---|---|---|
  | 2600 | 94% | 91% | about 1 in 45 |
  | 2650 | 95% | 92% | about 1 in 34 |
  | **2700** | **96%** | **93%** | **about 1 in 25** |
  | 2750 | 97% | 94% | about 1 in 17 |

  (Odds from simulating 80,000 teams.) Measured in the real ROM at 2700 over
  80 runs: typical team 95% of RED's stats, range 93–101%, 1 team stronger
  than RED. RED also has hand-picked moves, chosen held items (his Pikachu's
  Light Ball doubles its Sp. Atk) and the strongest trainer AI, so he stays
  the favourite.

- **Moves:** up to 4 different moves picked uniformly from everything the
  species can learn **by level-up (any level) or TM/HM**. One rule on top: if
  none of the four can deal damage and the species has any damaging move, one
  pick is swapped for a damaging move. Species with fewer than 4 learnable moves
  (Ditto, Unown, Magikarp, Smeargle…) get all of them.
- **Stats:** level 100, random personality (so random nature, gender, ability
  and the usual 1/8192 shiny chance), and trained close to RED's level:
  - **IVs** random from 25 to 31 in every stat (`MIN_TEAM_IV`); RED's are all 31.
  - **EVs** 252 into each of its two highest base stats and the last 6 into
    HP, or into its third-best stat if HP is one of the two
    (`AssignFocusedEVs`). Attack and Sp. Atk only count if one of its attacks
    uses them (in Gen 3 a move's type decides which), so a Gyarados with only
    Surf and Ice Beam doesn't waste points on Attack. Fast Pokémon end up as
    fast as RED's; slow walls put their points into bulk instead.

  The player is the original trainer, so everything obeys, and Pokémon are
  marked as event Pokémon so Mew and Deoxys obey too.
- **Held items:** each Pokémon holds one, picked uniformly from a pool of
  generally useful battle items (`sBattleItems`: Leftovers, Choice Band,
  Quick Claw, Lum Berry, pinch berries…) plus the 10% type booster for each
  type it actually attacks with (Charcoal only if it has a Fire attack, and
  so on). There are still no bag items.
- **Safety:** each Pokémon is validated (level, HP, at least one move, no
  duplicate moves, PP). If a Pokémon somehow failed 10 times, the game would
  use FireRed's own default level-100 moveset for it rather than hand over
  something broken.

Trade-offs in this first version: the move picker ignores move tutors and egg
moves (add them in `GetLearnableMoves`), and it's deliberately not
competitive. Splash, Water Sport or three status moves plus one attack are all
possible. Items are picked without looking at the moveset beyond type
boosters, so a Choice Band can land on a Pokémon that mostly uses status
moves, and species-specific items (Light Ball, Thick Club…) aren't in the pool.
The generator uses its own RNG state, separate from the game's `Random()`, so
teams depend only on the seed.

## RED's team

Edit **`pokefirered/src/dailyred_boss.c`**: species, level, IVs, held item and
moves use FireRed's normal `TrainerMonItemCustomMoves` format, plus an EV
table next to it. It's Red's Mt. Silver team from HeartGold/SoulSilver
(Pikachu, Espeon, Snorlax, Venusaur, Charizard, Blastoise) at level 100 with
perfect IVs, held items and full EV spreads. HGSS used several Gen 4 moves, so
the movesets are adapted to Gen 3 ones.

| Pokémon | HP | Atk | Def | Spe | SpA | SpD | Total |
|---|---|---|---|---|---|---|---|
| Pikachu (Light Ball doubles its Sp. Atk) | 35 | 55 | 30 | 90 | 50 | 40 | 300 |
| Espeon | 65 | 65 | 60 | 110 | 130 | 95 | 525 |
| Snorlax | 160 | 110 | 65 | 30 | 65 | 110 | 540 |
| Venusaur | 80 | 82 | 83 | 80 | 100 | 100 | 525 |
| Charizard | 78 | 84 | 78 | 100 | 109 | 85 | 534 |
| Blastoise | 79 | 83 | 100 | 78 | 85 | 105 | 530 |
| **Team** | | | | | | | **2954** |

These are Gen 3 base stats from `src/data/pokemon/species_info.h`. With your
team's IVs (25–31) and focused EVs, both sides get about the same out of their
base stats. Measured from game RAM, a 525-total Pokémon reaches about 1520
actual stat points for RED and about 1533 for you; his natures come from
FireRed's fixed formula and sometimes cut a stat he needs. (With fully random
IVs and EVs it was about 1445 for you, which made him much stronger point for
point.)

RED's name, trainer class ("PKMN TRAINER"), sprite and AI flags (the same as
FireRed's Champion) are in `[TRAINER_DAILYRED_RED]` in
`pokefirered/src/data/trainers.h`. He gets the Champion battle music
(`src/pokemon.c`). FireRed trainers have no EVs, so a 3-line hook in
`CreateNPCTrainerParty` (`src/battle_main.c`) applies the EV table. Natures
come from FireRed's usual name-based formula and aren't configurable.

## Development workflow

1. Edit files in `pokefirered/` (a git checkout of pret's repo).
2. `scripts/build-rom.sh` (incremental builds take a few seconds), then
   `scripts/build-patches.sh` (a few seconds once the original ROMs exist).
3. Reload the page.
4. When you're happy, run `scripts/save-patch.sh` and commit
   `patches/pokefirered-dailyred.patch`.

`pokefirered/`, `.retail/`, `.toolchain/`, `web/vendor/`, `web/game/` and
`server/.wrangler/` are not tracked (see `.gitignore`); a clean checkout
recreates them with the scripts above.
`git -C pokefirered diff` shows all game changes against upstream.

To play the ROM outside the browser, open
`pokefirered/pokefirered_modern.gba` in mGBA or any GBA emulator. Without an
injected seed it boots to the title screen; press Start.

The website has no build step: plain HTML, CSS and ES modules in `web/`.

## Testing and debugging

The tests boot the real ROM in headless Chrome through the same emulator the
website uses, press buttons, and read game RAM out of emulator save states
(mGBA's state contains a raw copy of RAM).

```sh
cd tests
npm install        # playwright-core only; it drives your installed Google Chrome
npm run bps        # patch format round trips (~1 s, no ROM needed)
npm run api        # the server, over several faked days (~30 s, needs server/'s npm install)
npm run smoke      # the game loop (~3 min)
npm run site       # the website on desktop and phone (~4 min, needs build-patches.sh)
npm run teams -- 1 2 3            # print + validate the teams for these seeds
npm run teams -- --random 40      # 40 random seeds
```

`npm run api` and `npm run site` start the real site in wrangler's local
runtime with an empty database (`startSite` in `tests/lib.mjs`). With
`TEST_CLOCK=1`, which only the tests set, the server reads its clock from an
`X-Test-Now` header, so a test can play several days in a few minutes.

`npm run api` checks names, recovery codes (typed in any case, wrong codes
refused, never returned), one start and one result per day (a repeated start
from the same run accepted, other runs refused), results for the wrong day,
without a start or from another run refused, battles abandoned for 2 hours
becoming losses, win and day streaks across days (and their reset after a
missed day), the best streak, battles that cross midnight or start just
after it, and the Hall of Fame lists.

`npm run bps` checks that patches from `make-bps.mjs` apply with `bps.js`
(copies, moved blocks, runs, growth, shrinking) and that damaged patches and
the wrong source ROM are refused.

`npm run smoke` checks that:
- each seed's team is valid: 6 different real Gen 1–3 species with a combined
  base stat total of at least 2700 and at most one legendary, level 100, full
  HP, IVs 25–31, EVs exactly as `AssignFocusedEVs` would place them (checked
  by an independent JavaScript copy of the rule), an item from the pool (type boosters only with a
  matching attack), and every move learnable by the species. The
  learnable-move check parses the decomp's data files in JavaScript, so it's
  independent of the C generator.
- the same seed gives the same team, and different seeds give different ones.
- the player starts at the foot of the stairs, RED faces away from them (and
  again after every run), and talking to RED starts a trainer battle on the
  mountain background.
- battle style is SET from the start, the Options menu can't change it, and
  when one of RED's Pokémon is knocked out he sends the next one with no
  "Will LEAF change POKéMON?" prompt.
- RED's in-battle party is the configured team with IVs, items and EVs.
- a win and a loss are each handled: no white-out, counters updated, and a new
  valid team afterwards.
- the daily game starts from the website's record, reports the battle start,
  the result and the end, counts the battle in its record message, and
  ignores input once it's over (no second battle).
- a rematch gets the day's team, reports its result and the end the same way,
  and also allows no second battle.
- without a seed, the title screen appears and Start leads into the game.

The win and loss are forced by editing HP values in a save state, which makes
them quick and deterministic. Screenshots of every step are saved in
`tests/output/`.

`npm run site` loads the original FireRed ROMs from `.retail/` like a player
would and plays the daily game over five faked days: a fresh visitor (wrong
files refused, v1.0 accepted, the site serving no ROM or game art), a new
trainer and their recovery code, a win (stats, locked until tomorrow,
countdown, the Hall of Fame, survives a reload), two rematches with the
day's team (a loss and a win, neither counted), the same team for a second
trainer on v1.1, a loss the next day, opening the site on a second device
mid-battle (shown as under way, not forfeited), reloading mid-battle (a
loss), a missed day (streaks reset), and a practice run (`?seed=`, not
recorded). It then
brings the trainer to another browser with the recovery code, changes ROM,
checks the 3× (720×480) screen, RED's sprite, the phone layout of every card
and the touch d-pad, and the download-error screen with "Try again".

**Checking by hand:** open `http://localhost:8787/?seed=42` for a practice run
(nothing sent, no daily limit). To start over as a new visitor, clear the
site's data in the browser (or run `localStorage.clear()` and
`indexedDB.deleteDatabase('dailyred')` in the console); to wipe the local
database, delete `server/.wrangler/`.

**In the browser console:** `dailyRed.emulator` is the running Nostalgist
instance, `dailyRed.player` your trainer's stats and `dailyRed.today` today's
battle.

## Running it locally

After the quick start, `cd server && npm run dev` runs the site and the API
at http://localhost:8787 in wrangler's local Workers runtime, with a local
database in `server/.wrangler/`. `web/` is about 6 MB:

```
web/index.html  app.js  api.js  bps.js  rom-store.js  red-sprite.js  game-link.js  game-files.js  rom-config.js  style.css  favicon.svg  licenses.txt
web/vendor/     emulator (3.4 MB) + font
web/game/       firered-v1.0.bps.gz, firered-v1.1.bps.gz (1.2 MB each), patches.json
```

After rebuilding the ROM, run `scripts/build-patches.sh` again and reload the
page. Loading `pokefirered/pokefirered_modern.gba` itself as "your ROM" also
works, which is handy while developing.

`node scripts/serve.mjs` is a plain static server for `tests/smoke.mjs` and
`tests/teams.mjs`, which boot the locally built ROM directly.

## Deploying

The Worker serves the site and the API on Cloudflare's free plan, which
doesn't charge for bandwidth on static files. Once:

```sh
cd server
npx wrangler login
npx wrangler d1 create dailyred    # paste the database_id into wrangler.jsonc
```

Then, after building the patches, each deploy is `npm run deploy` in
`server/`: it applies new database migrations and uploads the Worker and
`web/`. Before deploying, check that `web/game/` holds only the patches and
`patches.json`.

## Copyright and licenses

Daily Red is a free, unofficial fan project. It isn't affiliated with or
endorsed by Nintendo, Creatures Inc., GAME FREAK inc. or The Pokémon Company.
Pokémon and all related names, characters and game content are © Nintendo,
Creatures Inc. and GAME FREAK inc.

This repository contains Daily Red's own work: the changes in `patches/`, the
website, the server and the tests. It doesn't include pret/pokefirered or a
built ROM; the scripts fetch the decompilation from pret's repository and
build locally. The website doesn't include a ROM either: players bring their
own FireRed, and the site only sends the patches (see
[Your ROM and the patches](#your-rom-and-the-patches)).

The emulator core is GPL-3.0 (RetroArch) and MPL-2.0 (mGBA). `web/licenses.txt`
lists all third-party components with links to their source, and the page
footer links to it.

## Known limitations

- **Movement:** running shoes and the bike are off on the summit; it's only
  a few steps to the top.
- **Results are reported by the browser** and taken on trust (see
  [Trainers, the server and the Hall of Fame](#trainers-the-server-and-the-hall-of-fame)):
  a determined player can send a fake win, or play with a modified ROM.
  Anyone can also create many trainers; there's no rate limit yet.
- **Only FireRed (USA) v1.0 and v1.1:** those are the releases pret's
  decompilation can build, so they're the only ones a patch can be made from.
  Other languages and LeafGreen are refused with a message.
- **Losing your recovery code** (clearing site data without having saved it)
  loses that trainer.
- **Time zones:** the day changes at midnight UTC for everyone, which is
  during the night in Europe but mid-afternoon or evening in the Americas.
- **Soft reset** (A+B+Start+Select) is turned off in the daily game, so a
  losing battle can't be restarted. (If the game ever restarts mid-battle
  anyway, the site counts it as a loss.)
- **Audio** can't be checked by the headless tests. Browsers start audio
  suspended unless it begins during a click, so the game resumes it on the
  next key press or tap.
- **Tested environment:** macOS with Google Chrome (headless, desktop and
  phone emulation). Not yet tried on Safari, Firefox or real phones.
- The L/R buttons still open FireRed's built-in help, which describes the
  normal game.

## Project layout

```
patches/pokefirered-dailyred.patch   all changes to pret/pokefirered
scripts/setup-macos.sh               toolchain (xPack arm-none-eabi-gcc 14.2.1 + libpng)
scripts/get-pokefirered.sh           pinned upstream checkout + patch
scripts/save-patch.sh                pokefirered/ changes → patches/
scripts/build-rom.sh                 make modern → pokefirered/pokefirered_modern.gba
scripts/build-patches.sh             agbcc + original ROMs (.retail/) → web/game/ patches
scripts/make-patches.mjs             the patches and patches.json
scripts/make-bps.mjs                 BPS patch writer
scripts/fetch-vendor.sh              Nostalgist, mGBA core, font (pinned, checksummed)
scripts/serve.mjs                    static server for the game tests
web/                                 the website
server/                              Cloudflare Worker: API, D1 schema, wrangler config
tests/                               API, patch and headless browser tests, the teams tool
```

Inside `pokefirered/`, the Daily Red code is `include/dailyred.h`,
`include/constants/dailyred.h`, `src/dailyred.c` (game flow and seed),
`src/dailyred_team.c` (team generator), `src/dailyred_boss.c` (RED's team), and
`data/maps/DailyRed_Summit/` plus `data/layouts/DailyRed_Summit/` (the map).
