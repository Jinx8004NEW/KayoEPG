<div align="center">

<h1>Kayo EPG</h1>

<p><b>A TV guide that remembers yesterday.</b><br>
Kayo edition. Sibling of <a href="https://github.com/Jinx8004NEW/FoxtelEPG">FoxtelEPG</a>, same
channels, different source.</p>

<p>
<a href="https://github.com/Jinx8004NEW/KayoEPG/actions/workflows/fetch-schedule.yml"><img src="https://github.com/Jinx8004NEW/KayoEPG/actions/workflows/fetch-schedule.yml/badge.svg" alt="Fetch"></a>
<img src="https://img.shields.io/badge/node-20%2B-3c873a" alt="Node 20+">
<img src="https://img.shields.io/badge/auth-none-brightgreen" alt="No auth">
<img src="https://img.shields.io/badge/build_step-none-lightgrey" alt="No build step">
</p>

<h3><a href="https://jinx8004new.github.io/KayoEPG/">Open the guide &rarr;</a></h3>

</div>

---

## Why a second repo

The Foxtel EPG goes blank for days at a time. Kayo carries the same 17 channels and has been
steady throughout, so this collects from Kayo instead. Two independent guides, same data format,
same frontend, easy to put side by side when one of them looks wrong.

It is not a fallback layer bolted onto the other repo. Keeping them separate means a bad Kayo run
cannot take down a working Foxtel guide, and the comparison stays honest.

<br>

## Two sources, because neither is enough alone

| | `Livetvschedule` | `epgWithDatesRange` |
| --- | --- | --- |
| Covers | 12 linear channels | 5 4K channels |
| Content | Full schedule, ~25-35/day | Fixtures only, ~5/day |
| Descriptions | Yes | No |
| Programme IDs | **No** | Yes |
| Date parameter | **No** | Yes, +/-6 days |
| Auth | None | None |
| Proxy | Not needed | Geo-restricted, needs one |

The linear endpoint is the good one, and it has the awkward shape: it returns Now / Next / Later
from this instant and nothing else. No history, no way to ask for a specific date.

<br>

## The consequence: files accumulate

Because a run only ever looks forward, day files are **merged, not overwritten**. Write the file
outright and the 20:00 run would erase what aired at 09:00.

`scheduledDate` is the merge key. The linear feed has no programme IDs, but start times are exact
to the second and two programmes cannot begin at the same instant on one channel. On a collision
the incoming entry wins, because schedules get revised when a fixture is abandoned and the newer
fetch is the truer one.

> [!IMPORTANT]
> History only exists from the day collection starts. There is no backfill and there never can be
> one, because the endpoint has no historical mode.

**Coverage runs about two days ahead, but Fox Sports News publishes barely one.** That sets the
real tolerance: the collector going quiet for more than ~22 hours leaves a permanent hole in FSN,
while the other channels would survive two days.

<br>

## Channels

<details>
<summary><b>12 linear</b> &nbsp;<i>Livetvschedule</i></summary>
<br>

Matched on Kayo's channel `AssetId`, which is stable. Display titles are not, so they are only a
fallback. Tags match the FoxtelEPG repo so both guides share one data format.

| Tag | Channel | No. | | Tag | Channel | No. |
| --- | --- | --- | --- | --- | --- | --- |
| `FSN` | Fox Sports News | 500 | | `FSS` | Fox Sports 507 | 507 |
| `FS1` | Fox Cricket | 501 | | `ESP` | ESPN | 508 |
| `SP2` | Fox League | 502 | | `ES2` | ESPN2 | 509 |
| `FS3` | Fox Sports 503 | 503 | | `UFC` | Mainevent UFC | 523 |
| `FAF` | Fox Footy | 504 | | `RTV` | Racing.com | 529 |
| `FSP` | Fox Sports 505 | 505 | | | | |
| `SPS` | Fox Sports 506 | 506 | | | | |

</details>

<details>
<summary><b>5 4K</b> &nbsp;<i>epgWithDatesRange</i></summary>
<br>

| Tag | Channel | Sport |
| --- | --- | --- |
| `4KL` | Fox League 4K | NRL, NRL Women |
| `4KF1` | Fox Motorsport 4K | F1, V8 Supercars, MotoGP |
| `4KF` | Fox Footy 4K | AFL |
| `4KF2` | Fox Footy 2 4K | AFL overflow |
| `4KN` | Fox Netball 4K | Suncorp Super Netball |

Event-driven, so long empty stretches between fixtures are normal.

</details>

<br>

## What Kayo gives you that Foxtel does not

**Untruncated titles.** Foxtel caps `programTitle` at 40 characters and chops mid-word:
`Live: Caribbean Premier League: Kingsme`. Kayo splits it properly into `CPL T20 Cricket` plus
`Jamaica Kingsmen vs Antigua & Barbuda Falcons`.

**Descriptions.** A real synopsis per programme. Foxtel has no equivalent field.

**Genre and programme type**, which Foxtel also lacks.

## And what it does not

**No images.** Linear entries carry image IDs, but the CDN has no asset behind them, and every
request comes back as the Kayo logo placeholder. `imageUrl` is left empty; the frontend already
renders events without one, since 4K events often have none.

**No history.** See above. This is the real cost.

<br>

## Layout

```
.github/workflows/     fetch (every 4h), pages deploy (manual)
docs/index.html        the guide, single file, identical to FoxtelEPG bar REPO_RAW
scripts/fetch.js       both sources, linear merge + 4K write
scripts/cleanup.js     retention, 21 days
```

Node 20+, one dependency (`https-proxy-agent`, only used for the 4K half), no build step.

> [!IMPORTANT]
> `data/` isn't in the initial commit; the first workflow run creates it. It is deliberately **not**
> gitignored, because the fetch workflow commits it with `git add data/`.

<details>
<summary>What a linear event looks like</summary>
<br>

```json
{
  "programTitle": "The Hundred",
  "episodeTitle": "Men's: London Spirit v MI London",
  "description": "The Hundred is a professional franchise 100-ball cricket tournament.",
  "scheduledDate": 1786138200000,
  "duration": 25,
  "parentalRating": "",
  "programType": "Sports non-event",
  "genre": "Cricket",
  "imageUrl": ""
}
```

Day files carry `"source": "kayo"` (or `"kayo-4k"`) so a file's origin is obvious later.

</details>

<br>

## Configuration

| Variable | Where | Notes |
| --- | --- | --- |
| `PROXY_HOST` `PROXY_PORT` `PROXY_USER` `PROXY_PASS` | repo secrets | 4K half only. The linear endpoint needs no proxy and no auth. |

Actions needs **read and write** permissions, or the fetch works and only the push 403s. Pages
source must be **GitHub Actions**, not a branch.

Only the linear half is treated as fatal. The 4K feed is geo-restricted and expected to fail
intermittently; marking a run red for that would train you to ignore red runs.

<br>

---

<div align="center">
<sub>

No license. Schedule data belongs to Kayo and DAZN, read from their public endpoints for personal
use at a deliberately slow request rate.

</sub>
</div>
