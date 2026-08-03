# Mitmproxy testing

Local setup for observing and deliberately interrupting Pi or Codex network
sessions. The proxy is currently intended for local testing only.

## Local state

`mitmweb` runs the regular proxy and its dashboard in one process:

```text
Proxy:    http://127.0.0.1:8080
Dashboard: http://127.0.0.1:8082
```

The current process and dashboard password are tracked locally here:

```text
~/.mitmproxy/frugal-test-mitmweb.pid
~/.mitmproxy/frugal-test-mitmweb.log
~/.mitmproxy/frugal-test-mitmweb.token  # mode 0600
```

The mitmproxy CA is generated at:

```text
~/.mitmproxy/mitmproxy-ca-cert.pem
```

Port `8080` is a proxy endpoint, not a web page. Use the dashboard on `8082`.

## Trust setup

Node-based Pi/OpenCode processes use `NODE_EXTRA_CA_CERTS`. Native Codex CLI
also needed the CA trusted in the macOS user login keychain:

```bash
security add-trusted-cert \
  -r trustRoot -p ssl \
  -k "$HOME/Library/Keychains/login.keychain-db" \
  "$HOME/.mitmproxy/mitmproxy-ca-cert.pem"
```

Restart Codex after changing trust settings. For native clients that honor the
OpenSSL-style variable, also export:

```bash
export SSL_CERT_FILE="$HOME/.mitmproxy/mitmproxy-ca-cert.pem"
export CURL_CA_BUNDLE="$SSL_CERT_FILE"
export REQUESTS_CA_BUNDLE="$SSL_CERT_FILE"
```

## Shell environment

Export these in the terminal that launches the harness:

```bash
export MITM_PROXY=http://127.0.0.1:8080
export HTTP_PROXY="$MITM_PROXY"
export HTTPS_PROXY="$MITM_PROXY"
export ALL_PROXY="$MITM_PROXY"
export http_proxy="$MITM_PROXY"
export https_proxy="$MITM_PROXY"
export all_proxy="$MITM_PROXY"
export NO_PROXY=localhost,127.0.0.1,::1

export NODE_EXTRA_CA_CERTS="$HOME/.mitmproxy/mitmproxy-ca-cert.pem"
export CURL_CA_BUNDLE="$NODE_EXTRA_CA_CERTS"
export REQUESTS_CA_BUNDLE="$NODE_EXTRA_CA_CERTS"
export SSL_CERT_FILE="$NODE_EXTRA_CA_CERTS"
```

Do not add `chatgpt.com` or the MCP hosts to `NO_PROXY`.

## Pi with telemetry

From this repository, the wrapper enables the raw Codex WebSocket wiretap and
loads the cache telemetry extension:

```bash
cd /Users/danclark/programming/frugal-tokens
tools/pi-cache-telemetry/run-with-codex-wiretap.sh \
  -e ./tools/pi-cache-telemetry/extensions/cache-telemetry.ts
```

The wiretap is sensitive: it contains raw prompts, tool data, and model output.

## Dashboard and flow filters

Open:

```text
http://127.0.0.1:8082
```

Useful mitmweb filters:

```text
~websocket
~websocket & ~u /backend-api/codex/responses
~websocket & ~u chatgpt.com
```

The analytics endpoint is not the model response. Model traffic should use a
path containing `/backend-api/codex/responses`; it may be a WebSocket or SSE
HTTP flow. A flow only appears while the harness is active or after it has
completed.

A passive proxy smoke test, where a `403` from ChatGPT is acceptable, is:

```bash
curl --proxy http://127.0.0.1:8080 \
  --cacert "$HOME/.mitmproxy/mitmproxy-ca-cert.pem" \
  -I https://chatgpt.com/
```

## Manually kill the current response

This helper authenticates to mitmweb, finds the newest live `/responses` flow,
and kills it on demand. It supports WebSocket upgrade flows and active SSE
response flows:

```bash
MITM_KILL_URL_SUBSTRING=/responses \
  tools/pi-cache-telemetry/mitm-kill-current.sh
```

It is passive until manually invoked. If no response is active, it reports no
match and does not kill anything. For another harness, narrow the match to its
response URL; an empty substring is broader and should be used carefully.

## Automatic one-shot interruption

[`mitm-kill-websocket.py`](./mitm-kill-websocket.py) is passive unless armed.
It kills the first matching Codex WebSocket after a configurable number of
incoming server frames:

```bash
PID=$(cat ~/.mitmproxy/frugal-test-mitmweb.pid)
kill "$PID"

MITM_KILL_ENABLED=1 \
MITM_KILL_MATCH_TYPE=response.function_call_arguments.delta \
MITM_KILL_AFTER=500 \
nohup mitmweb \
  --mode regular \
  --listen-host 127.0.0.1 --listen-port 8080 \
  --web-host 127.0.0.1 --web-port 8082 \
  --no-web-open-browser \
  -s /Users/danclark/programming/frugal-tokens/tools/pi-cache-telemetry/mitm-kill-websocket.py \
  --set "web_password=$(cat ~/.mitmproxy/frugal-test-mitmweb.token)" \
  >~/.mitmproxy/frugal-test-mitmweb.log 2>&1 &
echo $! >~/.mitmproxy/frugal-test-mitmweb.pid
```

To return to passive mode, restart `mitmweb` without `-s` and without
`MITM_KILL_ENABLED=1`.

## Interpretation

A useful reproduction signature is:

```text
warm continuation
-> injected WebSocket failure
-> full-context retry or SSE fallback
-> zero/low cache read
-> cache recovery
```

The proxy proves client fallback behavior, not that a naturally occurring
failure originated at OpenAI. Intercepted traffic can contain credentials,
prompts, tool arguments/results, and model output; do not share flow dumps.
