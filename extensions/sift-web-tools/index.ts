import { createHash } from "node:crypto";
import { chmod, mkdir, open, readdir, stat, unlink } from "node:fs/promises";
import { basename, extname, join, parse } from "node:path";
import { formatSize, keyHint, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Container, Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "typebox";

const SEARCH_HARD_CEILING = 30000;
const SEARCH_PER_RESULT_BUDGET = 1600;
const SIFT_TIMEOUT_SEC = 30;
const ARTIFACT_DIR = "/tmp/sift-web-tools";

const WebSearchParams = Type.Object({
	query: Type.String({ description: "Search query" }),
	max_results: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 10,
			default: 5,
			description: "Hint for how many results to surface (1-10, default 5).",
		}),
	),
});

const WebFetchParams = Type.Object({
	url: Type.String({ description: "Absolute http(s) URL to fetch" }),
	max_chars: Type.Optional(
		Type.Integer({
			minimum: 500,
			maximum: 100000,
			default: 20000,
			description: "Truncate returned markdown to this many chars (default 20000).",
		}),
	),
});

const WebSaveParams = Type.Object({
	url: Type.String({ description: "Absolute http(s) URL to fetch and save under /tmp/sift-web-tools/" }),
	mode: Type.Optional(
		StringEnum(["rendered", "raw"] as const, {
			default: "rendered",
			description:
				"Save mode. rendered saves sift's extracted markdown/text for HTML/PDF/text/JSON/XML and downloads media; raw saves original response bytes.",
		}),
	),
	filename: Type.Optional(
		Type.String({ description: "Optional safe filename hint; path components are stripped and a URL hash is appended." }),
	),
	force: Type.Optional(Type.Boolean({ default: false, description: "Overwrite the selected output file if it exists." })),
});

const WebArtifactsParams = Type.Object({
	limit: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 200,
			default: 50,
			description: "Maximum number of artifacts to list (newest first).",
		}),
	),
});

const WebCleanParams = Type.Object({
	older_than_minutes: Type.Optional(
		Type.Integer({
			minimum: 0,
			default: 1440,
			description: "Delete artifacts older than this many minutes. Ignored when all=true.",
		}),
	),
	all: Type.Optional(Type.Boolean({ default: false, description: "Delete all artifacts in /tmp/sift-web-tools/." })),
	dry_run: Type.Optional(Type.Boolean({ default: false, description: "List matching artifacts without deleting them." })),
});

interface SearchDetails {
	query: string;
	length: number;
	truncated: boolean;
	source: "sift";
}

interface FetchDetails {
	url: string;
	length: number;
	truncated: boolean;
	source: "sift";
	final_url?: string;
	title?: string;
	status?: number;
	kind?: string;
}

interface SaveDetails {
	url: string;
	path: string;
	size: number;
	mode: "rendered" | "raw";
	source: "sift";
	artifact_dir: string;
	kind?: string;
}

interface ArtifactInfo {
	name: string;
	path: string;
	size: number;
	modified: number;
	kind: string;
}

interface ArtifactsDetails {
	artifact_dir: string;
	total: number;
	returned: number;
	files: ArtifactInfo[];
}

interface CleanDetails {
	artifact_dir: string;
	matched: number;
	deleted: number;
	dry_run: boolean;
	files: ArtifactInfo[];
}

interface SiftSearchJson {
	query: string;
	results: Array<{ title: string; url: string; snippet: string }>;
}

interface SiftFetchJson {
	url: string;
	final_url?: string;
	status?: number;
	kind?: string;
	title?: string;
	markdown: string;
	fetched_at?: number;
}

async function siftRun(pi: ExtensionAPI, args: string[], signal: AbortSignal | undefined): Promise<string> {
	const bin = process.env.SIFT_BIN || "sift";
	const result = await pi.exec(bin, args, {
		signal,
		// Give sift's own --timeout a small grace period before pi kills the process.
		timeout: (SIFT_TIMEOUT_SEC + 5) * 1000,
	});

	if (result.code === 0) return result.stdout;
	if (signal?.aborted) throw new Error("aborted");
	if (result.killed) throw new Error(`sift timed out after ${SIFT_TIMEOUT_SEC} seconds`);

	const stderr = result.stderr.trim();
	if (result.code === 1 && !stderr) {
		throw new Error(
			`sift binary not found (tried "${bin}"). Install from https://github.com/akc/sift or set SIFT_BIN to its full path.`,
		);
	}

	const tail = stderr ? `: ${stderr.slice(0, 300)}` : "";
	switch (result.code) {
		case 2:
			throw new Error(`sift bad arguments${tail}`);
		case 3:
			throw new Error(`transport error${tail}`);
		case 4:
			throw new Error("page requires JavaScript (SPA) — sift cannot render it");
		case 5:
			throw new Error(`output file exists${tail}`);
		case 6:
			throw new Error(`unsupported content type${tail}`);
		default:
			throw new Error(`sift exited with code ${result.code}${tail}`);
	}
}

function parseSiftJson<T>(stdout: string): T {
	try {
		return JSON.parse(stdout) as T;
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		const sample = stdout.trim().slice(0, 200);
		throw new Error(`sift returned invalid JSON (${reason}); output: ${sample}`);
	}
}

function truncate(text: string, max: number): { text: string; truncated: boolean } {
	if (text.length <= max) return { text, truncated: false };
	return {
		text: `${text.slice(0, max).trimEnd()}\n\n[truncated, full length=${text.length}]`,
		truncated: true,
	};
}

function isLikelyHttpUrl(u: string): boolean {
	return /^https?:\/\//i.test(u);
}

const MEDIA_EXTENSIONS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".svg",
	".avif",
	".bmp",
	".ico",
	".mp3",
	".mp4",
	".m4a",
	".wav",
	".webm",
	".mov",
	".ogg",
]);
const TEXT_EXTENSIONS = new Set([".md", ".txt", ".json", ".xml", ".csv", ".tsv", ".log", ".yaml", ".yml"]);
const SAFE_RAW_EXTENSIONS = new Set([...MEDIA_EXTENSIONS, ...TEXT_EXTENSIONS, ".pdf", ".html", ".htm"]);

async function ensureArtifactDir(): Promise<void> {
	await mkdir(ARTIFACT_DIR, { recursive: true, mode: 0o700 });
	await chmod(ARTIFACT_DIR, 0o700).catch(() => undefined);
}

function safeSlug(input: string, fallback = "download"): string {
	const slug = input
		.toLowerCase()
		.replace(/\.[a-z0-9]{1,16}$/i, "")
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/\.{2,}/g, ".")
		.slice(0, 80);
	return slug || fallback;
}

function urlPathParts(url: string): { stem: string; ext: string } {
	try {
		const parsedUrl = new URL(url);
		const base = basename(parsedUrl.pathname) || parsedUrl.hostname || "download";
		let ext = extname(base).toLowerCase();
		const lowerBase = base.toLowerCase();
		if (!ext && SAFE_RAW_EXTENSIONS.has(`.${lowerBase}`)) ext = `.${lowerBase}`;
		return { stem: safeSlug(base), ext };
	} catch {
		return { stem: "download", ext: "" };
	}
}

function pickArtifactExtension(urlExt: string, mode: "rendered" | "raw", filenameExt: string): string {
	const requestedExt = filenameExt.toLowerCase();
	if (requestedExt && /^\.[a-z0-9]{1,16}$/.test(requestedExt)) return requestedExt;
	if (mode === "raw") return SAFE_RAW_EXTENSIONS.has(urlExt) ? urlExt : ".bin";
	if (MEDIA_EXTENSIONS.has(urlExt) || TEXT_EXTENSIONS.has(urlExt)) return urlExt;
	return ".md";
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw err;
	}
}

async function artifactPathFor(url: string, mode: "rendered" | "raw", filename: string | undefined, force: boolean): Promise<string> {
	const urlParts = urlPathParts(url);
	const fileBase = filename ? basename(filename) : "";
	const parsedFile = fileBase ? parse(fileBase) : undefined;
	const stem = safeSlug(parsedFile?.name || urlParts.stem);
	const ext = pickArtifactExtension(urlParts.ext, mode, parsedFile?.ext || "");
	const hash = createHash("sha256").update(url).digest("hex").slice(0, 8);
	const basePath = join(ARTIFACT_DIR, `${stem}-${hash}${ext}`);
	if (force || !(await pathExists(basePath))) return basePath;

	for (let i = 2; i < 1000; i++) {
		const candidate = join(ARTIFACT_DIR, `${stem}-${hash}-${i}${ext}`);
		if (!(await pathExists(candidate))) return candidate;
	}
	throw new Error(`could not allocate an artifact path in ${ARTIFACT_DIR}`);
}

async function detectSavedKind(path: string): Promise<string> {
	const handle = await open(path, "r");
	try {
		const head = Buffer.alloc(16);
		const { bytesRead } = await handle.read(head, 0, head.length, 0);
		const bytes = head.subarray(0, bytesRead);
		if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
		if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
		if (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
		if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
		if (bytes.subarray(0, 4).toString("ascii") === "%PDF") return "pdf";
	} finally {
		await handle.close();
	}

	const ext = extname(path).toLowerCase();
	if (MEDIA_EXTENSIONS.has(ext)) return ext.slice(1);
	if (ext === ".pdf") return "pdf";
	if (TEXT_EXTENSIONS.has(ext)) return ext.slice(1);
	if (ext === ".bin") return "binary";
	return ext ? ext.slice(1) : "unknown";
}

async function listArtifacts(): Promise<ArtifactInfo[]> {
	try {
		const entries = await readdir(ARTIFACT_DIR, { withFileTypes: true });
		const files = await Promise.all(
			entries
				.filter((entry) => entry.isFile())
				.map(async (entry) => {
					const path = join(ARTIFACT_DIR, entry.name);
					const info = await stat(path);
					return {
						name: entry.name,
						path,
						size: info.size,
						modified: info.mtimeMs,
						kind: await detectSavedKind(path).catch(() => "unknown"),
					} satisfies ArtifactInfo;
				}),
		);
		return files.sort((a, b) => b.modified - a.modified);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
}

function formatArtifactLine(file: ArtifactInfo, index: number): string {
	return `${index + 1}. ${file.path}\n   ${formatSize(file.size)} · ${file.kind} · modified ${new Date(file.modified).toISOString()}`;
}

function formatArtifactsList(files: ArtifactInfo[], total: number): string {
	if (!files.length) return `(no artifacts in ${ARTIFACT_DIR})`;
	const text = files.map(formatArtifactLine).join("\n\n");
	const remaining = total - files.length;
	return remaining > 0 ? `${text}\n\n[${remaining} more artifact(s); increase limit to show more.]` : text;
}

function parseLimitArg(args: string, defaultLimit: number): number {
	const trimmed = args.trim();
	const match = trimmed.match(/(?:^|\s)(?:limit=)?(\d+)(?:\s|$)/i);
	if (!match) return defaultLimit;
	const parsed = Number.parseInt(match[1], 10);
	if (!Number.isFinite(parsed)) return defaultLimit;
	return Math.max(1, Math.min(200, parsed));
}

function parseCleanArgs(args: string): { older_than_minutes: number; all: boolean; dry_run: boolean } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	let olderThanMinutes = 1440;
	let all = false;
	let dryRun = false;

	for (const token of tokens) {
		const lower = token.toLowerCase();
		if (lower === "all" || lower === "--all" || lower === "all=true") {
			all = true;
			continue;
		}
		if (lower === "dry" || lower === "dry-run" || lower === "--dry-run" || lower === "dry_run=true") {
			dryRun = true;
			continue;
		}
		const ageMatch = lower.match(/^(?:older_than_minutes=|older=|age=)?(\d+)$/);
		if (ageMatch) olderThanMinutes = Number.parseInt(ageMatch[1], 10);
	}

	return { older_than_minutes: Math.max(0, olderThanMinutes), all, dry_run: dryRun };
}

type ThemeLike = { fg(name: string, text: string): string };

function renderCollapsed(text: string, isError: boolean, theme: ThemeLike): Text {
	const lines = text.split("\n");
	const collapsed = lines.slice(0, 8).join("\n");
	const more = lines.length > 8 ? `\n${theme.fg("muted", keyHint("app.tools.expand", "to expand"))}` : "";
	const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
	return new Text(`${icon} ${theme.fg("toolOutput", collapsed)}${more}`, 0, 0);
}

function formatSearchResults(payload: SiftSearchJson): string {
	if (!payload.results?.length) return "(no results)";
	return payload.results
		.map((r, i) => {
			const title = (r.title || "(untitled)").trim();
			const url = (r.url || "").trim();
			const snippet = (r.snippet || "").trim();
			const head = `${i + 1}. [${title}](${url})`;
			return snippet ? `${head}\n   ${snippet}` : head;
		})
		.join("\n\n");
}


export default function (pi: ExtensionAPI) {
	pi.registerMessageRenderer("sift-web-tools", (message, _options, theme) => {
		const details = message.details as { title?: string; subtitle?: string; kind?: string } | undefined;
		const container = new Container();
		const title = details?.title ?? "sift-web-tools";
		const subtitle = details?.subtitle ? ` ${theme.fg("dim", details.subtitle)}` : "";
		container.addChild(new Text(theme.fg("accent", theme.bold(title)) + subtitle, 0, 0));
		container.addChild(new Text(String(message.content), 0, 0));
		return container;
	});

	async function showArtifactsCommand(args: string) {
		const limit = parseLimitArg(args, 50);
		const files = await listArtifacts();
		const returned = files.slice(0, limit);
		pi.sendMessage({
			customType: "sift-web-tools",
			content: formatArtifactsList(returned, files.length),
			display: true,
			details: { title: "web_artifacts", subtitle: `${returned.length}/${files.length} artifact(s)`, kind: "artifacts" },
		});
	}

	pi.registerCommand("web_artifacts", {
		description: "List saved web artifacts from /tmp/sift-web-tools/ (usage: /web_artifacts [limit])",
		handler: async (args) => showArtifactsCommand(args),
	});

	pi.registerCommand("web_artifats", {
		description: "Alias for /web_artifacts (typo-compatible). Usage: /web_artifats [limit]",
		handler: async (args) => showArtifactsCommand(args),
	});

	pi.registerCommand("web_clean", {
		description: "Delete saved web artifacts (usage: /web_clean [older_than_minutes|all] [dry-run])",
		handler: async (args) => {
			const { older_than_minutes, all, dry_run } = parseCleanArgs(args);
			const cutoff = Date.now() - older_than_minutes * 60 * 1000;
			const files = await listArtifacts();
			const matched = files.filter((file) => all || file.modified < cutoff);
			if (!dry_run) {
				await Promise.all(matched.map((file) => unlink(file.path).catch(() => undefined)));
			}

			const action = dry_run ? "Would delete" : "Deleted";
			const scope = all ? "all artifacts" : `artifacts older than ${older_than_minutes} minute(s)`;
			const shown = matched.slice(0, 50);
			const list = matched.length ? `\n\n${formatArtifactsList(shown, matched.length)}` : "";
			pi.sendMessage({
				customType: "sift-web-tools",
				content: `${action} ${matched.length} ${scope} from ${ARTIFACT_DIR}.${list}`,
				display: true,
				details: {
					title: "web_clean",
					subtitle: dry_run ? `${matched.length} matched · dry run` : `${matched.length} deleted`,
					kind: "clean",
				},
			});
		},
	});

	pi.registerTool({
		name: "web_search",
		label: "Web search",
		description:
			"Search the web for fresh information using the local `sift` CLI (DuckDuckGo by default). Returns top results as markdown with titles, URLs, and snippets. Cite returned URLs verbatim.",
		promptSnippet:
			"web_search(query) — local web search via sift; returns top results as markdown with titles and URLs.",
		promptGuidelines: [
			"Use web_search for fresh, factual lookups; cite returned URLs verbatim.",
			"On web_search transient failure, retry once with a different phrasing or fall back to a narrower query.",
		],
		parameters: WebSearchParams,
		executionMode: "parallel",

		async execute(_toolCallId, params: Static<typeof WebSearchParams>, signal, _onUpdate, _ctx) {
			const query = params.query.trim();
			const maxResults = params.max_results ?? 5;
			if (!query) throw new Error("web_search failed: empty query");

			try {
				const stdout = await siftRun(
					pi,
					[
						"search",
						query,
						"--json",
						"--limit",
						String(maxResults),
						"--timeout",
						String(SIFT_TIMEOUT_SEC),
					],
					signal,
				);
				const payload = parseSiftJson<SiftSearchJson>(stdout);
				const markdown = formatSearchResults(payload);
				const cap = Math.min(SEARCH_HARD_CEILING, maxResults * SEARCH_PER_RESULT_BUDGET);
				const { text, truncated } = truncate(markdown, cap);
				return {
					content: [{ type: "text", text: text || "(empty response)" }],
					details: {
						query,
						length: markdown.length,
						truncated,
						source: "sift",
					} satisfies SearchDetails,
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				throw new Error(`web_search failed: ${msg}`);
			}
		},

		renderCall(args, theme, _context) {
			const q = typeof args.query === "string" ? args.query : "...";
			const preview = q.length > 70 ? `${q.slice(0, 70)}...` : q;
			const max = typeof args.max_results === "number" ? args.max_results : 5;
			return new Text(
				theme.fg("toolTitle", theme.bold("web_search ")) +
					theme.fg("accent", `"${preview}"`) +
					theme.fg("muted", ` [max=${max}]`),
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme, context) {
			const block = result.content[0];
			const text = block?.type === "text" ? block.text : "(no output)";
			const details = result.details as SearchDetails | undefined;
			const isError = context.isError;

			if (expanded) {
				const container = new Container();
				const header = isError
					? theme.fg("error", "✗ web_search")
					: theme.fg("success", "✓ web_search");
				container.addChild(new Text(header, 0, 0));
				container.addChild(new Text(text, 0, 0));
				if (details && !isError) {
					container.addChild(
						new Text(theme.fg("dim", `${details.length} chars${details.truncated ? " (truncated)" : ""}`), 0, 0),
					);
				}
				return container;
			}

			return renderCollapsed(text, isError, theme);
		},
	});

	pi.registerTool({
		name: "web_fetch",
		label: "Web fetch",
		description:
			"Fetch a single http(s) URL and return its primary content as markdown via the local `sift` CLI. Use after web_search to read a specific result in full.",
		promptSnippet: "web_fetch(url) — local page fetch via sift; returns primary content as markdown.",
		promptGuidelines: [
			"Use web_fetch to read a specific URL in full after web_search surfaces it.",
			"When you have several URLs to read, emit multiple web_fetch calls in the SAME assistant turn — the runtime fans them out in parallel. Do not chain them across turns.",
			"web_fetch only accepts http(s) URLs; file:// and other schemes are rejected.",
			"web_fetch cannot render JavaScript-only SPAs via sift — those return an error you should report rather than retry.",
		],
		parameters: WebFetchParams,
		executionMode: "parallel",

		async execute(_toolCallId, params: Static<typeof WebFetchParams>, signal, _onUpdate, _ctx) {
			const url = params.url.trim();
			const maxChars = params.max_chars ?? 20000;

			if (!isLikelyHttpUrl(url)) {
				throw new Error(`web_fetch rejected non-http(s) URL: ${url}`);
			}

			try {
				const stdout = await siftRun(
					pi,
					["fetch", url, "--json", "--timeout", String(SIFT_TIMEOUT_SEC)],
					signal,
				);
				const payload = parseSiftJson<SiftFetchJson>(stdout);
				const markdown = payload.markdown ?? "";
				const { text, truncated } = truncate(markdown, maxChars);
				return {
					content: [{ type: "text", text: text || "(empty response)" }],
					details: {
						url,
						length: markdown.length,
						truncated,
						source: "sift",
						final_url: payload.final_url,
						title: payload.title,
						status: payload.status,
						kind: payload.kind,
					} satisfies FetchDetails,
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				throw new Error(`web_fetch failed: ${msg}`);
			}
		},

		renderCall(args, theme, _context) {
			const u = typeof args.url === "string" ? args.url : "...";
			const preview = u.length > 80 ? `${u.slice(0, 80)}...` : u;
			return new Text(
				theme.fg("toolTitle", theme.bold("web_fetch ")) + theme.fg("accent", preview),
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme, context) {
			const block = result.content[0];
			const text = block?.type === "text" ? block.text : "(no output)";
			const details = result.details as FetchDetails | undefined;
			const isError = context.isError;

			if (expanded) {
				const container = new Container();
				const header = isError ? theme.fg("error", "✗ web_fetch") : theme.fg("success", "✓ web_fetch");
				container.addChild(new Text(header, 0, 0));
				const inputUrl = typeof context.args.url === "string" ? context.args.url : undefined;
				const detailsUrl = typeof details?.url === "string" ? details.url : undefined;
				const url = detailsUrl ?? inputUrl;
				if (url) {
					const finalUrl = typeof details?.final_url === "string" ? details.final_url : undefined;
					const target = finalUrl && finalUrl !== url ? `${url} → ${finalUrl}` : url;
					container.addChild(new Text(theme.fg("muted", target), 0, 0));
					if (!isError && details?.title) {
						container.addChild(new Text(theme.fg("muted", details.title), 0, 0));
					}
				}
				container.addChild(new Text(text, 0, 0));
				if (details && !isError) {
					const meta: string[] = [`${details.length} chars`];
					if (details.truncated) meta.push("truncated");
					if (details.kind) meta.push(details.kind);
					if (typeof details.status === "number") meta.push(`HTTP ${details.status}`);
					container.addChild(new Text(theme.fg("dim", meta.join(" · ")), 0, 0));
				}
				return container;
			}

			return renderCollapsed(text, isError, theme);
		},
	});

	pi.registerTool({
		name: "web_save",
		label: "Web save",
		description:
			"Fetch a web URL with sift and save the result under /tmp/sift-web-tools/ instead of loading it all into context. Use for large pages, PDFs, images, media, or files that should be inspected later with read/grep/bash.",
		promptSnippet:
			"web_save(url) — fetch via sift and save to /tmp/sift-web-tools/ for later inspection with read/grep/bash.",
		promptGuidelines: [
			"Use web_save when web_fetch would be too large, when fetching PDFs, or when downloading images/files for later inspection.",
			"After web_save returns a local path, use read with offset/limit, grep, or bash to inspect relevant parts instead of loading the whole file.",
			"After web_save downloads an image, use read on the returned path to view it.",
			"web_save only accepts http(s) URLs; file:// and other schemes are rejected.",
		],
		parameters: WebSaveParams,
		executionMode: "parallel",

		async execute(_toolCallId, params: Static<typeof WebSaveParams>, signal, onUpdate, _ctx) {
			const url = params.url.trim();
			const mode = params.mode ?? "rendered";
			const force = params.force ?? false;

			if (!isLikelyHttpUrl(url)) {
				throw new Error(`web_save rejected non-http(s) URL: ${url}`);
			}

			try {
				await ensureArtifactDir();
				const outPath = await artifactPathFor(url, mode, params.filename, force);
				onUpdate?.({
					content: [{ type: "text", text: `Saving ${url} to ${outPath}...` }],
					details: { url, path: outPath, size: 0, mode, source: "sift", artifact_dir: ARTIFACT_DIR } satisfies SaveDetails,
				});

				const args = ["fetch", url, "--out", outPath, "--timeout", String(SIFT_TIMEOUT_SEC)];
				if (mode === "raw") args.splice(2, 0, "--raw");
				if (force) args.push("--force");

				await siftRun(pi, args, signal);
				const saved = await stat(outPath);
				const kind = await detectSavedKind(outPath);
				const hint = kind.startsWith("image/") || MEDIA_EXTENSIONS.has(extname(outPath).toLowerCase())
					? "Use read on this path to view the downloaded image/media if supported."
					: "Use read with offset/limit, grep, or bash to inspect relevant parts of this file.";
				const text = [
					`Saved ${url}`,
					`Path: ${outPath}`,
					`Size: ${formatSize(saved.size)}`,
					`Mode: ${mode}`,
					`Hint: ${hint}`,
				].join("\n");

				return {
					content: [{ type: "text", text }],
					details: {
						url,
						path: outPath,
						size: saved.size,
						mode,
						source: "sift",
						artifact_dir: ARTIFACT_DIR,
						kind,
					} satisfies SaveDetails,
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				throw new Error(`web_save failed: ${msg}`);
			}
		},

		renderCall(args, theme, _context) {
			const u = typeof args.url === "string" ? args.url : "...";
			const preview = u.length > 80 ? `${u.slice(0, 80)}...` : u;
			const mode = typeof args.mode === "string" ? args.mode : "rendered";
			return new Text(
				theme.fg("toolTitle", theme.bold("web_save ")) +
					theme.fg("accent", preview) +
					theme.fg("muted", ` [${mode}]`),
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme, context) {
			const block = result.content[0];
			const text = block?.type === "text" ? block.text : "(no output)";
			const details = result.details as SaveDetails | undefined;
			const isError = context.isError;

			if (expanded) {
				const container = new Container();
				container.addChild(new Text(isError ? theme.fg("error", "✗ web_save") : theme.fg("success", "✓ web_save"), 0, 0));
				if (details?.url) container.addChild(new Text(theme.fg("muted", details.url), 0, 0));
				if (details?.path) container.addChild(new Text(theme.fg("accent", details.path), 0, 0));
				container.addChild(new Text(text, 0, 0));
				if (details && !isError) {
					const meta = [formatSize(details.size), details.mode, details.kind].filter(Boolean).join(" · ");
					container.addChild(new Text(theme.fg("dim", meta), 0, 0));
				}
				return container;
			}

			if (!isError && details?.path) {
				const meta = `${details.path} · ${formatSize(details.size)} · ${details.mode}`;
				return new Text(`${theme.fg("success", "✓")} ${theme.fg("toolOutput", meta)}`, 0, 0);
			}
			return renderCollapsed(text, isError, theme);
		},
	});

	pi.registerTool({
		name: "web_artifacts",
		label: "Web artifacts",
		description: "List files saved by web_save under /tmp/sift-web-tools/ so the agent can inspect them with read, grep, or bash.",
		promptSnippet: "web_artifacts() — list files saved under /tmp/sift-web-tools/.",
		promptGuidelines: [
			"Use web_artifacts to rediscover local paths created by web_save.",
			"After web_artifacts returns a path, use read with offset/limit, grep, or bash to inspect relevant parts.",
		],
		parameters: WebArtifactsParams,

		async execute(_toolCallId, params: Static<typeof WebArtifactsParams>) {
			const limit = params.limit ?? 50;
			const files = await listArtifacts();
			const returned = files.slice(0, limit);
			return {
				content: [{ type: "text", text: formatArtifactsList(returned, files.length) }],
				details: {
					artifact_dir: ARTIFACT_DIR,
					total: files.length,
					returned: returned.length,
					files: returned,
				} satisfies ArtifactsDetails,
			};
		},

		renderCall(args, theme, _context) {
			const limit = typeof args.limit === "number" ? args.limit : 50;
			return new Text(
				theme.fg("toolTitle", theme.bold("web_artifacts ")) + theme.fg("muted", `[limit=${limit}]`),
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme, context) {
			const block = result.content[0];
			const text = block?.type === "text" ? block.text : "(no output)";
			const details = result.details as ArtifactsDetails | undefined;
			const isError = context.isError;

			if (expanded) {
				const container = new Container();
				container.addChild(new Text(isError ? theme.fg("error", "✗ web_artifacts") : theme.fg("success", "✓ web_artifacts"), 0, 0));
				container.addChild(new Text(theme.fg("muted", ARTIFACT_DIR), 0, 0));
				container.addChild(new Text(text, 0, 0));
				if (details && !isError) {
					container.addChild(new Text(theme.fg("dim", `${details.returned}/${details.total} artifact(s)`), 0, 0));
				}
				return container;
			}

			if (!isError && details) {
				return new Text(`${theme.fg("success", "✓")} ${theme.fg("toolOutput", `${details.total} artifact(s) in ${ARTIFACT_DIR}`)}`, 0, 0);
			}
			return renderCollapsed(text, isError, theme);
		},
	});

	pi.registerTool({
		name: "web_clean",
		label: "Web clean",
		description: "Delete old files saved by web_save under /tmp/sift-web-tools/. By default deletes artifacts older than 1440 minutes; use all=true to delete everything.",
		promptSnippet: "web_clean(older_than_minutes?, all?, dry_run?) — delete old saved web artifacts from /tmp/sift-web-tools/.",
		promptGuidelines: [
			"Use web_clean to remove stale files created by web_save after they are no longer needed.",
			"Use web_clean dry_run=true before deleting artifacts if you need to confirm which files match.",
		],
		parameters: WebCleanParams,
		executionMode: "sequential",

		async execute(_toolCallId, params: Static<typeof WebCleanParams>) {
			const all = params.all ?? false;
			const dryRun = params.dry_run ?? false;
			const olderThanMinutes = params.older_than_minutes ?? 1440;
			const cutoff = Date.now() - olderThanMinutes * 60 * 1000;
			const files = await listArtifacts();
			const matched = files.filter((file) => all || file.modified < cutoff);

			if (!dryRun) {
				await Promise.all(matched.map((file) => unlink(file.path).catch(() => undefined)));
			}

			const action = dryRun ? "Would delete" : "Deleted";
			const scope = all ? "all artifacts" : `artifacts older than ${olderThanMinutes} minute(s)`;
			const shown = matched.slice(0, 50);
			const list = matched.length ? `\n\n${formatArtifactsList(shown, matched.length)}` : "";
			return {
				content: [{ type: "text", text: `${action} ${matched.length} ${scope} from ${ARTIFACT_DIR}.${list}` }],
				details: {
					artifact_dir: ARTIFACT_DIR,
					matched: matched.length,
					deleted: dryRun ? 0 : matched.length,
					dry_run: dryRun,
					files: matched,
				} satisfies CleanDetails,
			};
		},

		renderCall(args, theme, _context) {
			const all = args.all === true;
			const dryRun = args.dry_run === true;
			const age = typeof args.older_than_minutes === "number" ? args.older_than_minutes : 1440;
			const label = all ? "all" : `>${age}m`;
			return new Text(
				theme.fg("toolTitle", theme.bold("web_clean ")) +
					theme.fg("muted", `[${label}${dryRun ? ", dry-run" : ""}]`),
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme, context) {
			const block = result.content[0];
			const text = block?.type === "text" ? block.text : "(no output)";
			const details = result.details as CleanDetails | undefined;
			const isError = context.isError;

			if (expanded) {
				const container = new Container();
				container.addChild(new Text(isError ? theme.fg("error", "✗ web_clean") : theme.fg("success", "✓ web_clean"), 0, 0));
				container.addChild(new Text(text, 0, 0));
				if (details && !isError) {
					const meta = details.dry_run ? `${details.matched} matched · dry run` : `${details.deleted} deleted`;
					container.addChild(new Text(theme.fg("dim", meta), 0, 0));
				}
				return container;
			}

			if (!isError && details) {
				const meta = details.dry_run ? `${details.matched} matched (dry run)` : `${details.deleted} deleted`;
				return new Text(`${theme.fg("success", "✓")} ${theme.fg("toolOutput", meta)}`, 0, 0);
			}
			return renderCollapsed(text, isError, theme);
		},
	});
}
