#!/usr/bin/env python3
"""Observe Cursor Agent model-call metadata without retaining message content.

Cursor's HTTP/1.1 fallback uses a Connect/protobuf stream even though the
response is advertised as text/event-stream. This addon forwards every chunk
unchanged and records request/model/turn metadata plus token counters.

By default it writes metadata to:
  ~/.local/share/frugal-tokens/cursor-capture/events.jsonl

CURSOR_SSE_CAPTURE_RAW=1 remains available for protocol debugging, but is not
needed for normal operation. Raw bodies can contain prompts, code, responses,
and credentials.
"""

from __future__ import annotations

import gzip
import json
import os
import threading
import time
from collections import Counter
from pathlib import Path
from typing import Iterator

from mitmproxy import http

TARGETS = {
    ("api2.cursor.sh", "/agent.v1.AgentService/RunSSE"),
    ("agentn.global.api5.cursor.sh", "/agent.v1.AgentService/Run"),
}
OUTPUT_DIR = Path(
    os.environ.get(
        "CURSOR_SSE_CAPTURE_DIR",
        str(Path.home() / ".local/share/frugal-tokens/cursor-capture"),
    )
).expanduser()
CAPTURE_RAW = os.environ.get("CURSOR_SSE_CAPTURE_RAW") == "1"
MAX_FRAME_BYTES = 128 * 1024 * 1024

_log_lock = threading.Lock()
_log_file = None
_request_states: dict[str, dict] = {}

EVENT_NAMES = {
    1: "textDelta",
    2: "toolCallStarted",
    3: "toolCallCompleted",
    4: "thinkingDelta",
    5: "thinkingCompleted",
    6: "userMessageAppended",
    7: "partialToolCall",
    8: "tokenDelta",
    9: "summary",
    10: "summaryStarted",
    11: "summaryCompleted",
    12: "shellOutputDelta",
    13: "heartbeat",
    14: "turnEnded",
    15: "toolCallDelta",
    16: "stepStarted",
    17: "stepCompleted",
    18: "promptSuggestion",
    19: "postRequestPrompt",
    20: "activeBranchChange",
    21: "feedbackRequest",
    22: "responseComparison",
}


def _write_log(record: dict) -> None:
    global _log_file
    OUTPUT_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    with _log_lock:
        if _log_file is None:
            _log_file = (OUTPUT_DIR / "events.jsonl").open("a", encoding="utf-8")
            os.chmod(_log_file.name, 0o600)
        _log_file.write(json.dumps(record, separators=(",", ":")) + "\n")
        _log_file.flush()


def _target(flow: http.HTTPFlow) -> bool:
    return (flow.request.pretty_host, flow.request.path) in TARGETS


def _read_varint(data: bytes, offset: int) -> tuple[int, int]:
    value = 0
    shift = 0
    while offset < len(data):
        byte = data[offset]
        offset += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, offset
        shift += 7
        if shift > 70:
            raise ValueError("protobuf varint is too long")
    raise ValueError("truncated protobuf varint")


def _protobuf_fields(data: bytes) -> list[tuple[int, int, int | bytes]]:
    fields: list[tuple[int, int, int | bytes]] = []
    offset = 0
    while offset < len(data):
        key, offset = _read_varint(data, offset)
        field_number = key >> 3
        wire_type = key & 0x07
        if field_number <= 0:
            raise ValueError("invalid protobuf field number")
        if wire_type == 0:
            value, offset = _read_varint(data, offset)
        elif wire_type == 1:
            if offset + 8 > len(data):
                raise ValueError("truncated fixed64 field")
            value = data[offset:offset + 8]
            offset += 8
        elif wire_type == 2:
            length, offset = _read_varint(data, offset)
            if length > len(data) - offset:
                raise ValueError("truncated protobuf bytes field")
            value = data[offset:offset + length]
            offset += length
        elif wire_type == 5:
            if offset + 4 > len(data):
                raise ValueError("truncated fixed32 field")
            value = data[offset:offset + 4]
            offset += 4
        else:
            raise ValueError(f"unsupported protobuf wire type {wire_type}")
        fields.append((field_number, wire_type, value))
    return fields


def _first_bytes(
    fields: list[tuple[int, int, int | bytes]], number: int
) -> bytes | None:
    for field, wire, value in fields:
        if field == number and wire == 2 and isinstance(value, bytes):
            return value
    return None


def _all_bytes(
    fields: list[tuple[int, int, int | bytes]], number: int
) -> list[bytes]:
    return [
        value
        for field, wire, value in fields
        if field == number and wire == 2 and isinstance(value, bytes)
    ]


def _first_text(
    fields: list[tuple[int, int, int | bytes]], number: int
) -> str | None:
    value = _first_bytes(fields, number)
    if value is None:
        return None
    return value.decode("utf-8", errors="replace")


def _first_int(
    fields: list[tuple[int, int, int | bytes]], number: int
) -> int | None:
    for field, wire, value in fields:
        if field == number and wire == 0 and isinstance(value, int):
            return value
    return None


def _first_bool(
    fields: list[tuple[int, int, int | bytes]], number: int
) -> bool | None:
    value = _first_int(fields, number)
    return None if value is None else bool(value)


def _model_info(data: bytes, requested: bool = False) -> dict:
    fields = _protobuf_fields(data)
    result: dict = {}
    model_id = _first_text(fields, 1)
    if model_id:
        result["modelId"] = model_id

    if requested:
        for field, target in ((2, "maxMode"), (7, "builtInModel"), (8, "variantString") ):
            value = _first_bool(fields, field)
            if value is not None:
                result[target] = value
        parameters = []
        for parameter in _all_bytes(fields, 3):
            parameter_fields = _protobuf_fields(parameter)
            item = {}
            parameter_id = _first_text(parameter_fields, 1)
            parameter_value = _first_text(parameter_fields, 2)
            if parameter_id is not None:
                item["id"] = parameter_id
            if parameter_value is not None:
                item["value"] = parameter_value
            if item:
                parameters.append(item)
        if parameters:
            result["parameters"] = parameters
    else:
        for field, target in (
            (3, "displayModelId"),
            (4, "displayName"),
            (5, "displayNameShort"),
        ):
            value = _first_text(fields, field)
            if value:
                result[target] = value
        max_mode = _first_bool(fields, 7)
        if max_mode is not None:
            result["maxMode"] = max_mode
    return result


def _safe_run_request_metadata(data: bytes) -> tuple[dict, int]:
    """Read allowlisted AgentRunRequest fields; never inspect content fields."""
    fields = _protobuf_fields(data)
    result: dict = {}
    score = 0

    for field, key in (
        (5, "conversationId"),
        (16, "conversationGroupId"),
        (11, "subagentTypeName"),
        (13, "harness"),
        (18, "devRawModelSlug"),
    ):
        value = _first_text(fields, field)
        if value:
            result[key] = value
            score += 2

    for field, key in (
        (10, "suggestNextPrompt"),
        (12, "excludeWorkspaceContext"),
        (19, "clientSupportsInlineImages"),
        (21, "canCreateCloudSubagents"),
        (22, "suppressSubagentProgressUpdateTool"),
        (23, "clientSupportsSendToUser"),
    ):
        value = _first_bool(fields, field)
        if value is not None:
            result[key] = value

    # These are safe size/count summaries. Their contents can contain prompts,
    # code, paths, or tool data and are deliberately not decoded.
    for field, key in (
        (1, "conversationStateBytes"),
        (2, "actionBytes"),
        (4, "mcpToolsBytes"),
        (6, "mcpFileSystemOptionsBytes"),
        (7, "skillOptionsBytes"),
    ):
        value = _first_bytes(fields, field)
        if value is not None:
            result[key] = len(value)

    pre_fetched = _all_bytes(fields, 17)
    if pre_fetched:
        result["preFetchedBlobCount"] = len(pre_fetched)

    model_details = _first_bytes(fields, 3)
    if model_details is not None:
        result["modelDetails"] = _model_info(model_details)
        score += 3

    requested_model = _first_bytes(fields, 9)
    if requested_model is not None:
        result["requestedModel"] = _model_info(requested_model, requested=True)
        score += 3

    selected_models = []
    for model in _all_bytes(fields, 14):
        info = _model_info(model, requested=True)
        if info:
            selected_models.append(info)
    if selected_models:
        result["selectedSubagentModels"] = selected_models
        score += 1

    selected_details = []
    for details in _all_bytes(fields, 15):
        info = _model_info(details)
        if info:
            selected_details.append(info)
    if selected_details:
        result["selectedSubagentModelDetails"] = selected_details

    return result, score


def _connect_messages(data: bytes) -> tuple[list[bytes], list[int]]:
    messages = []
    flags = []
    buffer = bytearray(data)
    for flag, payload in _take_frames(buffer):
        flags.append(flag)
        if flag & 0x02:
            continue
        messages.append(_decode_frame(flag, payload))
    if buffer:
        raise ValueError(f"Connect body has {len(buffer)} trailing bytes")
    return messages, flags


def _request_metadata(data: bytes) -> dict:
    result: dict = {
        "requestBodyBytes": len(data),
    }
    if not data:
        return result
    try:
        messages, flags = _connect_messages(data)
        result["requestFrameCount"] = len(flags)
        result["requestFrameFlags"] = flags
        best = {}
        best_score = -1
        for message in messages:
            fields = _protobuf_fields(message)
            # AgentClientMessage.run_request is field 1. Include the direct
            # message as a fallback for protocol variants.
            candidates = [
                value
                for field, wire, value in fields
                if field == 1 and wire == 2 and isinstance(value, bytes)
            ] + [message]
            for candidate in candidates:
                try:
                    metadata, score = _safe_run_request_metadata(candidate)
                except ValueError:
                    continue
                if score > best_score:
                    best = metadata
                    best_score = score
        result.update(best)
    except (ValueError, OSError, gzip.BadGzipFile) as error:
        result["requestDecodeError"] = str(error)
    return result


def _decode_frame(flag: int, payload: bytes) -> bytes:
    # Connect's compressed-message flag is bit 0. Bit 1 is an end-stream
    # envelope and is intentionally not protobuf-decoded here.
    if flag & 0x01:
        return gzip.decompress(payload)
    return payload


def _take_frames(buffer: bytearray) -> Iterator[tuple[int, bytes]]:
    while len(buffer) >= 5:
        flag = buffer[0]
        length = int.from_bytes(buffer[1:5], "big")
        if length > MAX_FRAME_BYTES:
            raise ValueError(f"Connect frame too large: {length}")
        end = 5 + length
        if len(buffer) < end:
            return
        payload = bytes(buffer[5:end])
        del buffer[:end]
        yield flag, payload


def _new_event_state() -> dict:
    return {
        "eventCounts": Counter(),
        "serverMessageFields": Counter(),
        "textDeltaBytes": 0,
        "thinkingDeltaBytes": 0,
        "thinkingDurationMs": 0,
        "summaryBytes": 0,
        "promptSuggestionBytes": 0,
        "postRequestPromptBytes": 0,
        "activeBranchChangeBytes": 0,
        "userMessageBytes": 0,
        "toolArgsDeltaBytes": 0,
        "tokenDeltaCount": 0,
        "tokenDeltaTokens": 0,
        "toolCallEvents": [],
        "modelCallIds": set(),
        "stepIds": [],
        "stepDurationsMs": [],
        "usageSequence": 0,
    }


def _record_tool_event(state: dict, name: str, data: bytes) -> None:
    fields = _protobuf_fields(data)
    call_id = _first_text(fields, 1)
    # PartialToolCallUpdate stores model_call_id in field 4; the other
    # tool-call update messages use field 3. Never treat args_text_delta as an
    # identifier or persist its contents.
    model_call_id = _first_text(fields, 4 if name == "partialToolCall" else 3)
    if model_call_id:
        state["modelCallIds"].add(model_call_id)
    event = {"kind": name}
    if call_id:
        event["callId"] = call_id
    if model_call_id:
        event["modelCallId"] = model_call_id
    state["toolCallEvents"].append(event)


def _usage_from_turn_ended(data: bytes) -> dict | None:
    counters = {
        field: number
        for field, wire, number in _protobuf_fields(data)
        if wire == 0 and field in range(1, 6) and isinstance(number, int)
    }
    if not counters:
        return None
    total_input = counters.get(1, 0)
    cache_read = counters.get(3, 0)
    return {
        "reportedInputTokens": total_input,
        "inputTokens": max(0, total_input - cache_read),
        "outputTokens": counters.get(2, 0),
        "cacheReadTokens": cache_read,
        "cacheWriteTokens": counters.get(4, 0),
        "reasoningTokens": counters.get(5, 0),
    }


def _inspect_server_message(data: bytes, state: dict) -> list[dict]:
    usages = []
    for outer_field, outer_wire, outer_value in _protobuf_fields(data):
        state["serverMessageFields"][str(outer_field)] += 1
        if outer_field != 1 or outer_wire != 2 or not isinstance(outer_value, bytes):
            continue
        for update_field, update_wire, update_value in _protobuf_fields(outer_value):
            if update_wire != 2 or not isinstance(update_value, bytes):
                continue
            name = EVENT_NAMES.get(update_field, f"field{update_field}")
            state["eventCounts"][name] += 1

            if update_field == 1:
                text = _first_bytes(_protobuf_fields(update_value), 1)
                state["textDeltaBytes"] += len(text or b"")
            elif update_field == 4:
                text = _first_bytes(_protobuf_fields(update_value), 1)
                state["thinkingDeltaBytes"] += len(text or b"")
            elif update_field == 5:
                duration = _first_int(_protobuf_fields(update_value), 1)
                state["thinkingDurationMs"] += duration or 0
            elif update_field == 6:
                state["userMessageBytes"] += len(update_value)
            elif update_field == 7:
                fields = _protobuf_fields(update_value)
                delta = _first_bytes(fields, 3)
                state["toolArgsDeltaBytes"] += len(delta or b"")
                _record_tool_event(state, name, update_value)
            elif update_field in (2, 3, 15):
                _record_tool_event(state, name, update_value)
            elif update_field == 8:
                fields = _protobuf_fields(update_value)
                state["tokenDeltaCount"] += 1
                state["tokenDeltaTokens"] += _first_int(fields, 1) or 0
            elif update_field in (9, 11):
                text = _first_bytes(_protobuf_fields(update_value), 1)
                state["summaryBytes"] += len(text or b"")
            elif update_field == 14:
                usage = _usage_from_turn_ended(update_value)
                if usage is not None:
                    usages.append(usage)
            elif update_field == 16:
                step_id = _first_int(_protobuf_fields(update_value), 1)
                if step_id is not None:
                    state["stepIds"].append(step_id)
            elif update_field == 17:
                fields = _protobuf_fields(update_value)
                step_id = _first_int(fields, 1)
                duration = _first_int(fields, 2)
                if step_id is not None:
                    state["stepIds"].append(step_id)
                if duration is not None:
                    state["stepDurationsMs"].append(duration)
            elif update_field == 18:
                suggestion = _first_bytes(_protobuf_fields(update_value), 1)
                state["promptSuggestionBytes"] += len(suggestion or b"")
            elif update_field == 19:
                state["postRequestPromptBytes"] += sum(
                    len(value)
                    for _, wire, value in _protobuf_fields(update_value)
                    if wire == 2 and isinstance(value, bytes)
                )
            elif update_field == 20:
                state["activeBranchChangeBytes"] += sum(
                    len(value)
                    for _, wire, value in _protobuf_fields(update_value)
                    if wire == 2 and isinstance(value, bytes)
                )
            elif update_field == 12:
                # Shell output is intentionally counted but not decoded.
                state["shellOutputBytes"] = state.get("shellOutputBytes", 0) + len(
                    update_value
                )
    return usages


def _event_snapshot(state: dict) -> dict:
    snapshot = {
        "eventCounts": dict(state["eventCounts"]),
        "serverMessageFields": dict(state["serverMessageFields"]),
        "textDeltaBytes": state["textDeltaBytes"],
        "thinkingDeltaBytes": state["thinkingDeltaBytes"],
        "thinkingDurationMs": state["thinkingDurationMs"],
        "summaryBytes": state["summaryBytes"],
        "promptSuggestionBytes": state["promptSuggestionBytes"],
        "postRequestPromptBytes": state["postRequestPromptBytes"],
        "activeBranchChangeBytes": state["activeBranchChangeBytes"],
        "userMessageBytes": state["userMessageBytes"],
        "toolArgsDeltaBytes": state["toolArgsDeltaBytes"],
        "shellOutputBytes": state.get("shellOutputBytes", 0),
        "tokenDeltaCount": state["tokenDeltaCount"],
        "tokenDeltaTokens": state["tokenDeltaTokens"],
        "toolCallEvents": state["toolCallEvents"],
        "modelCallIds": sorted(state["modelCallIds"]),
        "stepIds": state["stepIds"],
        "stepDurationsMs": state["stepDurationsMs"],
    }
    return snapshot


def requestheaders(flow: http.HTTPFlow) -> None:
    if not _target(flow):
        return

    state = {
        "buffer": bytearray(),
        "chunks": 0,
        "bytes": 0,
        "complete": False,
    }
    _request_states[flow.id] = state

    def observe_request(data: bytes) -> bytes:
        if data:
            state["chunks"] += 1
            state["bytes"] += len(data)
            state["buffer"].extend(data)
        else:
            state["complete"] = True
        return data

    # stream_large_bodies also streams request bodies. Capture the bytes only
    # in memory so the request protobuf can be reduced to allowlisted fields.
    flow.request.stream = observe_request


def responseheaders(flow: http.HTTPFlow) -> None:
    if not _target(flow) or flow.response is None:
        return

    request_state = _request_states.pop(flow.id, None)
    if request_state is not None:
        request_body = bytes(request_state["buffer"])
    else:
        request_body = flow.request.content or b""

    OUTPUT_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    raw_path = OUTPUT_DIR / f"{flow.id}.response.bin"
    raw_file = raw_path.open("wb") if CAPTURE_RAW else None
    if raw_file is not None:
        os.chmod(raw_path, 0o600)

    request_metadata = _request_metadata(request_body)
    if request_state is not None:
        request_metadata["requestChunks"] = request_state["chunks"]
        request_metadata["requestStreamBytes"] = request_state["bytes"]
        request_metadata["requestStreamComplete"] = request_state["complete"]
    request_id = flow.request.headers.get("x-request-id", "")
    state = {
        "flowId": flow.id,
        "requestId": request_id,
        "startedAt": time.time(),
        "buffer": bytearray(),
        "chunks": 0,
        "bytes": 0,
        "frames": 0,
        "requestMetadata": request_metadata,
        **_new_event_state(),
    }
    _write_log({
        "kind": "response-start",
        "flowId": flow.id,
        "requestId": request_id,
        "startedAt": state["startedAt"],
        "status": flow.response.status_code,
        "contentType": flow.response.headers.get("content-type", ""),
        "connectContentEncoding": flow.response.headers.get(
            "connect-content-encoding", ""
        ),
        "request": request_metadata,
        "rawCapture": CAPTURE_RAW,
    })

    def observe(data: bytes) -> bytes:
        if data:
            state["chunks"] += 1
            state["bytes"] += len(data)
            if raw_file is not None:
                raw_file.write(data)
                raw_file.flush()
            state["buffer"].extend(data)
            try:
                for flag, payload in _take_frames(state["buffer"]):
                    state["frames"] += 1
                    if flag & 0x02:
                        _write_log({
                            "kind": "connect-frame",
                            "flowId": flow.id,
                            "requestId": request_id,
                            "flag": flag,
                            "wireBytes": len(payload),
                            "endStream": True,
                        })
                        continue
                    decoded = _decode_frame(flag, payload)
                    _write_log({
                        "kind": "connect-frame",
                        "flowId": flow.id,
                        "requestId": request_id,
                        "flag": flag,
                        "wireBytes": len(payload),
                        "decodedBytes": len(decoded),
                    })
                    usages = _inspect_server_message(decoded, state)
                    for usage in usages:
                        state["usageSequence"] += 1
                        _write_log({
                            "kind": "usage",
                            "flowId": flow.id,
                            "requestId": request_id,
                            "usageSequence": state["usageSequence"],
                            "capturedAt": time.time(),
                            "startedAt": state["startedAt"],
                            "endedAt": time.time(),
                            "request": request_metadata,
                            **usage,
                            "events": _event_snapshot(state),
                        })
            except (ValueError, OSError, gzip.BadGzipFile) as error:
                _write_log({
                    "kind": "decode-error",
                    "flowId": flow.id,
                    "requestId": request_id,
                    "message": str(error),
                })
        else:
            if state["buffer"]:
                _write_log({
                    "kind": "connect-remainder",
                    "flowId": flow.id,
                    "requestId": request_id,
                    "bytes": len(state["buffer"]),
                })
            _write_log({
                "kind": "response-end",
                "flowId": flow.id,
                "requestId": request_id,
                "endedAt": time.time(),
                "chunks": state["chunks"],
                "bytes": state["bytes"],
                "frames": state["frames"],
                "elapsedMs": round((time.time() - state["startedAt"]) * 1000),
                "events": _event_snapshot(state),
            })
            if raw_file is not None:
                raw_file.close()
        return data

    # The callback observes each chunk and returns it unchanged to Cursor.
    flow.response.stream = observe


addons = [requestheaders, responseheaders]
