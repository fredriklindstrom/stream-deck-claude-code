import streamDeck, { action, SingletonAction, type KeyDownEvent, type WillAppearEvent } from "@elgato/streamdeck";
import { renderUsage } from "../render.js";
import { scanUsage, totals, type UsageTotals } from "../usage.js";

type Settings = Record<string, never>;

/** Rescan period. Incremental scans only stat files and read appended
 *  bytes (~100ms), so this can be frequent. Also catches day/month rollover. */
const SCAN_MS = 10_000;

@action({ UUID: "com.virtuis.claudecode.usage" })
export class UsageAction extends SingletonAction<Settings> {
	private latest: UsageTotals | undefined;
	private lastImage = "";

	start(): void {
		void this.refresh();
		setInterval(() => void this.refresh(), SCAN_MS);
	}

	override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
		await ev.action.setTitle("");
		await ev.action.setImage(renderUsage(this.latest));
	}

	/** Press = rescan now. */
	override async onKeyDown(_ev: KeyDownEvent<Settings>): Promise<void> {
		await this.refresh();
	}

	private async refresh(): Promise<void> {
		try {
			await scanUsage();
			this.latest = totals();
		} catch (err) {
			streamDeck.logger.warn("usage scan failed", err);
			return;
		}
		const image = renderUsage(this.latest);
		if (image === this.lastImage) return;
		this.lastImage = image;
		await Promise.all([...this.actions].map((a) => a.setImage(image)));
	}
}
