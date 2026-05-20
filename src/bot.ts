import { Bot, InlineKeyboard } from "grammy";
import {
	getTelegramBotToken,
	loadConfig,
	saveConfig,
	getPairingPin,
	clearPairingPin,
} from "./config";
import {
	getActiveSessionLock,
	setActiveSessionLock,
	getLatestSessionFile,
	type SessionLock,
} from "./session";

// ANSI 이스케이프 시퀀스 제거를 위한 정규식 (Chalk 색상 코드 등 제거)
export const stripAnsi = (str: string) =>
	str.replace(
		/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
		""
	);

let activeProcess: any = null; // 현재 실행 중인 OMP 자식 프로세스 참조

export async function initBot() {
	const token = getTelegramBotToken();
	const bot = new Bot(token);

	// 1. 보안 미들웨어: 페어링된 사용자만 봇과 통신 가능
	bot.use(async (ctx, next) => {
		const config = await loadConfig();
		const chat = ctx.chat;

		if (!chat) return;

		// 최초 페어링 시도인 경우 (/start PIN코드) 허용
		const isPairingAttempt =
			ctx.message?.text?.startsWith("/start ") || false;

		if (config.allowedChatId && config.allowedChatId !== chat.id) {
			// 이미 다른 사용자에게 페어링된 경우 요청 무시
			console.log(`[보안 거부] 미인증 사용자 접속 시도: ${chat.id}`);
			return;
		}

		if (!config.allowedChatId && !isPairingAttempt) {
			// 페어링되지 않은 경우 안내 메시지 출력
			await ctx.reply(
				"⚠️ **오 마이 파이(OMP) 텔레그램 브릿지**\n\n현재 이 봇은 어떤 워크스페이스와도 연동되어 있지 않습니다.\n\n터미널에서 `omp-tele`을 실행하여 발급된 PIN 코드로 페어링을 시작해 주세요.\n예: `/start 1234`"
			);
			return;
		}

		await next();
	});

	// 2. /start 명령어 핸들러 (최초 페어링 및 시작 안내)
	bot.command("start", async (ctx) => {
		const config = await loadConfig();
		const arg = ctx.match?.trim();

		// 최초 페어링 진행
		if (!config.allowedChatId) {
			const expectedPin = await getPairingPin();
			if (expectedPin && arg === expectedPin) {
				await saveConfig({ allowedChatId: ctx.chat.id });
				await clearPairingPin();
				await ctx.reply(
					"🎉 **페어링 성공!**\n\n이제 Telegram interactive 모드로 바로 사용할 수 있습니다.\n현재 세션이 Telegram으로 핸드오프된 상태라면 메시지를 보내 즉시 이어서 작업합니다.\n\n**사용 가능한 명령어:**\n🔹 `/status` - 현재 세션 상태 확인\n🔹 `/stop` - 진행 중인 에이전트 작업 강제 중단\n🔹 `/handback` - 터미널 TUI로 제어권 양도"
				);
			} else {
				await ctx.reply(
					"❌ **페어링 실패**\n\n핀코드가 유효하지 않거나 일치하지 않습니다. 터미널의 `omp-tele` 화면에 표시된 핀코드를 다시 확인한 후 `/start [PIN]` 형태로 보내주세요."
				);
			}
			return;
		}

		// 이미 페어링된 상태인 경우
		const lock = await getActiveSessionLock();
		if (lock) {
			await ctx.reply(
				`👋 **Greetings Operator!**\n\n현재 제어 세션이 준비되어 있습니다.\n\n📂 **CWD:** \`${lock.cwd}\`\n🔄 **상태:** \`${lock.status === "telegram" ? "텔레그램 활성화" : "터미널 대기 중"}\`\n\n메시지를 입력하면 즉시 OMP 에이전트가 실행됩니다.`
			);
		} else {
			await ctx.reply(
				"👋 **Greetings Operator!**\n\n현재 활성화된 세션이 없습니다. 터미널에서 작업을 시작하면 이곳에서 모니터링 및 제어가 가능합니다."
			);
		}
	});

	// 3. /status 명령어 핸들러 (세션 정보 확인)
	bot.command("status", async (ctx) => {
		const lock = await getActiveSessionLock();
		if (!lock) {
			await ctx.reply("📂 **현재 활성화된 에이전트 세션이 없습니다.**");
			return;
		}

		const statusText =
			lock.status === "telegram"
				? "📱 텔레그램 원격 제어 중"
				: "💻 로컬 터미널(TUI) 점유 중";

		await ctx.reply(
			`📊 **OMP 세션 상태**\n\n📂 **경로:** \`${lock.cwd}\`\n🆔 **세션 ID:** \`${lock.sessionId.slice(0, 8)}...\`\n🚦 **제어권:** ${statusText}\n⏰ **최근 동기화:** ${new Date(lock.timestamp).toLocaleTimeString()}`,
			{
				reply_markup: new InlineKeyboard()
					.text("작업 중단 (Stop)", "stop_task")
					.text("터미널로 양도 (Handback)", "handback_task"),
			}
		);
	});

	// 4. /stop 명령어 핸들러 (긴급 작업 강제 종료)
	bot.command("stop", async (ctx) => {
		await handleStop(ctx);
	});

	// 5. /handback 명령어 핸들러 (TUI 복귀)
	bot.command("handback", async (ctx) => {
		await handleHandback(ctx);
	});

	// 6. 인라인 버튼 콜백 쿼리 핸들러
	bot.on("callback_query:data", async (ctx) => {
		const data = ctx.callbackQuery.data;
		if (data === "stop_task") {
			await handleStop(ctx);
		} else if (data === "handback_task") {
			await handleHandback(ctx);
		}
		await ctx.answerCallbackQuery();
	});

	// 7. 일반 텍스트 메시지 수신 핸들러 (에이전트에 프롬프트 전달 및 실시간 스트리밍)
	bot.on("message:text", async (ctx) => {
		const lock = await getActiveSessionLock();

		if (!lock) {
			await ctx.reply(
				"⚠️ 현재 활성화된 세션이 없습니다. 먼저 터미널에서 세션을 생성해 주세요."
			);
			return;
		}

		if (lock.status !== "telegram") {
			await ctx.reply(
				"⚠️ 현재 세션의 제어권이 **터미널(TUI)**에 있습니다. 텔레그램으로 제어하려면 터미널에서 `/handoff`를 수행해 주세요."
			);
			return;
		}

		if (activeProcess) {
			await ctx.reply("⏳ 현재 에이전트가 다른 작업을 수행 중입니다. 정지하려면 `/stop`을 입력해 주세요.");
			return;
		}

		const prompt = `[Telegram] ${ctx.message.text.trim()}`;
		await executeOmpPrompt(ctx, lock, prompt);
	});

	// 에러 핸들러 설정
	bot.catch((err) => {
		console.error("텔레그램 봇 내부 에러 발생:", err);
	});

	// 봇 백그라운드 시작 (롱 폴링)
	bot.start();
	console.log("🤖 텔레그램 봇이 활성화되었습니다. 사용자의 세션을 모니터링할 준비가 완료되었습니다.");
}

// 긴급 작업 중지 비즈니스 로직
async function handleStop(ctx: any) {
	if (activeProcess) {
		try {
			activeProcess.kill("SIGINT"); // Ctrl+C 전송
			activeProcess = null;
			await ctx.reply("🛑 **작업 강제 중단 명령을 전송했습니다. (SIGINT)**");
		} catch (e) {
			await ctx.reply("❌ 작업 중단 중 오류가 발생했습니다.");
		}
	} else {
		// activeProcess가 없더라도 락 정보를 읽어 PID가 있으면 강제 kill 시도
		const lock = await getActiveSessionLock();
		if (lock && (lock as any).pid) {
			try {
				process.kill((lock as any).pid, "SIGINT");
				await ctx.reply("🛑 **로컬 백그라운드 OMP 프로세스에 중단 시그널을 전송했습니다.**");
			} catch (e) {
				await ctx.reply("ℹ️ 실행 중인 백그라운드 작업이 없습니다.");
			}
		} else {
			await ctx.reply("ℹ️ 현재 진행 중인 에이전트 작업이 없습니다.");
		}
	}
}

// 터미널 TUI 복귀 비즈니스 로직
async function handleHandback(ctx: any) {
	const lock = await getActiveSessionLock();
	if (!lock) {
		await ctx.reply("📂 활성화된 세션이 없습니다.");
		return;
	}

	if (lock.status === "terminal") {
		await ctx.reply("💻 제어권이 이미 터미널에 있습니다.");
		return;
	}

	// 락 파일의 상태를 terminal로 변경
	lock.status = "terminal";
	lock.timestamp = new Date().toISOString();
	await setActiveSessionLock(lock);

	await ctx.reply(
		"💻 **제어권이 로컬 터미널로 복구되었습니다!**\n\n작업을 이어서 하려면 본인 PC 터미널에서 `omp-tele`을 다시 실행해 주세요."
	);
}

// OMP 에이전트 비동기 스폰 및 실시간 스트리밍 중계 로직
async function executeOmpPrompt(ctx: any, lock: SessionLock, userPrompt: string) {
	const statusMessage = await ctx.reply("🧠 에이전트 구동 중...");

	// 에이전트의 출력을 담을 버퍼 및 상태 변수
	let outputText = "";
	let lastSentText = "";
	let isFinished = false;
	let currentTelegramMsgId = statusMessage.message_id;

	// OMP 비동기 실행 명령어 구성: omp --resume <sessionPath> --print "<prompt>"
	// 로컬 헬퍼 실행 경로 설정
	const ompPath = "/Users/harry/.bun/bin/omp";

	try {
		// 프로세스 실행 시작 및 PID 락 등록
		const proc = Bun.spawn({
			cmd: [ompPath, "--resume", lock.sessionPath, "--print", userPrompt],
			stdout: "pipe",
			stderr: "pipe",
		});

		activeProcess = proc;

		// 락 파일에 현재 프로세스 PID 기입 (stop 명령 대비)
		const updatedLock = { ...lock, pid: proc.pid } as any;
		await setActiveSessionLock(updatedLock);

		// 1.5초 주기 디바운스 실시간 업데이트 루프
		const updateInterval = setInterval(async () => {
			const displayBuffer = stripAnsi(outputText).trim();

			if (!displayBuffer) return;

			// 내용에 변화가 있는 경우에만 수정 요청
			if (displayBuffer !== lastSentText) {
				lastSentText = displayBuffer;
				const formattedText = `🤖 **Oh My Pi Agent (Streaming)**\n\n\`\`\`\n${displayBuffer.slice(-3500)}\n\`\`\``;

				try {
					await ctx.api.editMessageText(
						ctx.chat.id,
						currentTelegramMsgId,
						formattedText
					);
				} catch (e: any) {
					// 텔레그램 메시지가 너무 커지거나 API 에러 발생 시 처리
					if (e.description?.includes("message is not modified")) return;

					if (e.description?.includes("too long") || outputText.length - lastSentText.length > 3500) {
						// 글자수 한도를 넘은 경우 새 메시지를 발송하여 이어 받기
						try {
							const newMsg = await ctx.reply("🤖 **이어서 스트리밍 중...**");
							currentTelegramMsgId = newMsg.message_id;
							outputText = ""; // 버퍼 비우고 새 메시지에 누적
							lastSentText = "";
						} catch (newMsgErr) {
							// 메시지 발송 오류 대응
						}
					}
				}
			}

			if (isFinished) {
				clearInterval(updateInterval);
			}
		}, 1500);

		// stdout 데이터 파이프 읽기 루프
		const reader = proc.stdout.getReader();
		const decoder = new TextDecoder();

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			outputText += decoder.decode(value);
		}

		// 자식 프로세스 종료 대기
		const exitCode = await proc.exited;
		isFinished = true;
		clearInterval(updateInterval);
		activeProcess = null;

		// 락 파일의 PID 항목 초기화
		const finalLock = await getActiveSessionLock();
		if (finalLock) {
			delete (finalLock as any).pid;
			await setActiveSessionLock(finalLock);
		}

		// 최종 완료 본 전송
		const finalOutput = stripAnsi(outputText).trim();
		const statusEmoji = exitCode === 0 ? "✅" : "⚠️";
		const finalReport = `${statusEmoji} **에이전트 작업 완료 (Exit Code: ${exitCode})**\n\n\`\`\`\n${finalOutput.slice(-3500) || "완료되었으나 출력 로그가 없습니다."}\n\`\`\``;

		await ctx.api.editMessageText(
			ctx.chat.id,
			currentTelegramMsgId,
			finalReport
		);

	} catch (error: any) {
		isFinished = true;
		activeProcess = null;
		await ctx.reply(`❌ **에이전트 실행 실패:**\n${error.message}`);
	}
}
