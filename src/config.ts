import os from "os";
import path from "path";
import fs from "fs/promises";
import { existsSync, readFileSync } from "fs";

// 기본 경로 설정: ~/.config/omp-telegram-bridge/
export const CONFIG_DIR = path.join(os.homedir(), ".config", "omp-telegram-bridge");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
export const DAEMON_PID_FILE = path.join(CONFIG_DIR, "daemon.pid");

export interface ConfigData {
	allowedChatId?: number; // 페어링된 텔레그램 고유 Chat ID
	botToken?: string; // 저장된 텔레그램 봇 토큰
	botUsername?: string; // 텔레그램 봇 username (@ 없이 저장)
	botDisplayName?: string; // 텔레그램 봇 표시 이름
	pairingPin?: string; // 페어링용 일회성 PIN
}

let cachedConfig: ConfigData | null = null;

// 설정 디렉토리 및 파일이 존재하지 않는 경우 생성하고 초기화
async function ensureConfigDir() {
	try {
		await fs.mkdir(CONFIG_DIR, { recursive: true });
	} catch (e) {
		// 이미 존재함
	}
}

// 파일에서 설정을 읽어옴 (외부 프로세스 갱신 반영을 위해 항상 디스크 재조회)
export async function loadConfig(): Promise<ConfigData> {
	await ensureConfigDir();
	try {
		const raw = await fs.readFile(CONFIG_FILE, "utf-8");
		cachedConfig = JSON.parse(raw);
		return cachedConfig || {};
	} catch (e) {
		cachedConfig = {};
		return cachedConfig;
	}
}

// 설정을 파일에 비동기로 기록
export async function saveConfig(data: ConfigData): Promise<void> {
	await ensureConfigDir();
	cachedConfig = { ...cachedConfig, ...data };
	await fs.writeFile(CONFIG_FILE, JSON.stringify(cachedConfig, null, 2), "utf-8");
}

// 텔레그램 봇 토큰 로드 (환경 변수 우선, 없으면 config.json fallback)
export function getTelegramBotToken(): string {
	const envToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
	if (envToken) return envToken;

	if (cachedConfig?.botToken?.trim()) {
		return cachedConfig.botToken.trim();
	}

	if (existsSync(CONFIG_FILE)) {
		try {
			const raw = readFileSync(CONFIG_FILE, "utf-8");
			const parsed = JSON.parse(raw) as ConfigData;
			const token = parsed.botToken?.trim();
			if (token) return token;
		} catch {
			// ignore broken config read here; explicit error below
		}
	}

	throw new Error(
		"Telegram bot token이 없습니다. TELEGRAM_BOT_TOKEN 환경변수 또는 /tg-setup으로 토큰을 저장해 주세요."
	);
}

// 4자리 핀코드 생성 및 config.json에 저장
export async function generatePairingPin(): Promise<string> {
	const pin = Math.floor(1000 + Math.random() * 9000).toString();
	await saveConfig({ pairingPin: pin });
	return pin;
}

// 현재 저장된 핀코드 반환
export async function getPairingPin(): Promise<string | null> {
	const config = await loadConfig();
	return config.pairingPin ?? null;
}

// 핀코드 초기화 (페어링 성공 또는 타임아웃 시)
export async function clearPairingPin(): Promise<void> {
	await saveConfig({ pairingPin: undefined });
}
