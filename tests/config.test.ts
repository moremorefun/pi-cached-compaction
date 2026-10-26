import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { autoCompactionEnabled, loadConfig } from "../config.ts";

test("settings: compacting before expiry is on by default, a byte-order mark is allowed, unknown keys fail, and Pi's compaction switch is read project over global", () => {
	const dir = mkdtempSync(join(tmpdir(), "pcc-config-"));
	const settings = join(dir, "settings.json");
	const project = join(dir, "project");
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		assert.equal(loadConfig().compactBeforeExpiry, true);
		assert.equal(loadConfig().thinkingLevel, "medium");
		writeFileSync(settings, JSON.stringify({ cachedCompaction: { thinkingLevel: "minimal" } }));
		assert.throws(loadConfig, /thinkingLevel .* must be "session" or one of low, medium, high, xhigh, max/);
		writeFileSync(settings, String.fromCharCode(0xfeff) + JSON.stringify({ cachedCompaction: { compactBeforeExpiry: false }, compaction: { enabled: false } }));
		assert.equal(loadConfig().compactBeforeExpiry, false);
		assert.equal(autoCompactionEnabled(undefined), false);
		writeFileSync(settings, JSON.stringify({ cachedCompaction: { compactBeforeExpiryy: true } }));
		assert.throws(loadConfig, /unknown keys: compactBeforeExpiryy/);
		assert.equal(autoCompactionEnabled(undefined), true);
		mkdirSync(join(project, ".pi"), { recursive: true });
		writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
		assert.equal(autoCompactionEnabled(project), false);
		writeFileSync(settings, JSON.stringify({ compaction: { enabled: false } }));
		writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ compaction: { enabled: true } }));
		assert.equal(autoCompactionEnabled(project), true);
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(dir, { recursive: true });
	}
});
