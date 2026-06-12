import type { ExecutorSignals } from "./advisor-signals.ts";

type MessageContent = string | Array<{ type?: string; text?: string; [key: string]: unknown }> | unknown;

type AdvisorMessage = {
	role: string;
	content?: MessageContent;
	timestamp?: number;
};

type SessionEntryLike = {
	type?: string;
	message?: AdvisorMessage;
};

type AdvisorStageInfoLike = {
	stage: string;
	reason: string;
};

const MAX_TEXT_LINES = 24;
const MAX_TEXT_CHARS = 1800;

function clampText(text: string, maxLines: number = MAX_TEXT_LINES, maxChars: number = MAX_TEXT_CHARS): string {
	const normalized = text.trim();
	if (!normalized) return normalized;

	const lines = normalized.split("\n");
	let truncated = false;
	let next = lines.slice(0, maxLines).join("\n");
	if (lines.length > maxLines) truncated = true;
	if (next.length > maxChars) {
		next = `${next.slice(0, maxChars).trimEnd()}…`;
		truncated = true;
	}
	if (!truncated) return next;
	return `${next}\n[truncated for advisor context]`;
}

function summarizeUserContent(content: MessageContent): MessageContent {
	if (typeof content === "string") return clampText(content, 40, 2800);
	if (!Array.isArray(content)) return content;
	return content.map((block) => {
		if (block?.type !== "text" || typeof block.text !== "string") return block;
		return { ...block, text: clampText(block.text, 40, 2800) };
	});
}

export function summarizeAssistantContent(content: Array<{ type?: string; text?: string; [key: string]: unknown }>): Array<{ type: "text"; text: string }> {
	return content
		.filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
		.map((block) => ({ ...block, text: clampText(block.text) }));
}

function buildContextPolicy(): string {
	return `Context policy:
- Assistant tool calls are stripped from the transcript below.
- Tool results are not replayed.
- User task framing is retained where possible.
- If truncated: earliest messages omitted, focus on recent evidence.`;
}

function buildSignalsBlock(signals: ExecutorSignals): string {
	const vc = signals.verificationCommands.length > 0
		? signals.verificationCommands.join(", ")
		: "none";
	const rf = signals.recentFailures.length > 0
		? signals.recentFailures.join("; ")
		: "none";
	return `Executor signals:
- Phase: ${signals.phase}
- Mutations: ${signals.mutationsCount}
- Verification commands run: ${vc}
- Recent failures: ${rf}`;
}

function ensureAdvisorRequestClosure(messages: AdvisorMessage[]): AdvisorMessage[] {
	if (messages.length === 0) return messages;
	const last = messages[messages.length - 1];
	if (last.role === "user") return messages;
	return [
		...messages,
		{
			role: "user",
			content: "Provide your advisory assessment now based on the context above.",
			timestamp: Date.now(),
		},
	];
}

export function buildAdvisorMessages(
	branch: SessionEntryLike[],
	stageInfo: AdvisorStageInfoLike,
	recentToolActivity: string,
	maxMessages: number,
	signals?: ExecutorSignals,
): AdvisorMessage[] {
	const transcript: AdvisorMessage[] = [];

	for (const entry of branch) {
		if (entry.type !== "message" || !("message" in entry)) continue;
		const msg = entry.message;
		if (!msg || !("role" in msg)) continue;

		if (msg.role === "user") {
			transcript.push({ ...msg, content: summarizeUserContent(msg.content) });
			continue;
		}

		if (msg.role === "assistant") {
			const content = Array.isArray(msg.content) ? summarizeAssistantContent(msg.content) : [];
			if (content.length > 0) transcript.push({ ...msg, content });
			continue;
		}

		if (msg.role === "toolResult") {
			continue;
		}
	}

	if (transcript.length === 0) return [];

	const contextBlocks: string[] = [buildContextPolicy()];
	contextBlocks.push(`Current advisory stage: ${stageInfo.stage}`);
	contextBlocks.push(`Why this stage: ${stageInfo.reason}`);
	if (signals) contextBlocks.push(buildSignalsBlock(signals));
	contextBlocks.push(recentToolActivity ? `Recent tool activity:\n${recentToolActivity}` : "Recent tool activity: none yet");

	const contextMessage: AdvisorMessage = {
		role: "user",
		content: contextBlocks.join("\n\n"),
		timestamp: Date.now(),
	};

	if (transcript.length <= maxMessages) {
		return ensureAdvisorRequestClosure([contextMessage, ...transcript]);
	}

	const keepFirst = 2;
	const keepLast = maxMessages - keepFirst - 1;
	const omitted = transcript.length - keepFirst - keepLast;
	const omittedMessage: AdvisorMessage = {
		role: "user",
		content: `[${omitted} earlier transcript messages omitted. Focus on the retained task framing and the most recent evidence.]`,
		timestamp: Date.now(),
	};

	return ensureAdvisorRequestClosure([contextMessage, ...transcript.slice(0, keepFirst), omittedMessage, ...transcript.slice(-keepLast)]);
}
