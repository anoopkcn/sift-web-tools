# sift-web-tools

Adds LLM-callable tools (`web_search`, `web_fetch`, `web_save`, `web_artifacts`, `web_clean`) that give pi local-first web access via the [`sift`](https://github.com/anoopkcn/sift) CLI.

## Install

```sh
pi install npm:sift-web-tools
```

For local testing before publishing:

```sh
pi install /Users/akc/develop/sift-web-tools
# or for one run only:
pi -e /Users/akc/develop/sift-web-tools
```

Requires the `sift` CLI to be installed and available on `$PATH`; see [Prerequisites](#prerequisites).

## Tools

- `web_search(query, max_results?)` — Runs `sift search <query> --json` (DuckDuckGo by default; SearXNG if configured) and renders the top results as a markdown list with titles, URLs, and snippets.
- `web_fetch(url)` — Runs `sift fetch <url> --json` and returns the page's primary content as clean markdown, plus `title` / `final_url` / `status` / `kind` in the result details.
- `web_save(url, mode?, filename?, force?)` — Runs `sift fetch <url> --out /tmp/sift-web-tools/...` and returns the saved local path instead of loading the content into context. Use it for large pages, PDFs, images, media, or files the agent should inspect later with `read`, `grep`, or `bash`. `mode` is `rendered` by default; `raw` saves original response bytes.
- `web_artifacts(limit?)` — Lists files saved under `/tmp/sift-web-tools/`, newest first, with paths, sizes, kinds, and modification times. Also available as `/web_artifacts [limit]`.
- `web_clean(older_than_minutes?, all?, dry_run?)` — Deletes saved artifacts. By default deletes files older than 1440 minutes; set `all: true` to delete everything or `dry_run: true` to preview matches. Also available as `/web_clean [older_than_minutes|all] [dry-run]`.

To fetch multiple URLs, the agent issues parallel `web_fetch` or `web_save` tool calls in a single turn — sift instances run concurrently (one child process per URL). Artifact listing is read-only; cleanup runs sequentially.

The tools are local: queries and URLs are not forwarded to any third-party API. The agent talks to a child `sift` process on your machine, which in turn uses `curl` for the actual HTTP request.

## Prerequisites

- `sift` CLI installed and available in the system's `$PATH`.
- `curl` used by sift for transport.
- `pdftotext`(optional) only required if you want `web_fetch` to handle PDFs.

### Get pre-built binaries
- [Get the latest release](https://github.com/anoopkcn/sift/releases)
- Put the `sift` binary somewhere in your `$PATH` (e.g. `~/.local/bin/` or `/usr/local/bin/`).

### Install from source
- `git clone https://github.com/anoopkcn/sift` 
- `zig build -Doptimize=ReleaseSafe`
- and copy `zig-out/bin/sift` to `~/.local/bin/` or `/usr/local/bin/`.

### Configuration
To override the binary location, set `SIFT_BIN` to a full path:

```sh
export SIFT_BIN="$HOME/.local/bin/sift" # or wherever you put it
```

(Optional) To use SearXNG instead of DuckDuckGo for search, set `sift`'s native env var:

```sh
export SIFT_SEARXNG_URL="https://your-searxng.example/search" # Replace the URL with your SearXNG instance's search endpoint
```
(no extension change needed — sift reads it directly).

## Limits

- `web_search` truncates the rendered list to roughly `max_results × 1600` chars (hard ceiling 30k) to keep the agent's context tidy.
- `web_fetch` returns whatever `sift fetch` produces; sift enforces its own size cap, so the extension does not re-truncate.
- `web_save` stores artifacts under `/tmp/sift-web-tools/` and returns only path/size/mode hints to keep context small.
- `web_save` filenames are sanitized, path components are stripped, and an 8-char URL hash is appended to reduce collisions.
- `web_artifacts` and `web_clean` operate only on regular files directly inside `/tmp/sift-web-tools/`; they do not recurse into subdirectories.
- `web_fetch` and `web_save` reject non-`http(s)` schemes (`file://`, `data:`, etc.) before spawning sift.
- A 30-second timeout is passed to sift via `--timeout`.
- Execution uses pi's `pi.exec()` with the agent abort signal and an outer timeout; cancellation/timeout terminates the child process promptly.

## Security

This extension is intended for agents whose URLs come from a trusted source (search results, user-pasted links). It is **not safe to use with untrusted URL inputs.**

- **No private-IP filtering.** Neither this extension nor the underlying `sift` CLI blocks private, loopback, or link-local addresses. URLs like `http://127.0.0.1/`, `http://localhost:6379/`, `http://10.0.0.1/`, and cloud metadata endpoints (e.g. `http://169.254.169.254/`) will be fetched.
- **No DNS rebinding protection.** Hostnames are resolved by `curl` at fetch time; a public hostname can resolve to a private address.
- **Redirects are scheme-locked but not IP-revalidated.** `sift` enforces http/https on redirects (max 10 hops) but does not re-check whether the destination IP is private.
- **TLS verification is on by default.** `sift` does not expose an `--insecure` flag.
- **Response size is capped at 50 MB by `sift`.** Larger responses fail with `transport error`.
- **Schemes are restricted.** Only `http://` and `https://` are accepted; `file://`, `data:`, `gopher://`, etc. are rejected before sift is spawned.

If you need strict SSRF defense (e.g. agent input is attacker-controlled), filter URLs upstream — resolve the hostname yourself and reject private/loopback/link-local IPs before invoking these tools.

## Failure modes

Errors are thrown from the tool execution so pi marks the tool result as failed, with sift's exit code context included:

- `transport error: ...` — exit 3 from sift (curl failed, HTTP 4xx/5xx, response > 50 MB).
- `page requires JavaScript (SPA) — sift cannot render it` — exit 4. sift has no JS engine; report and move on rather than retrying.
- `output file exists: ...` — exit 5 from sift if an output path collision still occurs.
- `unsupported content type: ...` — exit 6 (e.g. PDF without `pdftotext` installed).
- `sift returned invalid JSON ...` — sift emitted non-JSON in `--json` mode; the message includes a sample of the actual output for debugging.
- `sift binary not found ...` — install sift or set `SIFT_BIN`.
