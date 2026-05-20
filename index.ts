import fs from "fs/promises";
import { CONFIG_DIR, DAEMON_PID_FILE } from "./src/config";
import { initBot } from "./src/bot";

async function writePidFile() {
	await fs.mkdir(CONFIG_DIR, { recursive: true });
	await fs.writeFile(DAEMON_PID_FILE, `${process.pid}\n`, "utf-8");
}

async function removePidFile() {
	try {
		await fs.unlink(DAEMON_PID_FILE);
	} catch {
		// ignore
	}
}

async function main() {
	console.log("🚀 Starting OMP Telegram Bridge Daemon...");
	await writePidFile();

	const shutdown = async () => {
		await removePidFile();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	process.on("exit", () => {
		void removePidFile();
	});

	try {
		await initBot();
	} catch (e: any) {
		console.error("❌ 봇 초기화 실패:", e.message);
		await removePidFile();
		process.exit(1);
	}
}

main().catch(async (err) => {
	console.error("데몬 실행 오류:", err);
	await removePidFile();
	process.exit(1);
});