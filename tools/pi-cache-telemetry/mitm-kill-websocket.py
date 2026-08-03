"""One-shot WebSocket failure injector for mitmproxy.

Passive unless MITM_KILL_ENABLED=1 is set. The default target is the Codex
Responses WebSocket. It kills the first matching flow after 100 incoming server
messages, without sending a normal WebSocket close frame.

Examples:

  MITM_KILL_ENABLED=1 MITM_KILL_AFTER=100 \
    mitmweb -s tools/pi-cache-telemetry/mitm-kill-websocket.py

  MITM_KILL_ENABLED=1 MITM_KILL_MATCH_TYPE=response.function_call_arguments.delta \
  MITM_KILL_AFTER=500 \
    mitmweb -s tools/pi-cache-telemetry/mitm-kill-websocket.py

The addon deliberately does not log message contents.
"""

import json
import os

from mitmproxy import ctx, http


class KillWebSocket:
    def __init__(self):
        self.enabled = os.environ.get("MITM_KILL_ENABLED") == "1"
        self.after = max(1, int(os.environ.get("MITM_KILL_AFTER", "100")))
        self.match_type = os.environ.get("MITM_KILL_MATCH_TYPE", "")
        self.url_substring = os.environ.get(
            "MITM_KILL_URL_SUBSTRING", "/backend-api/codex/responses"
        )
        self.count = 0
        self.killed = False

        ctx.log.info(
            "WebSocket killer: %s; after=%d; type=%s; url=%s"
            % (
                "armed" if self.enabled else "passive",
                self.after,
                self.match_type or "any",
                self.url_substring or "any",
            )
        )

    def websocket_message(self, flow: http.HTTPFlow):
        if not self.enabled or self.killed or flow.websocket is None:
            return
        if self.url_substring and self.url_substring not in flow.request.pretty_url:
            return

        message = flow.websocket.messages[-1]
        if message.from_client:
            return

        event_type = "unknown"
        try:
            content = message.content
            if isinstance(content, bytes):
                content = content.decode("utf-8", errors="replace")
            payload = json.loads(content)
            event_type = payload.get("type", "unknown")
        except (TypeError, UnicodeDecodeError, json.JSONDecodeError):
            payload = None

        if self.match_type and event_type != self.match_type:
            return

        self.count += 1
        if self.count < self.after:
            return

        self.killed = True
        ctx.log.warn(
            "WebSocket killer: terminating flow after %d matching server frames "
            "(event_type=%s, url=%s)"
            % (self.count, event_type, flow.request.pretty_url)
        )
        flow.kill()


addons = [KillWebSocket()]
