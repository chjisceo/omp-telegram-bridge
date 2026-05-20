import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import readline from "readline";
import {
	loadConfig,
	saveConfig,
	generatePairingPin,
	clearPairingPin,
} from "./config";
import {
	getActiveSessionLock,
	setActiveSessionLock,
	getLatestSessionFile,
	type SessionLock,
	OMP_SESSIONS_ROOT,
} from "./session";

// 터미널 프롬프트를 위한 유틸리티
function askQuestion(query: string): Promise<string> {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	return new Promise((resolve) =>
		rl.question(query, (ans) => {
			rl.close();
			resolve(ans);
		})
	);
}

async function main() {
	console.log("🚀 **오 마이 파이(OMP) 텔레그램 브릿지 CLI**");

	// 1. 페어링 상태 확인
	let config = await loadConfig();
	if (!config.allowedChatId) {
		const pin = await generatePairingPin();
		console.log("\n🔑 **페어링 인증이 필요합니다!**");
		console.log("스마트폰 텔레그램 봇을 찾은 후 아래 명령어를 입력해 주세요:");
		console.log(`\n👉   /start ${pin}\n`);
		console.log("대기 중... (텔레그램에서 핀코드를 입력하면 자동으로 진행됩니다.)");

		// 페어링 성공 시까지 1초 간격 폴링
		while (true) {
			await new Promise((resolve) => setTimeout(resolve, 1000));
			config = await loadConfig();
			if (config.allowedChatId) {
				console.log("\n🎉 **페어링이 성공적으로 완료되었습니다!**");
				break;
			}
		}
	}

	const cwd = process.cwd();
	let lock = await getActiveSessionLock();

	// 2. 다른 곳에서 텔레그램으로 핸드오프된 상태인지 확인
	if (lock && lock.status === "telegram") {
		console.log("\n📱 **현재 세션이 텔레그램으로 핸드오프되어 실행 중입니다.**");
		const answer = await askQuestion("💻 이 세션을 다시 터미널 TUI로 양도받으시겠습니까? (Y/n): ");
		
		if (answer.toLowerCase() === "n") {
			console.log("텔레그램에서 작업을 계속 수행해 주세요. CLI를 종료합니다.");
			process.exit(0);
		}

		// 제어권을 터미널로 양도
		lock.status = "terminal";
		lock.timestamp = new Date().toISOString();
		await setActiveSessionLock(lock);
		console.log("💻 제어권을 터미널로 복구했습니다.");
	}

	// 3. 실행할 세션 파일 결정
	let sessionPath = lock?.sessionPath || null;

	if (!sessionPath) {
		// 새로 시작하는 경우 디렉토리 내 가장 최신 세션 파일 확인
		sessionPath = await getLatestSessionFile(cwd);
	}

	const ompPath = "/Users/harry/.bun/bin/omp";
	const spawnArgs: string[] = [];

	if (sessionPath && existsSync(sessionPath)) {
		console.log(`🔄 기존 세션을 복원합니다: ${path.basename(sessionPath)}`);
		spawnArgs.push("--resume", sessionPath);
	} else {
		console.log("✨ 새로운 에이전트 세션을 생성합니다.");
	}

	// 기타 CLI 인수 전달 (예: omp-tele "prompt text")
	const userArgs = process.argv.slice(2);
	spawnArgs.push(...userArgs);

	// 4. OMP 터미널 TUI 실행 (자식 프로세스를 raw PTY 모드로 터미널에 완벽 상속)
	console.log("🎮 OMP 인터랙티브 TUI를 시작합니다. 작업을 마치고 터미널을 종료하면 핸드오프를 안내합니다.\n");
	
	const proc = Bun.spawn({
		cmd: [ompPath, ...spawnArgs],
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});

	// 임시 락 정보 갱신
	const sessionId = sessionPath ? path.basename(sessionPath, ".jsonl") : "new-session";
	const activeLock: SessionLock = {
		sessionId: sessionId,
		sessionPath: sessionPath || "",
		status: "terminal",
		cwd: cwd,
		timestamp: new Date().toISOString(),
	};
	await setActiveSessionLock(activeLock);

	// OMP TUI 프로세스 종료 대기
	const exitCode = await proc.exited;

	// OMP가 구동된 후 최신 세션 파일이 새로 생성되었을 수 있으므로 경로 다시 검사
	if (!sessionPath || !existsSync(sessionPath)) {
		sessionPath = await getLatestSessionFile(cwd);
	}

	if (sessionPath) {
		// 5. 종료 시 텔레그램 핸드오프(Handoff) 의사 확인 프롬프트
		console.log("\n------------------------------------------------");
		console.log("🚪 **OMP 터미널 세션이 종료되었습니다.**");
		const handoffAnswer = await askQuestion(
			"📱 이 세션을 텔레그램으로 핸드오프하여 이동 중에도 모바일로 계속 프롬프팅하시겠습니까? (Y/n): "
		);

		if (handoffAnswer.toLowerCase() !== "n") {
			// 텔레그램 상태로 락 저장
			const finalLock: SessionLock = {
				sessionId: path.basename(sessionPath, ".jsonl"),
				sessionPath: sessionPath,
				status: "telegram",
				cwd: cwd,
				timestamp: new Date().toISOString(),
			};
			await setActiveSessionLock(finalLock);
			console.log("\n📱 **세션이 텔레그램으로 성공적으로 핸드오프되었습니다!**");
			console.log("스마트폰 텔레그램 방에서 메시지를 보내 작업을 이어가세요.");
		} else {
			// 핸드오프 안 할 경우 세션 락 클리어
			await setActiveSessionLock(null);
			console.log("\n👋 세션을 안전하게 닫고 종료합니다. (수고하셨습니다!)");
		}
	} else {
		// 세션 기록이 없는 일회성 실행 등
		await setActiveSessionLock(null);
		console.log(`\n👋 세션이 안전하게 종료되었습니다. (Exit Code: ${exitCode})`);
	}

	process.exit(0);
}

main().catch((err) => {
	console.error("CLI 실행 중 예상치 못한 에러 발생:", err);
	process.exit(1);
});
