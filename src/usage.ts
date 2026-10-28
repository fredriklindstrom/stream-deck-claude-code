import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Token usage across every Claude Code transcript on this machine
 *  (`~/.claude/projects/**\/*.jsonl`, subagents included).
 *
 *  Each assistant line carries `message.usage`; we count input + cache
 *  writes + cache reads + output. A message streamed across several lines
 *  (or copied into a resumed session's file) repeats its id, so we keep one
 *  value per `message.id` and bucket it by the local day of its timestamp.
 *  Files are read incrementally: only bytes appended since the last scan. */

export type UsageTotals = { today: number; month: number; total: number };

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const CHUNK = 1024 * 1024;

type Entry = { sum: number; day: string };

const offsets = new Map<string, number>();
const messages = new Map<string, Entry>();
const dayTotals = new Map<string, number>();
let scanning: Promise<UsageTotals> | null = null;

function dayKey(d: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addToDay(day: string, delta: number): void {
	dayTotals.set(day, (dayTotals.get(day) ?? 0) + delta);
}

const USAGE_KEY = Buffer.from('"usage":{');
const ID_RE = /"id":"(msg_[A-Za-z0-9_-]+)"/;
const TS_RE = /"timestamp":"([^"]+)"/;
const usageField = (usage: string, k: string) => Number(new RegExp(`"${k}":(\\d+)`).exec(usage)?.[1] ?? 0);

/** Pull id, timestamp and usage out of one assistant line without parsing
 *  the whole thing: assistant lines can be large (tool inputs, thinking),
 *  and full JSON.parse over 1.6 GB of history is far too slow. Quotes inside
 *  JSON string values are escaped, so these key patterns only match at the
 *  structural level. */
function ingestLine(line: string, usageAt: number): void {
	if (!line.includes('"type":"assistant"')) return;
	const id = ID_RE.exec(line)?.[1];
	const ts = new Date(TS_RE.exec(line)?.[1] ?? "");
	if (!id || Number.isNaN(ts.getTime())) return;
	// The usage object is flat until its nested `cache_creation` / `iterations`
	// parts, and the four counters we need come first.
	const usage = line.slice(usageAt, usageAt + 400);
	const sum =
		usageField(usage, "input_tokens") +
		usageField(usage, "cache_creation_input_tokens") +
		usageField(usage, "cache_read_input_tokens") +
		usageField(usage, "output_tokens");
	const prev = messages.get(id);
	if (prev) addToDay(prev.day, -prev.sum);
	const entry = { sum, day: prev?.day ?? dayKey(ts) };
	messages.set(id, entry);
	addToDay(entry.day, sum);
}

/** Find each line in `buf` that contains a usage block and ingest it. Only
 *  those lines are decoded to strings; tool-result lines are skipped as bytes. */
function ingestBuffer(buf: Buffer): void {
	let pos = buf.indexOf(USAGE_KEY);
	while (pos >= 0) {
		const start = buf.lastIndexOf(0x0a, pos) + 1;
		let end = buf.indexOf(0x0a, pos);
		if (end < 0) end = buf.length;
		const line = buf.subarray(start, end).toString("utf8");
		ingestLine(line, line.indexOf('"usage":{'));
		pos = buf.indexOf(USAGE_KEY, end);
	}
}

async function scanFile(path: string, size: number): Promise<void> {
	let offset = offsets.get(path) ?? 0;
	if (size < offset) offset = 0; // truncated/rewritten: start over (ids dedupe)
	if (size === offset) return;
	const fh = await fs.open(path, "r");
	try {
		// Split on raw newline bytes so a chunk boundary never cuts a
		// multi-byte character in half.
		let carry = Buffer.alloc(0);
		while (offset < size) {
			const chunk = Buffer.alloc(Math.min(CHUNK, size - offset));
			const { bytesRead } = await fh.read(chunk, 0, chunk.length, offset);
			if (bytesRead === 0) break;
			offset += bytesRead;
			const buf = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
			const end = buf.lastIndexOf(0x0a);
			if (end < 0) {
				carry = buf;
				continue;
			}
			ingestBuffer(buf.subarray(0, end));
			carry = buf.subarray(end + 1);
		}
		// Leave a trailing partial line for the next scan.
		offsets.set(path, offset - carry.length);
	} finally {
		await fh.close();
	}
}

async function doScan(): Promise<UsageTotals> {
	let files: string[] = [];
	try {
		files = (await fs.readdir(PROJECTS_DIR, { recursive: true }))
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(PROJECTS_DIR, f));
	} catch {
		/* no projects dir yet */
	}
	for (const path of files) {
		try {
			const { size } = await fs.stat(path);
			await scanFile(path, size);
		} catch {
			/* file vanished mid-scan */
		}
	}
	return totals();
}

export function totals(now = new Date()): UsageTotals {
	const today = dayKey(now);
	const month = today.slice(0, 8);
	let m = 0;
	let t = 0;
	for (const [day, v] of dayTotals) {
		t += v;
		if (day.startsWith(month)) m += v;
	}
	return { today: dayTotals.get(today) ?? 0, month: m, total: t };
}

/** Scan for new transcript bytes. Concurrent callers share one scan. */
export function scanUsage(): Promise<UsageTotals> {
	scanning ??= doScan().finally(() => {
		scanning = null;
	});
	return scanning;
}
