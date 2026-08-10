# perfherder-cli

Query Firefox performance data from the command line. Find a benchmark, see
where it stepped, work out what landed there, and say whether a regression was
the same work getting slower or a slow path being taken more often.

It talks to `treeherder.mozilla.org` directly. No account, no configuration,
nothing to run alongside it.

```sh
npm install -g @mstange/perfherder-cli
perfherder-cli --help
```

## What it is

The command-line half of [perfherder2](https://perfherder2.netlify.app/), a
client-side reimplementation of Perfherder's graphs view — and built from that
app's own modules rather than beside them, so an answer here and the same answer
read off the graph cannot disagree. Every command prints a link that opens the
graph it is describing, because a text answer nobody can check against the
picture is one nobody should act on.

| Command | Answers |
| --- | --- |
| `search <term...>` | which signature do I mean? |
| `series <ref...>` | what level is it at, and how do two of them compare? |
| `series <ref...> --drift` | it never stepped — how far has it slid since February? |
| `changes <ref...>` | where did it move, and what landed there? |
| `changes <ref...> --cluster` | which *landings* moved these twenty series, not which series moved? |
| `step <ref...> --at` | how big is the move *here*, on each of these series? |
| `locate <ref> --at` | which push is the step actually on? |
| `compare <a> <b>` | statistics, distributions, and whether the modes moved |
| `commits <repo> <from> <to>` | what landed between two revisions |
| `url <ref...>` | a shareable link, without fetching anything |

A **series reference** is `<repo>,<signatureId>[,<frameworkId>]` — the first
column of `search`, and the same thing a `series=` parameter in a shared app link
contains, so references paste both ways.

## A worked investigation

```sh
# 1. Find the signature.
perfherder-cli search speedometer3 android --repo mozilla-central

# 2. Levels over a window — the "A vs B" answer.
perfherder-cli series mozilla-central,270490 mozilla-central,230167 --range 60d

# 3. When did it move, and what landed?
perfherder-cli changes autoland,5350953 --range 6mo --commits

# 4. What kind of change was it? Statistics, distributions, and whether the
#    modes moved or only their weights.
perfherder-cli compare autoland,5350953@<beforeRev> <afterRev> --pool 24

# 5. Did the other platforms see it, even where no bar was drawn?
perfherder-cli step autoland,5350953 --across platform --at <rev> --range 60d

# …and over a whole suite at once: which landings moved it, six months back?
perfherder-cli changes <refs...> --range 6mo --cluster --brief
```

Four things here have no counterpart in the app. Two exist because silence is not
evidence:

- **`step`** measures a change at a point you name and says which of the
  detector's two bars a real-but-unmarked move failed. A platform running a
  benchmark once per push, beside one running it twelve times, has several times
  the per-push noise — so the same real step is certified on one graph and
  invisible on the other. Reading that as "it didn't happen here" is the mistake
  this prevents.
- **`series --drift`** prints the first window of a range against the last, for a
  series that slid 8% over three months without ever stepping. Segmentation looks
  for steps and there is no step in that shape, so no bar is drawn and nothing is
  wrong.

And two because a point estimate is not an interval, and a series is not a cause:

- **`locate`** ranks every push a step could be on, by the criterion the detector
  itself uses to place a bar, and marks the one Perfherder alerted on.
- **`changes --cluster`** groups the events of a whole ref list into the landings
  behind them, joining on the interval each event brackets rather than on the push
  it was placed on. Nine events across three platforms become one row — and the
  intersection of their brackets is often narrower than any single series carries,
  sometimes a single push.

## Notes that save a round trip

- `--json` prints the same object the text was rendered from, for piping.
- Responses are cached under `$XDG_CACHE_HOME/perfherder-cli` for ten minutes to
  a day depending on how fast the thing behind them changes, so narrowing a
  search is cheap. `--no-cache` when you need it fresh.
- Ranges: `--range 90d` / `6mo` / `1y` / `36h`, or `--from` / `--to` with
  `YYYY-MM-DD`. Every command prints the range it resolved. All times are UTC.
- Links are built against <https://perfherder2.netlify.app/>. Point them
  somewhere else with `--base <url>` or `PERFHERDER2_BASE_URL`.

## Design

[docs/cli.md](https://github.com/mstange/perfherder2/blob/main/docs/cli.md) has
the reasoning: why the CLI lives inside the app's repository, why a pooled
comparison is tested over push means, what the mode analysis is for, and what
four fresh sessions found when they were handed the tool with no context.

MPL-2.0.
