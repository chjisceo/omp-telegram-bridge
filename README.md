# omp-telegram-bridge

OMP(Oh My Pi) 에이전트를 텔레그램에서 원격 제어하기 위한 브릿지입니다.

## 1) 설치

```bash
bun install
```

## 2) 필수 환경 변수

텔레그램 봇 토큰을 설정해야 합니다.

```bash
export TELEGRAM_BOT_TOKEN="<BOTFATHER_TOKEN>"
```

## 3) 실행 모드

### A. 텔레그램 데몬 실행

```bash
bun run daemon
```

- Grammy 기반 텔레그램 봇을 시작합니다.
- 페어링된 사용자(화이트리스트 chat_id)만 명령을 처리합니다.

### B. 터미널 브릿지 CLI 실행

```bash
bun run cli
```

- 최초 실행 시 PIN(4자리)을 출력합니다.
- 텔레그램에서 `/start <PIN>` 입력 시 페어링이 완료됩니다.
- OMP TUI를 실행하고 종료 시 텔레그램으로 핸드오프할지 묻습니다.

## 4) 텔레그램 명령어

- `/start <PIN>`: 최초 1회 페어링
- `/status`: 현재 세션 상태 확인
- `/stop`: 현재 실행 중인 작업에 SIGINT 전송
- `/handback`: 제어권을 터미널(TUI)로 되돌림

## 5) OMP 내부 `/` 슬래시 명령어

OMP TUI 안에서 바로 사용할 수 있습니다.

- `/tg-setup`: 토큰 저장 + daemon 부팅 + PIN 발급(최초 1회), 현재 세션을 즉시 Telegram interactive 모드로 전환
- `/tg-status`: 브릿지 페어링/핸드오프 상태 조회 + footer 상태 갱신(TG:@bot, daemon, mode)
- `/tg-handoff`: 현재 세션 제어권을 텔레그램으로 넘김
- `/tg-handback`: 현재 세션 제어권을 터미널로 복귀

구현 위치: `.omp/commands/telegram/index.ts`

## 6) 동작 개요

- 세션 본문은 OMP 기본 JSONL 세션 파일(`~/.omp/agent/sessions/.../*.jsonl`)을 사용합니다.
- 브릿지 제어 상태는 `~/.config/omp-telegram-bridge/active_session.json`에 저장됩니다.
- 페어링 정보는 `~/.config/omp-telegram-bridge/config.json`에 저장됩니다.

## 7) 타입체크

```bash
bun x tsc --noEmit
```
