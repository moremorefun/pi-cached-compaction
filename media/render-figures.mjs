// Renders each <figure> in figures.html to a 2x PNG next to it: node media/render-figures.mjs
// Needs Google Chrome (set CHROME for another path) and network access for the pi.dev fonts.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const source = new URL("figures.html", import.meta.url);
const ids = [...readFileSync(source, "utf8").matchAll(/<figure id="([\w-]+)"/g)].map((match) => match[1]);
// A fresh profile per run: a reused one restores the previous window size and garbles the screenshot.
const run = (args) => {
	const profile = mkdtempSync(join(tmpdir(), "figures-chrome-"));
	try {
		return execFileSync(chrome, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${profile}`, "--virtual-time-budget=10000", ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
	} finally {
		rmSync(profile, { recursive: true, force: true });
	}
};

for (const id of ids) {
	const url = `${source.href}?fig=${id}`;
	const dom = run(["--window-size=960,2000", "--dump-dom", url]);
	const height = dom.match(/data-height="(\d+)"/)?.[1];
	if (!height) throw new Error(`${id}: the fonts didn't load (${dom.match(/data-error="([^"]*)"/)?.[1] ?? "no result"})`);
	const out = fileURLToPath(new URL(`${id}.png`, source));
	run([`--window-size=960,${height}`, "--force-device-scale-factor=2", "--default-background-color=00000000", `--screenshot=${out}`, url]);
	console.log(`${id}.png  960x${height}`);
}
