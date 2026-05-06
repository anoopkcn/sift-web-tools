import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { _testing } from "./index.ts";

const {
	parseSiftJson,
	validateSearchJson,
	validateFetchJson,
	truncate,
	isLikelyHttpUrl,
	safeSlug,
	urlPathParts,
	pickArtifactExtension,
	detectSavedKind,
	parseLimitArg,
	parseCleanArgs,
	formatSearchResults,
	formatArtifactLine,
	formatArtifactsList,
} = _testing;

describe("isLikelyHttpUrl", () => {
	it("accepts http and https", () => {
		assert.equal(isLikelyHttpUrl("https://example.com"), true);
		assert.equal(isLikelyHttpUrl("http://example.com/foo"), true);
		assert.equal(isLikelyHttpUrl("HTTPS://example.com"), true);
	});

	it("rejects non-http schemes", () => {
		assert.equal(isLikelyHttpUrl("ftp://example.com"), false);
		assert.equal(isLikelyHttpUrl("file:///etc/passwd"), false);
		assert.equal(isLikelyHttpUrl("javascript:alert(1)"), false);
		assert.equal(isLikelyHttpUrl("data:text/plain,hi"), false);
	});

	it("rejects malformed input", () => {
		assert.equal(isLikelyHttpUrl(""), false);
		assert.equal(isLikelyHttpUrl("not a url"), false);
		assert.equal(isLikelyHttpUrl("example.com"), false);
	});
});

describe("safeSlug", () => {
	it("strips extension and lowercases", () => {
		assert.equal(safeSlug("Hello World.png"), "hello-world");
	});

	it("replaces unsafe chars with dashes", () => {
		assert.equal(safeSlug("foo/bar baz"), "foo-bar-baz");
		assert.equal(safeSlug("a@b#c"), "a-b-c");
	});

	it("falls back when input is empty", () => {
		assert.equal(safeSlug(""), "download");
		assert.equal(safeSlug("", "custom"), "custom");
	});

	it("collapses repeated dots", () => {
		// Trailing `.c` is treated as extension and stripped first.
		assert.equal(safeSlug("a..b...c"), "a.b.");
	});

	it("truncates to 80 chars", () => {
		const long = "a".repeat(120);
		assert.equal(safeSlug(long).length, 80);
	});

	it("trims leading and trailing dashes", () => {
		assert.equal(safeSlug("---foo---"), "foo");
	});
});

describe("urlPathParts", () => {
	it("extracts stem and extension from path", () => {
		assert.deepEqual(urlPathParts("https://example.com/foo/bar.pdf"), { stem: "bar", ext: ".pdf" });
	});

	it("falls back to hostname when path is empty", () => {
		// `extname` on "example.com" returns ".com"; the stem is what's left after safeSlug strips it.
		assert.deepEqual(urlPathParts("https://example.com/"), { stem: "example", ext: ".com" });
	});

	it("returns no extension for extensionless path", () => {
		assert.deepEqual(urlPathParts("https://example.com/page"), { stem: "page", ext: "" });
	});

	it("falls back for malformed URL", () => {
		assert.deepEqual(urlPathParts("not a url"), { stem: "download", ext: "" });
	});
});

describe("pickArtifactExtension", () => {
	it("honors filename extension when valid", () => {
		assert.equal(pickArtifactExtension("", "rendered", ".txt"), ".txt");
		assert.equal(pickArtifactExtension(".png", "raw", ".json"), ".json");
	});

	it("uses url extension for raw mode if safe", () => {
		assert.equal(pickArtifactExtension(".png", "raw", ""), ".png");
		assert.equal(pickArtifactExtension(".pdf", "raw", ""), ".pdf");
	});

	it("falls back to .bin for unsafe raw extensions", () => {
		assert.equal(pickArtifactExtension(".exe", "raw", ""), ".bin");
		assert.equal(pickArtifactExtension("", "raw", ""), ".bin");
	});

	it("preserves media or text extensions in rendered mode", () => {
		assert.equal(pickArtifactExtension(".png", "rendered", ""), ".png");
		assert.equal(pickArtifactExtension(".json", "rendered", ""), ".json");
	});

	it("defaults to .md for HTML in rendered mode", () => {
		assert.equal(pickArtifactExtension(".html", "rendered", ""), ".md");
		assert.equal(pickArtifactExtension("", "rendered", ""), ".md");
	});
});

describe("parseLimitArg", () => {
	it("returns default when no number found", () => {
		assert.equal(parseLimitArg("", 50), 50);
		assert.equal(parseLimitArg("hello", 50), 50);
	});

	it("parses bare numbers", () => {
		assert.equal(parseLimitArg("5", 50), 5);
		assert.equal(parseLimitArg("  10  ", 50), 10);
	});

	it("parses limit=N form", () => {
		assert.equal(parseLimitArg("limit=10", 50), 10);
	});

	it("clamps to [1, 200]", () => {
		assert.equal(parseLimitArg("0", 50), 1);
		assert.equal(parseLimitArg("9999", 50), 200);
	});
});

describe("parseCleanArgs", () => {
	it("returns defaults on empty input", () => {
		assert.deepEqual(parseCleanArgs(""), { older_than_minutes: 1440, all: false, dry_run: false });
	});

	it("recognizes 'all' token", () => {
		assert.equal(parseCleanArgs("all").all, true);
		assert.equal(parseCleanArgs("--all").all, true);
		assert.equal(parseCleanArgs("all=true").all, true);
	});

	it("recognizes dry-run variants", () => {
		assert.equal(parseCleanArgs("dry").dry_run, true);
		assert.equal(parseCleanArgs("dry-run").dry_run, true);
		assert.equal(parseCleanArgs("--dry-run").dry_run, true);
		assert.equal(parseCleanArgs("dry_run=true").dry_run, true);
	});

	it("parses age in multiple forms", () => {
		assert.equal(parseCleanArgs("60").older_than_minutes, 60);
		assert.equal(parseCleanArgs("older=60").older_than_minutes, 60);
		assert.equal(parseCleanArgs("age=60").older_than_minutes, 60);
		assert.equal(parseCleanArgs("older_than_minutes=120").older_than_minutes, 120);
	});

	it("combines flags", () => {
		assert.deepEqual(parseCleanArgs("all dry-run"), { older_than_minutes: 1440, all: true, dry_run: true });
		assert.deepEqual(parseCleanArgs("60 dry-run"), { older_than_minutes: 60, all: false, dry_run: true });
	});
});

describe("truncate", () => {
	it("returns text unchanged when within limit", () => {
		assert.deepEqual(truncate("hello", 10), { text: "hello", truncated: false });
	});

	it("trims and tags when over limit", () => {
		const { text, truncated } = truncate("hello world", 5);
		assert.equal(truncated, true);
		assert.match(text, /^hello/);
		assert.match(text, /\[truncated, full length=11\]/);
	});

	it("handles exact boundary", () => {
		assert.deepEqual(truncate("12345", 5), { text: "12345", truncated: false });
	});
});

describe("formatSearchResults", () => {
	it("returns placeholder for empty results", () => {
		assert.equal(formatSearchResults({ query: "x", results: [] }), "(no results)");
	});

	it("formats numbered list with snippets", () => {
		const out = formatSearchResults({
			query: "x",
			results: [
				{ title: "First", url: "https://a.com", snippet: "snip a" },
				{ title: "Second", url: "https://b.com", snippet: "snip b" },
			],
		});
		assert.match(out, /1\. \[First\]\(https:\/\/a\.com\)\n   snip a/);
		assert.match(out, /2\. \[Second\]\(https:\/\/b\.com\)\n   snip b/);
	});

	it("omits snippet line when empty", () => {
		const out = formatSearchResults({
			query: "x",
			results: [{ title: "T", url: "https://x", snippet: "" }],
		});
		assert.equal(out, "1. [T](https://x)");
	});
});

describe("formatArtifactLine / formatArtifactsList", () => {
	const sampleFile = {
		name: "foo-abc.png",
		path: "/tmp/sift-web-tools/foo-abc.png",
		size: 1024,
		modified: 1700000000000,
		kind: "image/png",
	};

	it("formats a single line with size, kind, and timestamp", () => {
		const out = formatArtifactLine(sampleFile, 0);
		assert.match(out, /^1\. \/tmp\/sift-web-tools\/foo-abc\.png/);
		assert.match(out, /image\/png/);
	});

	it("formats empty list", () => {
		assert.match(formatArtifactsList([], 0), /no artifacts/);
	});

	it("notes remaining count when truncated", () => {
		assert.match(formatArtifactsList([sampleFile], 5), /\[4 more artifact\(s\)/);
	});
});

describe("parseSiftJson + validators", () => {
	it("validateSearchJson accepts well-formed payload", () => {
		const ok = validateSearchJson({ query: "q", results: [{ title: "t", url: "u", snippet: "s" }] });
		assert.equal(ok.query, "q");
		assert.equal(ok.results.length, 1);
	});

	it("validateSearchJson rejects missing fields", () => {
		assert.throws(() => validateSearchJson({}), /query/);
		assert.throws(() => validateSearchJson({ query: "q" }), /results/);
		assert.throws(() => validateSearchJson({ query: "q", results: "nope" }), /results/);
		assert.throws(() => validateSearchJson(null), /object/);
	});

	it("validateFetchJson accepts well-formed payload and copies optionals", () => {
		const ok = validateFetchJson({
			url: "https://x",
			final_url: "https://x/final",
			status: 200,
			kind: "html",
			title: "Title",
			markdown: "# hello",
			fetched_at: 123,
		});
		assert.equal(ok.markdown, "# hello");
		assert.equal(ok.status, 200);
		assert.equal(ok.kind, "html");
		assert.equal(ok.fetched_at, 123);
	});

	it("validateFetchJson rejects missing markdown", () => {
		assert.throws(() => validateFetchJson({ url: "https://x" }), /markdown/);
		assert.throws(() => validateFetchJson({ markdown: 42 }), /markdown/);
	});

	it("parseSiftJson surfaces JSON parse errors", () => {
		assert.throws(() => parseSiftJson("not json", validateSearchJson), /invalid JSON/);
	});

	it("parseSiftJson surfaces schema errors", () => {
		assert.throws(() => parseSiftJson("{}", validateFetchJson), /unexpected schema/);
	});
});

describe("detectSavedKind", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "sift-web-tools-test-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("detects PNG by magic bytes", async () => {
		const path = join(dir, "blob");
		await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
		assert.equal(await detectSavedKind(path), "image/png");
	});

	it("detects JPEG by magic bytes", async () => {
		const path = join(dir, "blob");
		await writeFile(path, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]));
		assert.equal(await detectSavedKind(path), "image/jpeg");
	});

	it("detects GIF89a by magic bytes", async () => {
		const path = join(dir, "blob");
		await writeFile(path, Buffer.from("GIF89a\0\0\0\0", "ascii"));
		assert.equal(await detectSavedKind(path), "image/gif");
	});

	it("detects PDF by magic bytes", async () => {
		const path = join(dir, "blob");
		await writeFile(path, Buffer.from("%PDF-1.4\n", "ascii"));
		assert.equal(await detectSavedKind(path), "pdf");
	});

	it("falls back to MIME for media extension when magic bytes don't match", async () => {
		const path = join(dir, "fake.png");
		await writeFile(path, Buffer.from([0, 0, 0, 0]));
		assert.equal(await detectSavedKind(path), "image/png");
	});

	it("falls back to text-style kind for known text extensions", async () => {
		const path = join(dir, "data.json");
		await writeFile(path, "{}", "utf8");
		assert.equal(await detectSavedKind(path), "json");
	});

	it("returns binary for .bin", async () => {
		const path = join(dir, "blob.bin");
		await writeFile(path, Buffer.from([0, 1, 2, 3]));
		assert.equal(await detectSavedKind(path), "binary");
	});

	it("returns unknown for extensionless garbage", async () => {
		const path = join(dir, "blob");
		await writeFile(path, Buffer.from([0, 1, 2, 3]));
		assert.equal(await detectSavedKind(path), "unknown");
	});
});
