#!/usr/bin/env python3
"""Measure the main dashboard's critical and deferred API load without its response cache."""

from __future__ import annotations

import concurrent.futures
import json
import os
import statistics
import sys
import time
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

BASE_URL = os.environ.get("FRUGAL_TOKENS_BENCHMARK_URL", "http://localhost:19000").rstrip("/")
TIME_ZONE = os.environ.get("FRUGAL_TOKENS_BENCHMARK_TIME_ZONE", "America/Los_Angeles")
SAMPLES = max(3, int(os.environ.get("FRUGAL_TOKENS_BENCHMARK_SAMPLES", "5")))
TIMEOUT_SECONDS = float(os.environ.get("FRUGAL_TOKENS_BENCHMARK_TIMEOUT", "30"))
REFERENCE_DIR = Path(__file__).with_name("reference")

# NewPage starts the core requests together. Calendar data starts after the
# lightweight work-rhythm response; below-the-fold sections start once the
# activity and work-rhythm summary responses have both settled.
CRITICAL_ENDPOINTS = (
    ("harnesses", "/api/harnesses", {}, True),
    (
        "activity",
        "/api/activity-overview",
        {"range": "30", "harness": "all", "timeZone": TIME_ZONE},
        True,
    ),
    (
        "work_rhythm",
        "/api/work-rhythm",
        {"range": "30", "harness": "all", "timeZone": TIME_ZONE},
        False,
    ),
)
DEFERRED_ENDPOINTS = (
    (
        "work_rhythm_days",
        "/api/work-rhythm/days",
        {"range": "30", "harness": "all", "timeZone": TIME_ZONE},
        False,
    ),
)
AFTER_CRITICAL_ENDPOINTS = (
    (
        "session_shape",
        "/api/session-shape",
        {"range": "30", "harness": "all"},
        True,
    ),
    ("usage", "/api/usage", {"range": "30", "harness": "all"}, True),
    (
        "cache_misses",
        "/api/cache-misses/overview",
        {"range": "30", "harness": "all"},
        True,
    ),
)
ENDPOINTS = CRITICAL_ENDPOINTS + DEFERRED_ENDPOINTS + AFTER_CRITICAL_ENDPOINTS


def canonical_json(body: bytes) -> str:
    value = json.loads(body)
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n"


def timing_values(header: str | None) -> dict[str, float]:
    if not header:
        return {}
    values: dict[str, float] = {}
    for item in header.split(","):
        name, separator, rest = item.strip().partition(";")
        if not separator:
            continue
        for parameter in rest.split(";"):
            key, equals, value = parameter.strip().partition("=")
            if key == "dur" and equals:
                try:
                    values[name] = float(value)
                except ValueError:
                    pass
    return values


def fetch(endpoint: tuple[str, str, dict[str, str], bool], run_id: str) -> dict[str, object]:
    name, path, params, _compare = endpoint
    query = dict(params)
    query["bench"] = run_id
    url = f"{BASE_URL}{path}?{urlencode(query)}"
    started = time.perf_counter()
    request = Request(url, headers={"accept": "application/json", "cache-control": "no-cache"})
    try:
        with urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            body = response.read()
            status = response.status
            content_type = response.headers.get("content-type", "")
            server_timing = response.headers.get("server-timing")
    except Exception as error:
        raise RuntimeError(f"{name}: {error}") from error
    duration_ms = (time.perf_counter() - started) * 1_000
    if status < 200 or status >= 300:
        raise RuntimeError(f"{name}: HTTP {status}")
    if "application/json" not in content_type:
        raise RuntimeError(f"{name}: expected JSON, got {content_type or 'unknown content'}")
    try:
        canonical = canonical_json(body)
    except (TypeError, ValueError) as error:
        raise RuntimeError(f"{name}: invalid JSON response ({error})") from error
    return {
        "name": name,
        "duration_ms": duration_ms,
        "bytes": len(body),
        "canonical": canonical,
        "timing": timing_values(server_timing),
    }


def run_sample(index: int) -> tuple[float, float, list[dict[str, object]]]:
    run_id = f"{time.time_ns()}-{index}"
    started = time.perf_counter()
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(ENDPOINTS)) as executor:
        futures = {
            endpoint[0]: executor.submit(fetch, endpoint, run_id)
            for endpoint in CRITICAL_ENDPOINTS
        }
        # Match NewPage's dependency: start calendar/detail work only after
        # the summary response has resolved, while other critical requests may
        # still be running.
        summary = futures["work_rhythm"].result()
        deferred_futures = {
            endpoint[0]: executor.submit(fetch, endpoint, run_id)
            for endpoint in DEFERRED_ENDPOINTS
        }
        results = [futures[endpoint[0]].result() for endpoint in CRITICAL_ENDPOINTS]
        critical_ms = (time.perf_counter() - started) * 1_000
        after_critical_futures = {
            endpoint[0]: executor.submit(fetch, endpoint, run_id)
            for endpoint in AFTER_CRITICAL_ENDPOINTS
        }
        results.extend(
            deferred_futures[endpoint[0]].result() for endpoint in DEFERRED_ENDPOINTS
        )
        results.extend(
            after_critical_futures[endpoint[0]].result()
            for endpoint in AFTER_CRITICAL_ENDPOINTS
        )
        complete_ms = (time.perf_counter() - started) * 1_000
    # Keep the summary in the result set even though result ordering is based
    # on endpoint declarations; this makes the dependency explicit above.
    assert summary in results
    return critical_ms, complete_ms, results


def median(values: list[float]) -> float:
    return statistics.median(values)


def main() -> int:
    samples: list[tuple[float, float, list[dict[str, object]]]] = []
    try:
        for index in range(SAMPLES):
            samples.append(run_sample(index))
    except RuntimeError as error:
        print(f"BENCHMARK_ERROR {error}")
        return 1

    REFERENCE_DIR.mkdir(parents=True, exist_ok=True)
    regressions: list[str] = []
    by_name: dict[str, list[dict[str, object]]] = {name: [] for name, *_ in ENDPOINTS}
    for _critical_ms, _complete_ms, results in samples:
        for result in results:
            name = str(result["name"])
            by_name[name].append(result)
            endpoint = next(endpoint for endpoint in ENDPOINTS if endpoint[0] == name)
            if not endpoint[3]:
                continue
            reference = REFERENCE_DIR / f"{name}.json"
            canonical = str(result["canonical"])
            if not reference.exists():
                reference.write_text(canonical)
            elif reference.read_text() != canonical:
                regressions.append(name)

    critical_walls = [critical for critical, _complete, _results in samples]
    complete_walls = [complete for _critical, complete, _results in samples]
    critical_bytes = [
        sum(int(result["bytes"]) for endpoint in CRITICAL_ENDPOINTS for result in [by_name[endpoint[0]][sample]])
        for sample in range(SAMPLES)
    ]
    complete_bytes = [
        sum(int(result["bytes"]) for endpoint in ENDPOINTS for result in [by_name[endpoint[0]][sample]])
        for sample in range(SAMPLES)
    ]
    print(f"samples={SAMPLES} base={BASE_URL}")
    print(
        "timing_ms="
        + " ".join(
            f"{name}={median([float(result['duration_ms']) for result in by_name[name]]):.2f}"
            for name, *_ in ENDPOINTS
        )
        + f" critical={median(critical_walls):.2f} complete={median(complete_walls):.2f}"
    )
    print(
        "server_ms="
        + " ".join(
            f"{name}.database={median([float(result['timing'].get('database', 0)) for result in by_name[name]]):.2f}"
            for name, *_ in ENDPOINTS
            if any("database" in result["timing"] for result in by_name[name])
        )
    )
    if regressions:
        print(f"DATA_REGRESSION endpoints={','.join(sorted(set(regressions)))}")
    else:
        print("data=ok (work_rhythm and work_rhythm_days intentionally excluded from equality check)")

    metrics: dict[str, float] = {
        "critical_ms": median(critical_walls),
        "complete_ms": median(complete_walls),
        "critical_bytes": median([float(value) for value in critical_bytes]),
        "complete_bytes": median([float(value) for value in complete_bytes]),
        "data_regressions": float(len(set(regressions))),
    }
    for name, *_ in ENDPOINTS:
        metrics[f"{name}_ms"] = median([float(result["duration_ms"]) for result in by_name[name]])
        metrics[f"{name}_bytes"] = median([float(result["bytes"]) for result in by_name[name]])
    for name in ("activity", "work_rhythm", "work_rhythm_days"):
        timings = [result["timing"] for result in by_name[name]]
        for timing_name in ("root-rollups", "root-execution-intervals", "cache-misses", "work-rhythm", "work-rhythm-days", "session-diagnostics", "aggregate"):
            values = [float(timing.get(timing_name, 0)) for timing in timings]
            if any(values):
                metrics[f"{name}_{timing_name.replace('-', '_')}_ms"] = median(values)

    for key, value in metrics.items():
        print(f"METRIC {key}={value:.3f}")
    return 2 if regressions else 0


if __name__ == "__main__":
    sys.exit(main())
