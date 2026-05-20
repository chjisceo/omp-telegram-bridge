import os from "os";
import path from "path";
import fs from "fs/promises";
import { existsSync, statSync } from "fs";

// OMP 기본 에이전트 및 세션 루트 디렉토리
export const OMP_AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".omp", "agent");
export const OMP_SESSIONS_ROOT = path.join(OMP_AGENT_DIR, "sessions");

// 텔레그램 브릿지 설정 폴더 내의 active_session.json 경로
import { CONFIG_DIR } from "./config";
export const ACTIVE_SESSION_LOCK_FILE = path.join(CONFIG_DIR, "active_session.json");

export interface SessionLock {
	sessionId: string;
	sessionPath: string;
	status: "terminal" | "telegram";
	cwd: string;
	timestamp: string;
}

// 1. CWD를 기반으로 OMP 스타일의 인코딩된 세션 디렉토리명 계산
export function getEncodedSessionDirName(cwd: string): string {
	const resolvedCwd = path.resolve(cwd);
	const home = path.resolve(os.homedir());
	const tempRoot = path.resolve(os.tmpdir());

	const isWithin = (parent: string, child: string) => {
		const relative = path.relative(parent, child);
		return !relative.startsWith("..") && !path.isAbsolute(relative);
	};

	if (isWithin(home, resolvedCwd)) {
		const relative = path.relative(home, resolvedCwd).replace(/[/\\:]/g, "-");
		return relative ? `-${relative}` : "-";
	} else if (isWithin(tempRoot, resolvedCwd)) {
		const relative = path.relative(tempRoot, resolvedCwd).replace(/[/\\:]/g, "-");
		return relative ? `-tmp-${relative}` : "-tmp";
	} else {
		// 절대 경로 인코딩
		return `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	}
}

// 2. CWD에 해당하는 OMP 세션 디렉토리의 풀 경로 반환
export function getSessionDir(cwd: string): string {
	const dirName = getEncodedSessionDirName(cwd);
	return path.join(OMP_SESSIONS_ROOT, dirName);
}

// 3. 디렉토리 내의 가장 최신 .jsonl 세션 파일 조회
export async function getLatestSessionFile(cwd: string): Promise<string | null> {
	const sessionDir = getSessionDir(cwd);
	try {
		const files = await fs.readdir(sessionDir);
		const jsonlFiles = files.filter(f => f.endsWith(".jsonl"));
		if (jsonlFiles.length === 0) return null;

		// 가장 최근에 수정된 파일 찾기
		let latestFile: string | null = null;
		let latestMtime = 0;

		for (const file of jsonlFiles) {
			const filePath = path.join(sessionDir, file);
			const stat = await fs.stat(filePath);
			if (stat.mtimeMs > latestMtime) {
				latestMtime = stat.mtimeMs;
				latestFile = filePath;
			}
		}

		return latestFile;
	} catch (e) {
		return null;
	}
}

// 4. 활성화된 세션 락(Active Session Lock) 정보 가져오기
export async function getActiveSessionLock(): Promise<SessionLock | null> {
	try {
		const raw = await fs.readFile(ACTIVE_SESSION_LOCK_FILE, "utf-8");
		return JSON.parse(raw);
	} catch (e) {
		return null;
	}
}

// 5. 활성화된 세션 락 정보 저장하기
export async function setActiveSessionLock(lock: SessionLock | null): Promise<void> {
	if (lock === null) {
		try {
			await fs.unlink(ACTIVE_SESSION_LOCK_FILE);
		} catch (e) {
			// 이미 존재하지 않음
		}
	} else {
		await fs.mkdir(path.dirname(ACTIVE_SESSION_LOCK_FILE), { recursive: true });
		await fs.writeFile(ACTIVE_SESSION_LOCK_FILE, JSON.stringify(lock, null, 2), "utf-8");
	}
}

// 6. JSONL 세션 파일 감시 및 새 줄 파싱 중계 (실시간 테일링)
export function watchSessionFile(
	sessionPath: string,
	onNewLine: (data: any) => void
): { close: () => void } {
	let lastSize = 0;
	let isClosed = false;

	// 초기 파일 크기 읽기
	try {
		const stat = statSync(sessionPath);
		lastSize = stat.size;
	} catch (e) {
		// 파일이 아직 없는 경우 0에서 시작
	}

	const pollInterval = setInterval(async () => {
		if (isClosed) return;
		try {
			const stat = await fs.stat(sessionPath);
			if (stat.size > lastSize) {
				const fd = await fs.open(sessionPath, "r");
				const buffer = Buffer.alloc(stat.size - lastSize);
				await fd.read(buffer, 0, buffer.length, lastSize);
				await fd.close();

				lastSize = stat.size;

				const chunk = buffer.toString("utf-8");
				const lines = chunk.split("\n");
				for (const line of lines) {
					const trimmed = line.trim();
					if (trimmed) {
						try {
							const parsed = JSON.parse(trimmed);
							onNewLine(parsed);
						} catch (e) {
							// 불완전한 라인이거나 빈 경우 무시
						}
					}
				}
			}
		} catch (e) {
			// 파일이 일시적으로 사라졌거나 읽기 에러 발생 시 무시
		}
	}, 300); // 300ms 주기로 폴링

	return {
		close: () => {
			isClosed = true;
			clearInterval(pollInterval);
		},
	};
}
